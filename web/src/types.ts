export type AgentStatus = "queued" | "running" | "blocked" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";
export type RunStatus = "running" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";

export type AgentSnapshot = {
  /** Run 内稳定节点 id。 */
  id: string;
  /** 面向界面展示的节点名称。 */
  label: string;
  /** 实际承载该节点的 Agent CLI。 */
  cli: "codex";
  /** 节点当前权威状态。 */
  status: AgentStatus;
  /** Agent 实际工作目录。 */
  cwd: string;
  /** 完成后的结构化结果；未完成为 null。 */
  result: Record<string, unknown> | null;
  /** 当前可展示的诊断信息；无信息为 null。 */
  diagnostic: string | null;
  /** 当前人工协助请求；非 blocked 节点为 null。 */
  block: { blockRequestId: string; needHelp: string; answered: boolean } | null;
};

export type RunSnapshot = {
  id: string;
  status: RunStatus;
  workflow: { name: string; description: string };
  cwd: string;
  createdAt: string;
  endedAt: string | null;
  diagnostic: string | null;
  /** 按 Workflow meta 顺序排列的 Phase。 */
  phases: Array<{
    /** Phase 标题。 */
    title: string;
    /** 兼容旧调用方的扁平节点列表，按调用顺序排列。 */
    agents: AgentSnapshot[];
    /** Runtime 耐久记录的执行批次；只表达调度并发关系，不表示数据依赖。 */
    batches: Array<{
      /** Run 内递增批次号。 */
      sequence: number;
      /** serial 表示顺序批次，parallel 表示可同时调度的批次。 */
      mode: "serial" | "parallel";
      /** 当前批次中的节点。 */
      agents: AgentSnapshot[];
    }>;
  }>;
};

export type PhaseSummary = {
  title: string;
  visits: number;
  agents: number;
  statusCounts: Partial<Record<AgentStatus, number>>;
  currentVisitId: number | null;
  latestVisitId: number | null;
};

export type CurrentAttemptResponse = {
  runId: string;
  status: RunStatus;
  summary: { executionAttemptId: number; phases: PhaseSummary[]; latestPhaseVisitId: number | null };
};
export type ExecutionAttemptsResponse = { runId: string; currentExecutionAttemptId: number; executionAttemptIds: number[] };

export type PhaseVisit = {
  executionAttemptId: number;
  phaseVisitId: number;
  title: string;
  occurrence: number;
  batches: Array<{ sequence: number; mode: "serial" | "parallel"; agents: AgentSnapshot[] }>;
  createdAt: string;
};

export type PhaseVisitResponse = { runId: string; executionAttemptId: number; visit: PhaseVisit };
export type PhaseVisitPageResponse = { runId: string; executionAttemptId: number; items: PhaseVisit[]; nextCursor: number | null };

export type RunResponse = { runId: string; snapshot: RunSnapshot };
export type RunListItem = { runId: string; workflow: { name: string; description: string }; status: RunStatus; cwd: string; createdAt: string; endedAt: string | null; diagnostic: string | null; hasBlockedAgent: boolean };
