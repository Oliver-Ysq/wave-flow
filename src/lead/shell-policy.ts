import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** 主控可调用的、只读的结构化项目查询；command/args 从不交给 shell 解释。 */
export type ReadOnlyProjectQuery = {
  /** 固定白名单命令；不接受任意二进制路径。 */
  readonly command: "pwd" | "git" | "rg" | "ls";
  /** 命令参数必须通过精确白名单校验；不能包含重定向、管道或写操作。 */
  readonly args: readonly string[];
};

/** 读取单个项目文件的受控输入；path 必须位于 Lead cwd。 */
export type ReadProjectFile = { readonly path: string; readonly startLine?: number; readonly endLine?: number };

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ARGUMENTS = 12;

/**
 * 只执行已批准的查询命令。它永不调用 shell，且在 spawn 前验证 cwd、命令、参数与超时；
 * 因此 prompt 无法把写操作或解释器语法升级为系统权限。
 */
export async function executeReadOnlyProjectQuery(cwd: string, query: ReadOnlyProjectQuery, signal?: AbortSignal): Promise<string> {
  const root = await projectRoot(cwd);
  validateQuery(query);
  // rg 是可选加速器而不是产品依赖：本机没装时必须给出可执行诊断，
  // 不能让 spawn 抛出底层 ENOENT 把“没装工具”伪装成查询失败。
  ensureQueryCommandAvailable(query.command);
  const child = Bun.spawn([query.command, ...query.args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: safeEnvironment(query.command) });
  const timeout = setTimeout(() => child.kill(), 8_000);
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([readLimited(child.stdout), readLimited(child.stderr), child.exited]);
    if (signal?.aborted) throw new Error("主控只读查询已取消。 ");
    if (exitCode !== 0 && exitCode !== 1) throw new Error(`只读查询失败（${query.command} exit ${exitCode}）：${stderr || stdout || "无诊断"}`);
    return clip(stdout || stderr || "（无输出）");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/** 在 cwd 内读取常规文件的受控片段；拒绝软链接、目录、绝对逃逸和过大文件。 */
export async function readProjectFile(cwd: string, request: ReadProjectFile): Promise<string> {
  const root = await projectRoot(cwd);
  if (!request.path.trim() || isAbsolute(request.path)) throw new Error("主控只读文件路径必须是 cwd 内的相对路径。 ");
  const candidate = resolve(root, request.path);
  if (!within(root, candidate)) throw new Error("主控只读文件路径超出项目目录。 ");
  const actual = await realpath(candidate).catch(() => { throw new Error("主控只读文件不存在或不可读取。 "); });
  if (!within(root, actual)) throw new Error("主控只读文件链接逃出项目目录。 ");
  // 先解析目标、再打开同一个 inode，并通过 handle 的 fstat 限制类型/大小，避免
  // 在 realpath/lstat/readFile 三步之间被替换为项目外文件的 TOCTOU 窗口。
  const handle = await open(actual, "r");
  let text: string;
  try {
    const info = await handle.stat();
    // `open()` 会跟随软链接；因此必须在打开后再比对 pathname 当前 inode。若
    // realpath/open 之间被替换成软链接或另一个文件，直接拒绝而不读取 fd 内容。
    const current = await lstat(actual);
    if (!info.isFile() || !current.isFile() || current.isSymbolicLink()) throw new Error("主控只能读取项目内的常规文件。 ");
    if (current.dev !== info.dev || current.ino !== info.ino) throw new Error("主控只读文件在校验期间发生变化。 ");
    if (info.size > MAX_FILE_BYTES) throw new Error(`主控拒绝读取超过 ${MAX_FILE_BYTES} 字节的文件。 `);
    text = await handle.readFile({ encoding: "utf8" });
  } finally { await handle.close(); }
  const start = request.startLine ?? 1;
  const end = request.endLine ?? Math.min(start + 399, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 999) throw new Error("主控文件行范围无效或过大。 ");
  return text.split("\n").slice(start - 1, end).map((line, index) => `${String(start + index).padStart(5, " ")}  ${line}`).join("\n") || "（空文件或范围无内容）";
}

function validateQuery(query: ReadOnlyProjectQuery): void {
  if (!query || !Array.isArray(query.args) || query.args.length > MAX_ARGUMENTS || query.args.some(arg => typeof arg !== "string" || arg.length > 512 || /[\r\n\0]/.test(arg))) throw new Error("主控只读查询参数无效。 ");
  if (query.command === "pwd" && query.args.length === 0) return;
  if (query.command === "git" && isSafeGit(query.args)) return;
  if (query.command === "rg" && isSafeRg(query.args)) return;
  if (query.command === "ls" && isSafeLs(query.args)) return;
  throw new Error("该命令不在主控只读白名单中。 ");
}

function isSafeGit(args: readonly string[]): boolean {
  const joined = args.join(" ");
  return [
    "status --short", "status --short --branch",
    "branch --show-current", "log --oneline -n 20", "log --oneline -n 10", "rev-parse --show-toplevel", "rev-parse --is-inside-work-tree",
  ].includes(joined);
}

function isSafeRg(args: readonly string[]): boolean {
  if (args[0] === "--files") return args.length === 1;
  // 仅正文搜索；明确拒绝 --replace、--pre、--files-from 等可扩大行为或来源的 flag。
  const allowedFlags = new Set(["-n", "-i", "--glob"]);
  let seenPattern = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--glob") { if (!args[++index]) return false; continue; }
    if (allowedFlags.has(value)) continue;
    if (value.startsWith("-")) return false;
    if (!seenPattern) { seenPattern = true; continue; }
    // 受控查询不接受显式路径，避免项目内软链接作为 rg 的输入逃出 cwd。
    return false;
  }
  return seenPattern;
}

function isSafeLs(args: readonly string[]): boolean { return args.length <= 2 && args.every(arg => arg === "-la" || arg === "-l" || arg === "."); }

/**
 * 查询命令是否可用（只看命令名，不接受路径）。
 *
 * `rg`（ripgrep）是**可选加速器**，不是产品依赖：只有本机已安装时才提供全文搜索。
 * 宿主不自动下载、安装或随包分发二进制；缺失时调用方必须能看到明确的不可用原因，
 * 并退回读取文件或 CLI 原生搜索，而不是把缺失伪装成一次查询失败。
 */
function readOnlyQueryCommandAvailable(command: ReadOnlyProjectQuery["command"]): boolean {
  return Bun.which(command, { PATH: safeEnvironment(command).PATH }) !== null;
}

function ensureQueryCommandAvailable(command: ReadOnlyProjectQuery["command"]): void {
  if (readOnlyQueryCommandAvailable(command)) return;
  if (command === "rg") throw new Error("主控全文搜索需要 ripgrep（rg），但本机未安装；请改用读取文件或 CLI 原生搜索，安装 rg 后重试即可恢复。 ");
  throw new Error(`主控只读查询所需的 ${command} 在本机不可用。 `);
}
async function projectRoot(cwd: string): Promise<string> { const root = await realpath(cwd).catch(() => { throw new Error("Lead cwd 不可验证。 "); }); const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Lead cwd 必须是常规目录。 "); return root; }
function within(root: string, value: string): boolean { const fromRoot = relative(root, value); return !fromRoot.startsWith("..") && !isAbsolute(fromRoot); }
async function readLimited(stream: ReadableStream<Uint8Array>): Promise<string> { const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0; while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_OUTPUT_BYTES) { reader.cancel(); throw new Error(`主控只读查询输出超过 ${MAX_OUTPUT_BYTES} 字节。 `); } chunks.push(next.value); } return new TextDecoder().decode(concat(chunks, size)); }
function concat(chunks: readonly Uint8Array[], size: number): Uint8Array { const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result; }
function clip(value: string): string { return value.length > MAX_OUTPUT_BYTES ? `${value.slice(0, MAX_OUTPUT_BYTES)}\n…输出已截断` : value; }
function safeEnvironment(command: ReadOnlyProjectQuery["command"]): Record<string, string> {
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG ?? "C.UTF-8" };
  if (command === "git") Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "",
    // 覆盖项目本地 .git/config 中也可能执行外部程序的入口。`git status`
    // 会读取 core.fsmonitor，因此仅隔离 global/system config 不够。
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "diff.external", GIT_CONFIG_VALUE_1: "",
  });
  return environment;
}
