import { createReadStream, promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { SessionIdentity } from "./types";
import { TmuxCommandClient } from "./backends/tmux-command";

/** Web Terminal 首屏与实时输出的受控 Session Host 实现；不解释终端业务文本。 */
export class TmuxTerminalObserver {
  #stream: ReturnType<typeof createReadStream> | null = null;
  #fifoPath: string | null = null;
  #listeners = new Set<(data: string) => void>();
  #closeListeners = new Set<() => void>();
  #closed = false;
  #sequence = 0;
  #recent: Array<{ readonly sequence: number; readonly data: string }> = [];
  /** FIFO chunk 不保证 UTF-8 字符边界；与 Botmux 一样保留尾部不完整字节。 */
  readonly #decoder = new StringDecoder("utf8");

  constructor(private readonly identity: SessionIdentity, private readonly client = new TmuxCommandClient(identity.backendRef)) {}

  /** 读取 ANSI 首屏，按 Botmux 路径修正 tmux 裸换行并恢复当前光标。 */
  async initialScreen(lines = 2_000): Promise<{ readonly screen: string; readonly sequence: number; readonly cols: number; readonly rows: number }> {
    await this.requireLive();
    const [screen, cursor, dimensions] = await Promise.all([this.client.captureAnsi(this.identity.sessionName, Math.max(1, Math.min(lines, 10_000))), this.client.cursor(this.identity.sessionName), this.client.dimensions(this.identity.sessionName)]);
    if (!dimensions) throw new Error("tmux pane 尺寸无法安全读取。");
    const normalised = screen.replace(/\r?\n/g, "\r\n").replace(/\r\n$/, "");
    return { screen: cursor ? `${normalised}\x1b[${cursor.y + 1};${cursor.x + 1}H` : normalised, sequence: this.#sequence, ...dimensions };
  }

  /** 开始 pipe-pane 订阅；同一 observer 只创建一条 tmux 输出管道。 */
  async start(): Promise<void> {
    if (this.#closed) throw new Error("终端观察器已关闭。");
    if (this.#stream) return;
    await this.requireLive();
    const directory = join(tmpdir(), "wave-flow-terminal");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const fifoPath = join(directory, `wf-terminal-${crypto.randomUUID()}.fifo`);
    const made = Bun.spawn(["mkfifo", "-m", "600", fifoPath], { stdout: "ignore", stderr: "pipe" });
    if (await made.exited !== 0) throw new Error(`创建终端输出管道失败：${(await new Response(made.stderr).text()).trim()}`);
    // FIFO 的 reader 在没有 writer 时会阻塞 open；先让 tmux 安装 pipe-pane，
    // 其 cat writer 随后与 reader 配对。不能把普通文件“先 open reader”的顺序套进来。
    try {
      const command = `cat > '${fifoPath.replaceAll("'", "'\\''")}'`;
      const piped = Bun.spawn(["tmux", "-S", this.identity.backendRef, "pipe-pane", "-O", "-t", this.identity.sessionName, command], { stdout: "ignore", stderr: "pipe" });
      if (await piped.exited !== 0) throw new Error(`tmux 启动终端输出订阅失败：${(await new Response(piped.stderr).text()).trim()}`);
    } catch (error) {
      await fs.unlink(fifoPath).catch(() => {}); throw error;
    }
    const stream = createReadStream(fifoPath);
    this.#fifoPath = fifoPath;
    this.#stream = stream;
    stream.on("data", (chunk: Buffer) => {
      this.publish(this.#decoder.write(chunk));
    });
    stream.on("end", () => { const tail = this.#decoder.end(); if (tail) this.publish(tail); void this.close(); });
    stream.on("error", () => this.close().catch(() => {}));
  }

  subscribe(listener: (data: string) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  /** WebSocket 升级与每次输入前均可调用，确保旧 observer 不会绕过 identity 复核。 */
  async verify(): Promise<void> { await this.requireLive(); }

  /** 底层 pipe-pane/FIFO 异常关闭时通知 daemon 关闭对应浏览器通道。 */
  onClose(listener: () => void): () => void { this.#closeListeners.add(listener); return () => this.#closeListeners.delete(listener); }

  /** 补发首屏截取之后、WebSocket 建立之前的输出，防止连接竞态丢字节。 */
  replayAfter(sequence: number): readonly string[] { return this.#recent.filter((item) => item.sequence > sequence).map((item) => item.data); }

  private publish(data: string): void {
    if (!data) return;
    const sequence = ++this.#sequence;
    this.#recent.push({ sequence, data });
    while (this.#recent.length > 256 || this.#recent.reduce((size, item) => size + item.data.length, 0) > 256 * 1024) this.#recent.shift();
    for (const listener of this.#listeners) listener(data);
  }

  /** 浏览器输入只作为终端文本写入已重新核验的私有 tmux 会话。 */
  async input(data: string): Promise<void> {
    if (typeof data !== "string" || data.length === 0 || data.length > 64 * 1024) throw new Error("终端输入无效或过大。");
    await this.requireLive();
    // xterm 的 Enter 为 CR；与普通 Web 表单不同，必须映射成 tmux 的真实 Enter，
    // 其余字符（包括方向键 ESC 序列）以 literal 按键字节送入 pane。
    for (const part of data.split(/(\r|\n)/)) {
      if (!part) continue;
      if (part === "\r" || part === "\n") await this.client.sendSpecialKey(this.identity.sessionName, "Enter");
      else await this.client.sendRawText(this.identity.sessionName, part);
    }
  }

  /** 浏览器请求的尺寸只作用于受管 tmux viewer；不会改变业务状态或创建新回合。 */
  async resize(cols: number, rows: number): Promise<{ readonly cols: number; readonly rows: number }> {
    await this.requireLive();
    return this.client.resize(this.identity.sessionName, cols, rows);
  }

  /** 取消 pipe-pane 观察；不会停止 pane、Codex 或 Run。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
    this.#stream?.destroy(); this.#stream = null;
    try { await this.requireLive().then(async () => {
      const stopped = Bun.spawn(["tmux", "-S", this.identity.backendRef, "pipe-pane", "-t", this.identity.sessionName], { stdout: "ignore", stderr: "ignore" });
      await stopped.exited;
    }).catch(() => {}); } finally { if (this.#fifoPath) await fs.unlink(this.#fifoPath).catch(() => {}); this.#fifoPath = null; }
  }

  /** 与 SessionBackend 同样核对注入身份；存在同名 tmux session 不能成为观察授权。 */
  private async requireLive(): Promise<void> {
    if (await this.client.liveness(this.identity.sessionName) !== "exists") throw new Error("tmux 会话不可安全使用。");
    const values = await Promise.all([
      this.client.environment(this.identity.sessionName, "WF_BACKEND"),
      this.client.environment(this.identity.sessionName, "WF_RUN_ID"),
      this.client.environment(this.identity.sessionName, "WF_NODE_ID"),
      this.client.environment(this.identity.sessionName, "WF_AGENT_SESSION_ID"),
      this.client.environment(this.identity.sessionName, "WF_CLI"),
      this.client.environment(this.identity.sessionName, "WF_RECLAIM_TOKEN_HASH"),
    ]);
    const matches = values[0] === "tmux" && values[1] === this.identity.runId && values[2] === this.identity.nodeId
      && values[3] === this.identity.agentSessionId && values[4] === this.identity.cli
      && (this.identity.reclaimTokenHash === undefined || values[5] === this.identity.reclaimTokenHash);
    if (!matches) throw new Error("tmux 会话不可安全使用。");
  }
}
