/** 一次独立运行的固定身份；resume 只能使用该文件记录的原始环境。 */
export type RunManifest = {
  /** 本次 run 的唯一标识，也是 .wave-flow/runs 下的目录名。 */
  runId: string;
  /** 运行时加载的 Workflow 绝对路径。 */
  workflowPath: string;
  /** Workflow 源码的 SHA-256；恢复前必须完全一致。 */
  workflowHash: string;
  /** 首次 run 时传给 Workflow 的 JSON 输入。 */
  input: Record<string, unknown>;
  /** 首次 run 选定的 Agent 后端名称。 */
  adapter: string;
  /** Agent 节点使用的绝对工作目录。 */
  cwd: string;
  /** 创建时间的 ISO 字符串，仅用于观察，不参与回放匹配。 */
  createdAt: string;
};

/** Journal 的节点事件；只有 completed 记录能在同一 run 内被回放。 */
export type JournalRecord =
  | { event: "agent.started"; nodeKey: string; inputHash: string; timestamp: string }
  | { event: "agent.completed"; nodeKey: string; inputHash: string; output: unknown; timestamp: string }
  | { event: "agent.failed"; nodeKey: string; inputHash: string; error: string; timestamp: string };

/** inspect 使用的最小状态汇总。 */
export type JournalSummary = {
  completed: number;
  started: number;
  failed: number;
  replayed: number;
  latestError?: string;
};
