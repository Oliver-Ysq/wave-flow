import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { waveFlowHome } from "../journal/paths";

/** 单个日志文件上限；超过后轮转为 .1，避免长期运行无限增长。 */
const MAX_BYTES = 2 * 1024 * 1024;
/** stderr 只保留尾部，避免把完整 CLI 日志写入诊断文件。 */
const STDERR_TAIL = 4_000;
/** 串行写队列；保证并发 spawn/exit 在同一日志中保持发生顺序。 */
let logQueue: Promise<void> = Promise.resolve();

/** ACP adapter 生命周期事件；只记录进程/连接元信息，不记录 prompt 正文。 */
export type AcpLifecycleEvent = {
  /** 事件类型：spawn/exit/terminate/prompt_start/prompt_end/fail。 */
  readonly event: "spawn" | "exit" | "terminate" | "prompt_start" | "prompt_end" | "fail";
  /** Adapter launcher id；用于区分 codex/claude/dsh。 */
  readonly launcher: string;
  /** Adapter 进程 pid；spawn 之后的事件带。 */
  readonly pid?: number;
  /** Adapter 进程退出码；exit 事件带。 */
  readonly code?: number;
  /** 进程收到的信号；exit 事件带，SIGKILL/SIGPIPE 可据此识别。 */
  readonly signal?: NodeJS.Signals | null;
  /** 有界的 stderr 尾部；仅 exit 事件，可能包含 CLI 诊断，不含 prompt 正文。 */
  readonly stderr?: string;
  /** ACP session id；prompt 事件带。 */
  readonly sessionId?: string;
  /** 失败诊断；fail 事件带。 */
  readonly diagnostic?: string;
};

/** 日志路径；root 仅供测试注入。 */
export function acpLifecycleLogPath(root = waveFlowHome()): string {
  return join(root, "logs", "acp-lifecycle.log");
}

/**
 * 追加一条 ACP 生命周期日志；fire-and-forget，失败绝不影响 ACP 协议。
 * 文件/目录都按 0600/0700 创建，避免把 CLI 诊断暴露给其他用户。
 */
export function logAcpLifecycle(event: AcpLifecycleEvent, root = waveFlowHome()): void {
  // 单测使用默认状态根时不能污染真实用户目录；显式传 root 的测试仍可验证写入。
  if (process.env.NODE_ENV === "test" && root === waveFlowHome()) return;
  logQueue = logQueue.then(async () => {
    try {
      const directory = join(root, "logs");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const path = acpLifecycleLogPath(root);
      try {
        const current = await stat(path);
        if (current.size > MAX_BYTES) await rename(path, `${path}.1`);
      } catch { /* 文件尚不存在 */ }
      const entry = { at: new Date().toISOString(), ...event, ...(event.stderr ? { stderr: event.stderr.slice(-STDERR_TAIL) } : {}) };
      await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    } catch { /* 生命周期日志是辅助诊断，不允许影响协议/进程清理。 */ }
  }).catch(() => { /* 队列自身不得中断后续写入。 */ });
}
