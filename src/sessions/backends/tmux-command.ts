import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { SessionLiveness } from "../types";

/** 可注入的 tmux argv 执行器，供真实后端和故障测试共享。 */
export type TmuxCommandRunner = {
  /** 执行已分词的 tmux 命令；超时必须终止子进程并抛出 ETIMEDOUT。 */
  run(args: readonly string[], timeoutMs: number, stdin?: string): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
};

/** 以指定私有 socket 执行 tmux 命令，永不回退到用户默认 socket。 */
export class TmuxCommandClient {
  constructor(readonly socketPath: string, private readonly runner: TmuxCommandRunner = bunTmuxRunner, private readonly timeoutMs = 3_000) {}

  /** 确保私有 socket 父目录存在，再创建 detached tmux session。 */
  async createSession(sessionName: string, cwd: string, env: Readonly<Record<string, string>>, command: string): Promise<void> {
    await ensurePrivateSocketDirectory(dirname(this.socketPath));
    const args = ["-S", this.socketPath, "new-session", "-d", "-s", sessionName, "-c", cwd];
    for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
    args.push(command);
    const result = await this.runner.run(args, this.timeoutMs);
    if (result.exitCode !== 0) throw new Error(`tmux 创建会话失败：${trimDiagnostic(result.stderr)}`);
  }

  /** 使用私有 tmux buffer 以 bracketed-paste 语义粘贴文本，避免多行内容被解释成连续 Enter。 */
  async pasteText(sessionName: string, bufferName: string, text: string): Promise<void> {
    const loaded = await this.runner.run(["-S", this.socketPath, "load-buffer", "-b", bufferName, "-"], this.timeoutMs, text);
    if (loaded.exitCode !== 0) throw new Error(`tmux 写入 buffer 失败：${trimDiagnostic(loaded.stderr)}`);
    const pasted = await this.runner.run(["-S", this.socketPath, "paste-buffer", "-d", "-p", "-b", bufferName, "-t", sessionName], this.timeoutMs);
    if (pasted.exitCode !== 0) throw new Error(`tmux 粘贴文本失败：${trimDiagnostic(pasted.stderr)}`);
  }

  /** 向私有会话发送一个受控特殊键，不能传入任务正文。 */
  async sendSpecialKey(sessionName: string, key: "Enter"): Promise<void> {
    const result = await this.runner.run(["-S", this.socketPath, "send-keys", "-t", sessionName, key], this.timeoutMs);
    if (result.exitCode !== 0) throw new Error(`tmux 发送特殊键失败：${trimDiagnostic(result.stderr)}`);
  }

  /** 写入浏览器终端产生的原始按键字节；调用方必须先完成会话 identity 核验。 */
  async sendRawText(sessionName: string, text: string): Promise<void> {
    const result = await this.runner.run(["-S", this.socketPath, "send-keys", "-l", "-t", sessionName, text], this.timeoutMs);
    if (result.exitCode !== 0) throw new Error(`tmux 写入终端按键失败：${trimDiagnostic(result.stderr)}`);
  }

  /** 捕获会话近期屏幕内容，仅供诊断。 */
  async capture(sessionName: string, lines: number): Promise<string> {
    const result = await this.runner.run(["-S", this.socketPath, "capture-pane", "-p", "-t", sessionName, "-S", `-${lines}`], this.timeoutMs);
    if (result.exitCode !== 0) throw new Error(`tmux 读取屏幕失败：${trimDiagnostic(result.stderr)}`);
    return result.stdout;
  }

  /** 捕获带 ANSI 转义序列的有限 scrollback，供 Web Terminal 复现真实 TUI 画面。 */
  async captureAnsi(sessionName: string, lines: number): Promise<string> {
    const result = await this.runner.run(["-S", this.socketPath, "capture-pane", "-e", "-p", "-t", sessionName, "-S", `-${lines}`], this.timeoutMs);
    if (result.exitCode !== 0) throw new Error(`tmux 读取 ANSI 屏幕失败：${trimDiagnostic(result.stderr)}`);
    return result.stdout;
  }

  /** 读取 tmux 当前 pane 光标；失败返回 null，调用方仍可安全显示首屏。 */
  async cursor(sessionName: string): Promise<{ readonly x: number; readonly y: number } | null> {
    try {
      const result = await this.runner.run(["-S", this.socketPath, "display-message", "-p", "-t", sessionName, "#{cursor_x} #{cursor_y}"], this.timeoutMs);
      const [x, y] = result.stdout.trim().split(/\s+/).map(Number);
      return result.exitCode === 0 && Number.isInteger(x) && x >= 0 && Number.isInteger(y) && y >= 0 ? { x, y } : null;
    } catch { return null; }
  }

  /** 明确区分会话存在、缺失和 tmux 控制面无结论。 */
  async liveness(sessionName: string): Promise<SessionLiveness> {
    try {
      const result = await this.runner.run(["-S", this.socketPath, "has-session", "-t", sessionName], this.timeoutMs);
      if (result.exitCode === 0) return "exists";
      const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase();
      return diagnostic.includes("can't find session") || diagnostic.includes("no server running") || diagnostic.includes("no sessions") ? "missing" : "unknown";
    } catch { return "unknown"; }
  }

  /** 从会话环境读取一个身份标记。 */
  async environment(sessionName: string, name: string): Promise<string | null> {
    try {
      const result = await this.runner.run(["-S", this.socketPath, "show-environment", "-t", sessionName, name], this.timeoutMs);
      if (result.exitCode !== 0) return null;
      const prefix = `${name}=`;
      const line = result.stdout.trim();
      return line.startsWith(prefix) ? line.slice(prefix.length) : null;
    } catch { return null; }
  }

  /** 向会话发送受控 Ctrl-C。 */
  async interrupt(sessionName: string): Promise<void> {
    const result = await this.runner.run(["-S", this.socketPath, "send-keys", "-t", sessionName, "C-c"], this.timeoutMs);
    if (result.exitCode !== 0) throw new Error(`tmux 发送中断失败：${trimDiagnostic(result.stderr)}`);
  }

  /** 终止指定私有 socket 中的会话。 */
  async killSession(sessionName: string): Promise<void> {
    const result = await this.runner.run(["-S", this.socketPath, "kill-session", "-t", sessionName], this.timeoutMs);
    if (result.exitCode !== 0) throw new Error(`tmux 终止会话失败：${trimDiagnostic(result.stderr)}`);
  }

  /** 关闭整个私有 tmux server；只能由拥有该 daemon/socket 生命周期的调用方使用。 */
  async closePrivateServer(): Promise<void> {
    try {
      const result = await this.runner.run(["-S", this.socketPath, "kill-server"], this.timeoutMs);
      const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (result.exitCode !== 0 && !diagnostic.includes("no server running") && !diagnostic.includes("error connecting")) {
        throw new Error(`tmux 关闭私有 server 失败：${trimDiagnostic(result.stderr)}`);
      }
    } catch (error) {
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") throw error;
    }
    try { await unlink(this.socketPath); } catch (error) {
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") throw error;
    }
  }
}

/** 生成 tmux Unix socket 的短路径，避免 macOS / Unix socket 路径长度限制。 */
export function privateTmuxSocketPath(runtimeRoot: string, daemonInstanceId: string): string {
  const digest = createHash("sha256").update(`${runtimeRoot}\0${daemonInstanceId}`).digest("hex").slice(0, 16);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR || join(tmpdir(), `wave-flow-tmux-${uid}`);
  return join(runtimeDirectory, "wave-flow", `wf-${digest}.sock`);
}

async function ensurePrivateSocketDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("tmux 私有 socket 目录必须是真实目录。");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("tmux 私有 socket 目录不属于当前用户。");
  await chmod(directory, 0o700);
}

function trimDiagnostic(value: string): string { return value.trim().slice(0, 300) || "无诊断输出"; }

const bunTmuxRunner: TmuxCommandRunner = {
  async run(args, timeoutMs, stdin) {
    const process = Bun.spawn(["tmux", ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (stdin !== undefined) {
      if (!process.stdin) throw new Error("tmux stdin pipe 不可用。");
      process.stdin.write(stdin);
      process.stdin.end();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitCode = await Promise.race([
        process.exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("tmux timeout"), { code: "ETIMEDOUT" })), timeoutMs); }),
      ]);
      return { exitCode, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() };
    } catch (error) {
      process.kill();
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  },
};
