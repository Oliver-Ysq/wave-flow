import { delimiter } from "node:path";
import { verifyExecutable } from "./identity";
import { systemCliInstallDirectories, versionManagerBinDirectories } from "./install-dirs";
import type { DiscoveredCliCandidate, RuntimeCli } from "./types";

/** 受控 shell discovery 的可替换执行器；测试无需启动真实 login shell。 */
export type ShellPathCommand = (shell: string, signal: AbortSignal) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

/** 只扫描用户明确触发的 PATH，绝不把完整 shell 环境返回或持久化。 */
export class ShellPathDiscovery {
  constructor(
    private readonly execute: ShellPathCommand = runShellPathCommand,
    private readonly guiPath: string | undefined = process.env.PATH,
    /** 兜底安装目录；测试注入固定列表，生产用本机常见安装目录 + nvm 版本目录。 */
    private readonly installDirectories: () => Promise<readonly string[]> = defaultInstallDirectories,
  ) {}

  async discover(): Promise<readonly DiscoveredCliCandidate[]> {
    if (process.platform === "win32") throw new Error("当前版本仅支持 macOS/Linux 的本机 CLI 扫描。 ");
    const discovered: Array<{ path: string; source: DiscoverySource; shell: string | null; cli: RuntimeCli }> = [];
    const shells = await candidateShells();
    for (const shell of shells) {
      try {
        // 10 秒预算：加载 nvm/rvm/conda/gcloud 的 bash -ilc 在空闲时约 1 秒、
        // 负载下可达 6-7 秒（Orca 对同一探针的实测结论）。预算过短会静默退回
        // GUI PATH，表现为“终端里有的 CLI 扫不到”。
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
        const result = await this.execute(shell, controller.signal); clearTimeout(timer);
        const extracted = extractPath(result.stdout);
        if (result.exitCode === 0 && extracted) discovered.push(...candidatePaths(extracted, "shell-path", shell));
        if (result.exitCode === 0) break;
      } catch { /* fallback to the next fixed shell; diagnostics remain intentionally non-sensitive. */ }
    }
    if (this.guiPath) discovered.push(...candidatePaths(this.guiPath, "gui-path", null));
    const merged = await mergeCandidates(discovered);
    return this.withInstallDirFallback(merged);
  }

  /**
   * PATH 完全找不到某个 CLI 时，再按常见安装目录兜底。
   * 语义移植自 Orca `detectCommandsInInstallDirs`（src/shared/local-agent-install-dir-detection.ts）：
   * 只补缺失的 CLI，不改变已有候选顺序，也不把系统目录抬到用户 PATH 前面。
   */
  private async withInstallDirFallback(candidates: ReadonlyMap<string, DiscoveredCliCandidate>): Promise<readonly DiscoveredCliCandidate[]> {
    const present = new Set([...candidates.values()].map((item) => item.cli));
    const missing = (["codex", "kimi"] as const).filter((cli) => !present.has(cli));
    if (missing.length === 0) return [...candidates.values()];
    const directories = await this.installDirectories();
    return [...(await mergeCandidates(directories.flatMap((directory) => missing.map((cli) => ({ path: `${directory.replace(/\/$/, "")}/${cli}`, source: "install-dir" as const, shell: null, cli }))), candidates)).values()];
  }
}

/** 生产兜底目录：常见安装位置在前，nvm 版本目录附后。 */
async function defaultInstallDirectories(): Promise<readonly string[]> {
  const home = process.env.HOME ?? "";
  return [...systemCliInstallDirectories(process.platform, home), ...(home ? await versionManagerBinDirectories(home) : [])];
}

/** 内部候选来源；`install-dir` 只出现在 PATH 缺失后的兜底路径。 */
type DiscoverySource = "shell-path" | "gui-path" | "install-dir";

async function candidateShells(): Promise<readonly string[]> {
  const configured = process.env.SHELL?.startsWith("/") ? process.env.SHELL : null;
  const values = [configured, "/bin/zsh", "/bin/bash"].filter((item): item is string => !!item);
  const unique: string[] = [];
  for (const value of values) { if (!unique.includes(value)) unique.push(value); }
  return unique;
}

/** argv、脚本与环境均固定；不包含来自网页、模型或 Workflow 的文本。 */
async function runShellPathCommand(shell: string, signal: AbortSignal): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  const marker = `__WAVE_FLOW_PATH_${crypto.randomUUID()}__`;
  const child = Bun.spawn([shell, "-ilc", `printf '%s\\n' '${marker}'; command env; printf '%s\\n' '${marker}'`], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", SHELL: shell, DISABLE_AUTO_UPDATE: "true" },
  });
  const abort = () => child.kill(); signal.addEventListener("abort", abort, { once: true });
  const [stdout, stderr, exitCode] = await Promise.all([readLimited(child.stdout, 128_000), readLimited(child.stderr, 32_000), child.exited]);
  signal.removeEventListener("abort", abort);
  if (signal.aborted) throw new Error("本机 CLI 扫描超时。 ");
  // 固定命令本身已经输出一对随机 marker；不得再次包裹，否则第一个 marker 后
  // 紧接第二个 marker，extractPath 会看不到真实 `PATH=` 行。
  return { stdout, stderr, exitCode };
}

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > limit) { reader.cancel(); throw new Error("扫描输出过大。 "); } chunks.push(item.value); }
  return new TextDecoder().decode(concat(chunks, size));
}
function concat(chunks: readonly Uint8Array[], size: number): Uint8Array { const value = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; } return value; }

/** 仅取随机 marker 中间、经 ANSI 清理后的唯一 PATH 行。 */
export function extractPath(output: string): string | null {
  const clean = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""); const lines = clean.split(/\r?\n/);
  const markers = lines.map((line, index) => line.startsWith("__WAVE_FLOW_PATH_") ? index : -1).filter(index => index >= 0);
  if (markers.length < 2) return null;
  for (const line of lines.slice(markers[0] + 1, markers.at(-1))) if (line.startsWith("PATH=")) return line.slice(5) || null;
  return null;
}

function candidatePaths(pathValue: string, source: DiscoverySource, shell: string | null): Array<{ path: string; source: DiscoverySource; shell: string | null; cli: RuntimeCli }> {
  return pathValue.split(delimiter).filter(Boolean).flatMap(directory => (["codex", "kimi"] as const).map(cli => ({ path: `${directory.replace(/\/$/, "")}/${cli}`, source, shell, cli }))).filter(item => item.path.startsWith("/"));
}

async function mergeCandidates(items: readonly { path: string; source: DiscoverySource; shell: string | null; cli: RuntimeCli }[], seed: ReadonlyMap<string, DiscoveredCliCandidate> = new Map()): Promise<Map<string, DiscoveredCliCandidate>> {
  const result = new Map(seed);
  for (const item of items) {
    try {
      const verified = await verifyExecutable(item.path); const canonical = verified.executablePath;
      // realpath 目标可能不再以 codex/kimi 结尾；以 canonical basename 优先判定种类。
      const name = canonical.slice(canonical.lastIndexOf("/") + 1);
      const cli: RuntimeCli = name === "codex" || name === "kimi" ? name : item.cli;
      const key = `${cli}\0${canonical}`;
      const existing = result.get(key);
      const aliases = [...new Set([...(existing?.aliases ?? []), item.path])];
      result.set(key, existing ? { ...existing, aliases } : { cli, executablePath: canonical, discoveredFrom: item.source, discoveredShell: item.shell, aliases });
    } catch { /* PATH entries are only candidates; absence/non-executable is normal. */ }
  }
  return result;
}
