import { constants } from "node:os";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { captureWriterStartedAt } from "../workspace/writer-process-control";

/**
 * 每个 ACP Worker 的 provider 由一个独立的 supervisor 进程托管。
 *
 * 它只解决一个问题：Engine 被强杀时，provider 进程组不能变成无人监管的孤儿。
 * supervisor 自身 detached、spawn 时把 provider 进程组报给 Engine，然后轮询 `process.ppid`；
 * owner 消失即按 SIGTERM → 宽限 → SIGSTOP 快照后代 → 逐个终止 → SIGKILL 整组的顺序收尾。
 *
 * 它不解析 ACP、不写 Journal、不改变节点状态；provider 的真实退出码（被信号杀死时折算为
 * 128+signal）原样透传，使 Engine 现有的“ACP Agent 进程异常退出”判定仍然成立。
 */
export type WorkerSupervisorSpec = {
  /** provider 可执行文件；只来自 Engine 已验证的 launcher。 */
  readonly command: string;
  /** provider argv；不得来自模型或 Workflow 输入。 */
  readonly args: readonly string[];
  /** provider 的 cwd；与 Engine 启动参数一致。 */
  readonly cwd: string;
  /** provider 的环境白名单；supervisor 不扩大权限。 */
  readonly env: Readonly<Record<string, string>>;
  /** 启动 supervisor 的 Engine pid；ppid 变化即代表 owner 消失。 */
  readonly ownerPid: number;
  /** provider 进程组的报告文件；supervisor 原子写入 pgid，Engine 读取后删除。 */
  readonly reportPath: string;
  /** 本次 supervisor 启动的一次性标识；写入报告第三行，供客户端拒绝上一代的陈旧报告。 */
  readonly spawnId: string;
  /** owner 消失或显式停止时，SIGTERM 之后等待组自行退出的宽限。 */
  readonly sigtermGraceMs?: number;
  /** SIGKILL 之后等待进程组消失的上限。 */
  readonly reapTimeoutMs?: number;
};

/** 组消失判定的默认轮询间隔；与现有 writer 围栏保持同一数量级。 */
const POLL_MS = 25;
const DEFAULT_SIGTERM_GRACE_MS = 3_000;
const DEFAULT_REAP_TIMEOUT_MS = 5_000;
/** owner 存活检查间隔；只比较 ppid，不做任何 PID 存活性推断。 */
const OWNER_POLL_MS = 100;

/** 把 spec 编进环境变量；base64 避免 argv 长度限制与引号处理。 */
export function encodeWorkerSupervisorSpec(spec: WorkerSupervisorSpec): string {
  return Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
}

/** 解析并校验 spec；任何缺失或类型错误都拒绝启动，不猜默认值。 */
export function decodeWorkerSupervisorSpec(raw: string | undefined): WorkerSupervisorSpec {
  if (!raw) throw new Error("worker supervisor 缺少 spec。");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); }
  catch { throw new Error("worker supervisor spec 不是合法 JSON。"); }
  const spec = value as Partial<WorkerSupervisorSpec> | null;
  if (!spec || typeof spec !== "object") throw new Error("worker supervisor spec 必须是对象。");
  if (typeof spec.command !== "string" || !spec.command) throw new Error("worker supervisor spec 缺少 command。");
  if (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== "string")) throw new Error("worker supervisor spec 的 args 必须是字符串数组。");
  if (typeof spec.cwd !== "string" || !spec.cwd) throw new Error("worker supervisor spec 缺少 cwd。");
  if (!spec.env || typeof spec.env !== "object" || Object.values(spec.env).some((entry) => typeof entry !== "string")) throw new Error("worker supervisor spec 的 env 必须是字符串表。");
  const ownerPid = spec.ownerPid;
  if (typeof ownerPid !== "number" || !Number.isInteger(ownerPid) || ownerPid <= 1) throw new Error("worker supervisor spec 的 ownerPid 无效。");
  if (typeof spec.reportPath !== "string" || !spec.reportPath.startsWith("/")) throw new Error("worker supervisor spec 的 reportPath 必须是绝对路径。");
  if (typeof spec.spawnId !== "string" || !spec.spawnId.trim()) throw new Error("worker supervisor spec 缺少 spawnId。");
  for (const key of ["sigtermGraceMs", "reapTimeoutMs"] as const) {
    const value = spec[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 30_000)) throw new Error(`worker supervisor spec 的 ${key} 超出 1-30000ms。`);
  }
  return spec as WorkerSupervisorSpec;
}

/** supervisor 启动标记；必须在 spawn provider 之前写入，恢复端据此区分“从未启动”。 */
export function reportLaunchMarker(reportPath: string, supervisorPid: number): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  // 新一轮 launch 优先：先删除上一代 provider 报告，避免恢复端把旧 pgid 当成本次结果。
  rmSync(reportPath, { force: true });
  const temporary = `${reportPath}.launch.tmp-${process.pid}`;
  writeFileSync(temporary, `${supervisorPid}\n`, { mode: 0o600 });
  renameSync(temporary, `${reportPath}.launch`);
}

/**
 * 把 provider 进程组、同源启动指纹与本次 spawnId 写入报告文件；原子改名，Engine 不会读到半截内容。
 *
 * 第三行 spawnId 只供客户端区分"本次 spawn"与同一路径上的上一代报告；恢复端仍只读前两行。
 */
export function reportProviderPid(reportPath: string, pgid: number, startedAt: string, spawnId: string): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${pgid}\n${startedAt}\n${spawnId}\n`, { mode: 0o600 });
  renameSync(temporary, reportPath);
}

/** supervisor 进程入口：由 `engine-main.ts` 的 `__worker-supervisor` 子命令调用。 */
export async function runWorkerSupervisor(): Promise<void> {
  const spec = decodeWorkerSupervisorSpec(process.env.WF_WORKER_SUPERVISOR_SPEC);
  delete process.env.WF_WORKER_SUPERVISOR_SPEC;
  // 先写启动标记再检查 owner：标记存在且没有 provider 报告时，恢复端能证明
  // supervisor 已启动过但 provider 未创建，而不是把意图永久留在无法核验状态。
  try { reportLaunchMarker(spec.reportPath, process.pid); }
  catch { process.exit(127); }
  // owner 在 spawn 前就已经消失时，绝不能启动一个没人监管的 provider。
  if (process.ppid !== spec.ownerPid) process.exit(1);

  const provider = Bun.spawn([spec.command, ...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["inherit", "inherit", "inherit"],
    detached: true,
  });
  const pgid = provider.pid;
  if (!Number.isInteger(pgid) || pgid <= 1) {
    try { process.kill(provider.pid, "SIGKILL"); } catch { /* 尚未创建 */ }
    process.exit(127);
  }
  // spawn 后立刻采集启动指纹，与 pgid 同源同时；不要等 Engine 在 session/new 之后补采，
  // 那时进程可能已退出、pgid 已被复用，指纹会属于别人的进程。
  const startedAt = await captureWriterStartedAt(pgid).catch(() => "");
  // 把真实进程组交给 Engine：它据此做 writer 绑定与跨重启围栏。
  try { reportProviderPid(spec.reportPath, pgid, startedAt, spec.spawnId); }
  catch {
    // 报告失败时 Engine 不知道 provider 已经创建；绝不能留下无监管孤儿。
    try { process.kill(-pgid, "SIGKILL"); } catch { /* 已退出 */ }
    process.exit(127);
  }

  let stopping = false;
  const stop = async (exitCode: number): Promise<never> => {
    if (stopping) return await new Promise<never>(() => {});
    stopping = true;
    clearInterval(ownerWatch);
    await stopProviderGroup(pgid, spec);
    process.exit(exitCode);
  };

  // provider 自己退出时，先清掉它可能遗留的后代组，再原样透传退出状态。
  // stop() 已经接管收尾时不能再 exit，否则会打断“快照后逐个终止”的杀进程序列。
  void provider.exited.then(async (code) => {
    clearInterval(ownerWatch);
    if (stopping) return;
    stopping = true;
    await reapProviderGroup(pgid, spec);
    process.exit(exitCodeOf(code ?? null, provider.signalCode ?? null));
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => { void stop(0); });
  }

  const ownerWatch = setInterval(() => {
    if (process.ppid === spec.ownerPid) return;
    void stop(1);
  }, OWNER_POLL_MS);
  ownerWatch.unref?.();
}

/** 先快照后代，再给 provider 优雅退出的机会；快照必须在 SIGTERM 之前，否则根进程退出后无法反查逃逸者。 */
async function stopProviderGroup(pgid: number, spec: WorkerSupervisorSpec): Promise<void> {
  // SIGSTOP 只停根进程，用来钉住进程树：根不能退出/回收，后代仍留在 ppid 链上可供快照。
  try { process.kill(pgid, "SIGSTOP"); } catch { /* 已经退出 */ }
  const pinned = listDescendants(pgid);
  try { process.kill(pgid, "SIGCONT"); } catch { /* 已经退出 */ }
  signalGroup(pgid, "SIGTERM");
  const gone = await waitGroupGone(pgid, spec.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS);
  // 快照里的后代即使已离开原进程组，也要逐个杀掉。
  for (const pid of pinned) {
    try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
  if (gone) return;
  // 宽限后仍存活：根还活着，重新快照一次再硬杀整组。
  try { process.kill(pgid, "SIGSTOP"); } catch { /* 已经退出 */ }
  for (const pid of listDescendants(pgid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
  signalGroup(pgid, "SIGKILL");
  await waitGroupGone(pgid, spec.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS);
}

/** provider 自行退出后的清理：组里可能还剩逃逸后代。 */
async function reapProviderGroup(pgid: number, spec: WorkerSupervisorSpec): Promise<void> {
  if (!groupExists(pgid)) return;
  for (const pid of listDescendants(pgid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
  signalGroup(pgid, "SIGKILL");
  await waitGroupGone(pgid, spec.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS);
}

/** 被信号杀死时折算成 128+signal，保持 Engine 的“非零即异常”判定。 */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal ? constants.signals[signal as keyof typeof constants.signals] : undefined;
  return number ? 128 + number : 1;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); }
  catch { try { process.kill(pgid, signal); } catch { /* 已退出 */ } }
}

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function waitGroupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!groupExists(pgid)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(POLL_MS);
  }
}

/** 读取整棵进程树；只在终止窗口内调用，不用于跨重启身份判定。 */
function listDescendants(rootPid: number): number[] {
  const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,pgid="], { stdout: "pipe", stderr: "pipe", timeout: 2_000 });
  if (result.exitCode !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]), ppid = Number(match[2]);
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid); else children.set(ppid, [pid]);
  }
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  const descendants: number[] = [];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}
