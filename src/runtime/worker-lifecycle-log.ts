import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { waveFlowHome } from "../journal/paths";

/** 单个日志文件上限；超过后轮转为 .1，避免长期运行无限增长。 */
const MAX_BYTES = 2 * 1024 * 1024;

/** 串行写队列；保证并发 Worker 的启动阶段在同一日志中保持发生顺序。 */
let logQueue: Promise<void> = Promise.resolve();

/**
 * Worker 启动生命周期事件。
 *
 * 只记录节点/会话身份、阶段和耗时，不记录 prompt 正文、文件内容或凭据。
 * 这些事件用于定位“节点已进入 running，但 ACP 会话迟迟没有建立”的启动挂起。
 */
export type WorkerLifecycleEvent = {
  /** 启动阶段；例如 execute_start / initialize_start / session_new_start / ready / closed。 */
  readonly stage: string;
  /** Run id；与 Journal 对照。 */
  readonly runId: string;
  /** 节点 id；与 Execution 快照对照。 */
  readonly nodeId: string;
  /** 本次 Worker 的受管会话身份；用于关联 agent.session。 */
  readonly agentSessionId: string;
  /** 节点 CLI 种类；只用于诊断，不参与分支。 */
  readonly cli: string;
  /** 距 execute 开始的毫秒数；缺省表示尚未开始计时。 */
  readonly elapsedMs?: number;
  /** 可选诊断；只放阶段/错误摘要，不放敏感内容。 */
  readonly diagnostic?: string;
};

/** Worker 生命周期日志路径；root 仅供测试注入。 */
export function workerLifecycleLogPath(root = waveFlowHome()): string {
  return join(root, "logs", "worker-lifecycle.log");
}

/**
 * 追加一条 Worker 启动生命周期日志；fire-and-forget，失败绝不影响 Worker。
 *
 * 测试默认不写真实用户目录；显式传 root 时仍可验证写入。
 */
export function logWorkerLifecycle(event: WorkerLifecycleEvent, root = waveFlowHome()): void {
  if (process.env.NODE_ENV === "test" && root === waveFlowHome()) return;
  logQueue = logQueue.then(async () => {
    try {
      const directory = join(root, "logs");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const path = workerLifecycleLogPath(root);
      try {
        const current = await stat(path);
        if (current.size > MAX_BYTES) await rename(path, `${path}.1`);
      } catch { /* 文件尚不存在 */ }
      await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    } catch { /* 生命周期日志是辅助诊断，不允许影响 Worker。 */ }
  }).catch(() => { /* 队列自身不得中断后续写入。 */ });
}
