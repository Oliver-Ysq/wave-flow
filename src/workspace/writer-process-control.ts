import { dlopen, FFIType } from "bun:ffi";

/**
 * 跨 Engine 恢复时的 writer 进程核验与终止能力。
 *
 * 只解决一个问题：上一 executionAttempt 的 writer 进程组是否还活着、是不是它。
 * 判定依据是 lease 里持久化的进程组 leader PID 与启动时间指纹；不以业务状态、
 * 会话是否关闭或终端文本推断。
 */
export type WriterProcessProbe =
  /** 进程组已不存在：原 writer 一定已退出。 */
  | { readonly state: "absent" }
  /**
   * 进程组仍存在：
   * - `startedAt` 为字符串时是 leader 的启动时间指纹，用于区分 PID 复用；
   * - `startedAt` 为 null 时 leader 已退出但组内仍有子进程（孤儿组），
   *   此时 pgid 仍被内核占用，不可能是别人新建的组，可安全终止。
   */
  | { readonly state: "present"; readonly startedAt: string | null }
  /** 无法核验：调用方必须 fail closed，不得当成已退出。 */
  | { readonly state: "unknown"; readonly reason: string };

/** 恢复流程注入的进程核验端口；自动测试用假实现替换。 */
export type WriterProcessControl = {
  /** 只读探测；不得改变进程状态。 */
  probe(pgid: number): Promise<WriterProcessProbe>;
  /** SIGKILL 整个进程组；进程组已消失时视为成功。 */
  killGroup(pgid: number): Promise<void>;
};

/** 生产实现：kill(-pgid,0) 判存在 + libproc 读启动时间指纹。 */
export function nodeWriterProcessControl(): WriterProcessControl {
  return {
    probe: async (pgid) => {
      if (!Number.isSafeInteger(pgid) || pgid <= 1) return { state: "unknown", reason: "进程组号无效" };
      if (!groupExists(pgid)) return { state: "absent" };
      const startedAt = leaderStartFingerprint(pgid);
      if (startedAt !== null) return { state: "present", startedAt };
      // 读不到指纹时必须区分两种情况：leader 已退出（孤儿组，pgid 仍被占用，可安全
      // 终止）与 leader 仍存在但不可读（无法证明它是原 writer，必须拒绝）。
      const leader = leaderState(pgid);
      if (leader === "missing") return { state: "present", startedAt: null };
      return { state: "unknown", reason: `进程组 ${pgid} 的 leader ${leader === "exists" ? "启动时间不可读" : "状态不可核验"}` };
    },
    killGroup: async (pgid) => {
      if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error("拒绝终止无效进程组。");
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        // 已消失不是失败；其他错误交给调用方 fail closed，不猜测。
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error(`无法终止进程组 ${pgid}：${(error as Error).message}`);
      }
    },
  };
}

/**
 * 读取进程启动时间指纹（`libproc` 的 `pbi_start_tvsec:usec`）。
 *
 * 用内核返回的启动时间而不是 ps 文本：不依赖本地化输出、不需要 fork 子进程，
 * 且在受限环境（无法 spawn ps）里仍可核验。只做相等比较，不解析时间语义。
 * 返回 null 表示进程已不存在或不可读——调用方必须区分后 fail closed。
 */
export function leaderStartFingerprint(pid: number): string | null {
  const kernel = procStartFingerprint(pid);
  if (kernel !== undefined) return kernel;
  return psStartFingerprint(pid);
}

/** libproc 结构体 proc_bsdinfo 固定 136 字节；启动时间在偏移 120/128。 */
const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;
type ProcPidinfo = (pid: number, flavor: number, arg: bigint, buffer: Buffer, size: number) => number;
let libprocSymbols: { proc_pidinfo: ProcPidinfo } | null | undefined;
function procStartFingerprint(pid: number): string | null | undefined {
  if (process.platform !== "darwin") return undefined;
  if (libprocSymbols === undefined) {
    try {
      libprocSymbols = dlopen("/usr/lib/libproc.dylib", {
        proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      }).symbols as unknown as { proc_pidinfo: ProcPidinfo };
    } catch { libprocSymbols = null; }
  }
  if (!libprocSymbols) return undefined;
  const buffer = Buffer.alloc(PROC_BSDINFO_SIZE);
  const size = libprocSymbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, buffer, PROC_BSDINFO_SIZE);
  if (size !== PROC_BSDINFO_SIZE) return null;
  return `${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}`;
}

/** libproc 不可用时的兜底：ps 原文只做相等比较，不做时间解析。 */
function psStartFingerprint(pid: number): string | null {
  try {
    const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "lstart="], { stdout: "pipe", stderr: "pipe", timeout: 2_000 });
    if (result.exitCode !== 0) return null;
    const text = new TextDecoder().decode(result.stdout).trim();
    return text.length > 0 && text.length < 64 ? text : null;
  } catch { return null; }
}

/** 绑定 writer 时必须拿到指纹；拿不到就拒绝启动，而不是留下不可核验的租约。 */
export async function captureWriterStartedAt(pid: number): Promise<string> {
  // 进程刚 spawn 时极少数情况下内核信息尚未可读；有界重试，仍读不到才拒绝。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const startedAt = leaderStartFingerprint(pid);
    if (startedAt !== null) return startedAt;
    await Bun.sleep(5);
  }
  throw new Error(`writer进程组 ${pid} 启动时间不可读；拒绝启动不可核验的writer。`);
}

/** 进程组 leader 是否仍在；EPERM 说明存在但不可信号，按不可核验处理。 */
function leaderState(pid: number): "exists" | "missing" | "unknown" {
  try {
    process.kill(pid, 0);
    return "exists";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "missing";
    if (code === "EPERM") return "exists";
    return "unknown";
  }
}

/** 进程组是否存在；EPERM 表示"存在但不可信号"，按仍存在处理并继续轮询。 */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // SIGKILL 刚发出时可能出现极短 EPERM 窗口；当作"仍存在"让调用方继续轮询或拒绝，
    // 绝不解释成已退出。其他错误同样不能被当成退出证据。
    if (code === "EPERM") return true;
    throw new Error(`进程组 ${pgid} 不可核验：${(error as Error).message}`);
  }
}
