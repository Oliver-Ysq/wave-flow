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
  /** 当前 Execution 的耐久执行尝试序号。 */
  currentExecutionAttemptId: number;
  /** 脚本声明的决策门；未回答时可由 Execution 专用端点交付 JSON 答案。 */
  gates: Array<{ gateId: string; question: string; answerSchema: Record<string, unknown> | undefined; executionAttemptId: number; phaseVisitId: number; createdAt: string; answeredAt: string | null; answer: Record<string, unknown> | null }>;
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
/** 桌面端创建 Run 的最小 loopback 请求；路径仍由 daemon 做最终 realpath 与信任校验。 */
export type CreateRunRequest = { clientRequestId: string; workflowPath: string; cwd: string; input: Record<string, unknown> };
export type RunListItem = { runId: string; workflow: { name: string; description: string }; status: RunStatus; cwd: string; createdAt: string; endedAt: string | null; diagnostic: string | null; hasBlockedAgent: boolean };
/** 菜单栏展示的 daemon 权威摘要；页面不可由此推断或改变 Run 状态。 */
export type DaemonStatusResponse = { protocolVersion: number; activeRuns: number; blockedRuns: number; activeHarnesses: number; acpWorkersNeedingResume: number };

/** 独立主控会话状态；不等同于 Workflow Run 状态。 */
export type HarnessStatus = "idle" | "running" | "interrupted" | "completed";
/** 已耐久的用户或完整主控消息；reasoning 不会出现在这里。 */
export type HarnessMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string };
/** 绑定完整 assistant 消息的工具安全摘要；不含参数、路径、命令或完整输出。 */
export type HarnessToolActivity = { label: string; finishedAt: string; outcome: "completed" | "failed" };
export type WorkflowRevision = { revision: number; source: string; sourceHash: string; createdAt: string; acceptedAt: string | null };
/** Harness 内一次冻结脚本的执行登记；细节由 executionId 对应的 Run 快照提供。 */
export type WorkflowExecution = { executionId: string; revision: number; sourceHash: string; runtimeVersion: number; policy: { maxNodes: number; maxPhaseVisits: number; maxGates: number }; createdAt: string; status: RunStatus; finishedAt: string | null; diagnostic: string | null; summary: Record<string, unknown> | null };
/** 主控经窄工具发起的用户决策；回答只唤醒原工具调用。 */
export type HarnessDecision = { decisionId: string; question: string; answerSchema?: Record<string, unknown>; createdAt: string; answer: Record<string, unknown> | null; answeredAt: string | null };
/** daemon 权威 Harness 会话快照。 */
export type HarnessSnapshot = { harnessRunId: string; projectId: string | null; cwd: string; status: HarnessStatus; diagnostic: string | null; completedAt: string | null; createdAt: string; messages: HarnessMessage[]; toolActivitiesByMessageId: Readonly<Record<string, readonly HarnessToolActivity[]>>; workflowRevisions: WorkflowRevision[]; executions: WorkflowExecution[]; decisions: HarnessDecision[] };
export type HarnessRunResponse = { harness: HarnessSnapshot };
export type HarnessRunListResponse = { harnesses: HarnessSnapshot[] };
/** 设置页展示的用户确认本机 CLI；不包含文件身份或任何环境变量。 */
export type CliRuntime = { runtimeId: string; cli: "codex"; executablePath: string; version: string; discoveredFrom: "shell-path" | "gui-path" | "manual"; discoveredShell: string | null; verifiedAdapter: { adapterId: "codex-acp"; adapterVersion: string; acpProtocolVersion: number; harnessTools: boolean }; verifiedAt: string; status: "verified" | "needs-revalidation" | "invalid"; diagnostic: string | null };
export type CliRuntimeListResponse = { selectedByCli: Partial<Record<"codex", string>>; runtimes: CliRuntime[] };
/** 启动自动扫描的无敏感信息摘要；成功项已保存但尚未被设为默认。 */
export type ScanCliRuntimesResponse = { discovered: number; verified: number; runtimes: CliRuntimeListResponse };
export type DiscoveredCliCandidate = { executablePath: string; discoveredFrom: "shell-path" | "gui-path"; discoveredShell: string | null; aliases: string[] };
/** 侧边栏耐久项目；项目提供 cwd，会话不再自行选择路径。 */
export type HarnessProject = { projectId: string; cwd: string; title: string; createdAt: string; updatedAt: string };
export type HarnessProjectResponse = { project: HarnessProject };
export type HarnessProjectListResponse = { projects: HarnessProject[] };
export type ExecutionResponse = { execution: WorkflowExecution; snapshot: RunSnapshot };
export type ExecutionListResponse = { harnessRunId: string; executions: WorkflowExecution[] };
