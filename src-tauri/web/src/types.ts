export type AgentStatus = "queued" | "running" | "blocked" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";
export type RunStatus = "running" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";

export type AgentSnapshot = {
  /** 当前节点的Wave Flow会话身份；未派发时null，缺失时UI不得批准文件操作。 */
  agentSessionId?: string | null;
  /** 节点所属耐久attempt；缺失时不能证明权限请求归属。 */
  executionAttemptId?: number;
  /** Run 内稳定节点 id。 */
  id: string;
  /** 面向界面展示的节点名称。 */
  label: string;
  /** 实际承载该节点的 Agent CLI（生效值；受限 Execution 由分配快照决定）。 */
  cli: "codex" | "kimi";
  /** 节点当前权威状态。 */
  status: AgentStatus;
  /** Agent 实际工作目录。 */
  cwd: string;
  /** 完成后的结构化结果；未完成为 null。 */
  result: Record<string, unknown> | null;
  /** 当前可展示的诊断信息；无信息为 null。 */
  diagnostic: string | null;
  /** 当前人工协助请求；非 blocked 节点为 null。 */
  block: {
    /** 原阻塞请求身份；答案仅交付原Worker。 */
    blockRequestId:string;
    /** 原请求说明。 */
    needHelp:string;
    /** 是否已耐久交付，仍需原Worker continue。 */
    answered:boolean;
    /** 原答案Schema；缺省时使用JSON对象输入。 */
    answerSchema?:Record<string,unknown>;
  } | null;
  /** 生效请求摘要；assignedRuntimeId 仅在受限 Execution 中由分配快照注入。 */
  request?: { assignedRuntimeId?: string; model?: string };
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
  /** 当前尝试的阶段访问（含 occurrence 回访轮次与耐久批次）；两类 Run 统一以此呈现 Phase 轨迹。 */
  phaseVisits: PhaseVisit[];
  /** 脚本声明的决策门；未回答时可由 Execution 专用端点交付 JSON 答案。 */
  gates: Array<{ gateId: string; question: string; answerSchema: Record<string, unknown> | undefined; executionAttemptId: number; phaseVisitId: number | null; createdAt: string; answeredAt: string | null; answer: Record<string, unknown> | null }>;
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
/** Execution 的 Phase 访问分页；attempt 缺省时跨全部 attempt 聚合（executionAttemptId 为 null，cursor 为组合键）。 */
export type ExecutionPhaseVisitPageResponse = { executionId: string; executionAttemptId: number | null; items: PhaseVisit[]; nextCursor: number | null };

export type RunResponse = { runId: string; snapshot: RunSnapshot };
/** 桌面端创建 Run 的最小 action 参数；路径仍由 Engine 做最终 realpath 与信任校验。 */
export type CreateRunRequest = { clientRequestId: string; workflowPath: string; cwd: string; input: Record<string, unknown> };
export type RunListItem = { runId: string; workflow: { name: string; description: string }; status: RunStatus; cwd: string; createdAt: string; endedAt: string | null; diagnostic: string | null; hasBlockedAgent: boolean };
/** 菜单栏展示的 Desktop Engine 权威摘要；页面不可由此推断或改变 Run 状态。 */
export type DesktopStatusResponse = { protocolVersion: number; activeRuns: number; blockedRuns: number; activeHarnesses: number; acpWorkersNeedingResume: number };

/** 独立主控会话状态；不等同于 Workflow Run 状态。 */
export type HarnessStatus = "idle" | "running" | "interrupted" | "completed";
/** 已耐久的用户或完整主控消息；reasoning 不会出现在这里。 */
export type HarnessMessageAttachment = { id: string; name: string; mimeType: string; sizeBytes: number; sha256: string; file: string };
export type HarnessMessage = { /** 自动总结义务来源，缺省普通消息。 */ summaryKey?:string; id: string; role: "user" | "assistant"; text: string; createdAt: string; /** 与消息耐久绑定的附件；发送前经 Adapter 能力验证。 */ attachments?: HarnessMessageAttachment[] };
/** Engine 暂存区的待发送附件描述；选择只创建暂存，不自动发送。 */
export type StagedAttachment = { stagedId: string; name: string; mimeType: string; sizeBytes: number; sha256: string; previewDataUrl?: string };
/** 主控忙碌时耐久排队的用户消息；priority 表示“立即发送”等待优先投递。 */
export type HarnessQueuedMessage = { message: HarnessMessage; priority: boolean; queuedAt: string };
/** 绑定完整 assistant 消息的工具安全摘要；不含参数、路径、命令或完整输出。 */
export type HarnessToolActivity = { label: string; finishedAt: string; outcome: "completed" | "failed" };
/** 工具动作分类；与来源分开，经 MCP 执行的文件读取仍保留 MCP 徽标。 */
export type HarnessToolKind = "file-read" | "file-write" | "search" | "command" | "mcp" | "unknown";
/** 工具调用来源；engine-mcp 展示 MCP 徽标，acp 为 CLI 原生上报。 */
export type HarnessToolSource = "engine-mcp" | "acp";
/** 对话条目状态；interrupted 表示回合中断时仍未完成。 */
export type HarnessConversationEntryStatus = "running" | "completed" | "failed" | "interrupted";
/** 对话条目公共身份字段。 */
export type HarnessConversationEntryBase = {
  /** 稳定条目 ID；界面 key 与事件关联均使用它。 */
  entryId: string;
  /** 所属回合标识（回合用户消息 ID）。 */
  turnId: string;
  /** 回合内单调顺序号。 */
  seq: number;
  /** true 表示历史档案重建条目；缺失详情显示“历史记录未保存”。 */
  legacy: boolean;
};
/** assistant 正文条目；completed=false 为中断残留，不是完整回答。 */
export type HarnessBodyEntry = HarnessConversationEntryBase & { kind: "body"; text: string; completed: boolean; truncated: boolean; startedAt: string; finishedAt: string | null };
/** 思考条目；耗时只由起止时间计算。 */
export type HarnessThoughtEntry = HarnessConversationEntryBase & { kind: "thought"; text: string; startedAt: string; finishedAt: string | null; status: "running" | "completed" | "interrupted"; truncated: boolean };
/** 工具调用条目；含目标、起止、状态、参数摘要与限长输出。 */
export type HarnessToolEntry = HarnessConversationEntryBase & { kind: "tool"; callId: string; source: HarnessToolSource; name: string; toolKind: HarnessToolKind; target: string | null; paramsSummary: string | null; startedAt: string; finishedAt: string | null; status: HarnessConversationEntryStatus; output: string | null; outputTruncated: boolean; exitCode: number | null; hasDetail: boolean };
/** 耐久对话条目；实时展示与重开回放同源。 */
export type HarnessConversationEntry = HarnessBodyEntry | HarnessThoughtEntry | HarnessToolEntry;
/** Engine 事件帧中的会话事件（耐久派生子集）。 */
export type HarnessStreamEvent = (
  | { type: "entry_started"; entry: HarnessConversationEntry }
  | { type: "entry_appended"; entryId: string; text: string; truncated: boolean }
  | { type: "entry_finished"; entry: HarnessConversationEntry }
  | { type: "turn_finished"; messageId: string; text: string }
  | { type: "turn_interrupted"; diagnostic: string }
  | { type: "queue_changed" }
  | { type: "execution_changed"; executionId: string }) & {/** 已耐久档案序号；旧帧缺省。 */snapshotSequence?:number};
/** Tauri 转发的 Engine 事件包裹；generation 变化表示 Engine 已重启，必须重读快照。 */
export type EngineEventEnvelope = { generation: number; frame: { type: "event"; protocolVersion: 1; stream: "harness"; harnessRunId: string; seq: number; event: HarnessStreamEvent } };
export type WorkflowRevision = {
  /** 保存时确定的更新原因；缺省为未知旧记录，仅展示，不影响批准或执行。 */
  updateReason?: "save-template" | "save-local" | "generate-plan" | "modify-plan" | "modify-parameters" | "modify-configuration";
  /** Engine预检保存的本地来源快照，不能由主控或表单提交源码伪造。 */
  localOrigin?:import("../../../src/harness/types").WorkflowRevision["localOrigin"];
  /** 参数待补齐，不能直接批准运行。 */
  parametersPending?:boolean;
  /** 内置版本来源，保存后不跟随目录升级。 */
  templateOrigin?: import("../../../src/harness/workflow-templates").TemplateOrigin;
  /** 主控控制流修改后的原模板来源。 */
  derivedFrom?: import("../../../src/harness/workflow-templates").TemplateOrigin;
  /** 已保存并按目录 Schema 校验的业务参数。 */
  input?: Record<string,unknown>;
  /** 稳定候选卡身份；旧档案缺省，仅生成只读导航。 */
  cardId?: string;
  /** 同卡上一版本；首版为 null，历史未知时缺省。 */
  parentRevision?: number | null;
  /** 主控明确提出的本卡目标；历史未知时缺省。 */
  goal?: string;
  /** 本卡处理范围；历史未知时缺省。 */
  scope?: string;
  /** 放弃时刻；null/缺省表示未放弃，不删除批准证据。 */
  abandonedAt?: string | null;
  /** 提案原主控回合身份；用于定位历史，不作为授权。 */
  turnId?: string;
  revision: number; source: string; sourceHash: string; createdAt: string; acceptedAt: string | null; rejectedAt?: string | null;
  /** 随 revision 耐久的展示预览；旧档案补齐失败时缺省，不代表执行失败。 */
  preview?: {
    /** 校验后的meta说明，紧凑标题使用，完整目标仍保留。 */ description?:string;
    /** 校验后的Workflow名称，说明过长时兜底。 */ workflowName?:string;
    /** 正整数解析规则版本。 */
    previewVersion: number;
    /** 预览绑定的冻结源码 hash。 */
    sourceHash: string;
    /** 已校验阶段词表，不表达运行依赖。 */
    phaseTitles: string[];
    /** 源码调用示意，不是实际执行节点名单。 */
    previewAgents: ExecutionPlanResponse["previewAgents"];
  };
};
/** Harness 内一次冻结脚本的执行登记；细节由 executionId 对应的 Run 快照提供。 */
export type WorkflowExecution = {
 /** 本次明确确认冻结的前执行现场hash；首次缺省，不构成Replay或权限。 */ sceneEvidenceHash?:string;
 executionId: string; revision: number; sourceHash: string; runtimeVersion: number; policy: { maxNodes: number; maxPhaseVisits: number; maxGates: number }; createdAt: string; status: RunStatus; finishedAt: string | null; diagnostic: string | null; summary: Record<string, unknown> | null; config?: ExecutionConfigSnapshot | null };

/** 分配卡冻结的一个 Worker 指派；创建 Execution 时随配置快照耐久。 */
export type WorkerAssignment = { agentId: string; cli: "codex" | "kimi"; model: "cli-default"; source: "harness-cli" | "user" | "random" | "rule" | "literal-cli"; runtimeId: string; adapterId: "codex-acp" | "kimi-acp"; adapterVersion: string };
/** 分配卡冻结的不可变执行配置；缺失时 Engine 拒绝创建 Harness Execution。 */
export type ExecutionWorkspaceConfig = {
 /** 明确复用原执行保存现场，不复用节点完成状态；缺省首次分配。 */ continuation?:{executionId:string;heads:Array<{workspaceId:string;commit:string}>};
 version:2; authorization:{authorizationId:string;approvedAt:string;repository:string;baseCommit:string;excludeExistingDirty:boolean;nodes:Array<{nodeId:string;externalResources?:string[]}>};bindings:Array<{nodeId:string;workspaceId:string;integrationSources?:{nodeIds:string[]}|{batchSequence:number}}> };
export type ExecutionConfigSnapshot = { version: 1; createdAt: string; fallbackRuntimeId: string; ruleText: string | null; ruleDegraded: boolean; defaultAssignment: WorkerAssignment; assignments: WorkerAssignment[]; workspaces?:ExecutionWorkspaceConfig };
/** executions.plan 的分配卡数据。 */
export type ExecutionPlanResponse = {
  /** 已核验原执行保存现场，用户明确选择，不自动合并partial或复制节点状态。 */
  continuationPlan?:{executionId:string;baseCommit:string;workspaces:Array<{workspaceId:string;commit:string;nodeIds:string[];ready:boolean}>}|null;
  /** 最新终态执行现场证据；首次null，确认绑定此版本，不构成授权。 */
  sceneEvidenceHash?:string|null;
  workspacePlan?:{nodeIds:string[];repository:string;baseCommit:string|null;dirtyPaths:string[];diagnostic:string|null}|null;
  harnessRunId: string;
  revision: number;
  /** 已校验的阶段词表，按 meta 声明排序；不代表实际执行顺序。 */
  phaseTitles: string[];
  /** 每个源码 agent() 调用一个示意；含动态 id，不用作执行分配或定位。 */
  previewAgents: Array<{
    /** 字面量id匹配执行配置，动态为null；旧预览缺省。 */
    nodeId?:string|null;
    /** 循环／常见批量回调中的调用提示；false 为未识别，不能推断必定只运行一次。 */
    loop: boolean;
    /** 调用位置生成的列表 key，不是运行节点 id。 */
    key: string;
    /** 非空字面量 label → 固定 id → Agent；不求值动态表达式。 */
    name: string;
    /** 字面量 CLI 提示；null 表示由分配决定。 */
    cli: "codex" | "kimi" | null;
    /** 最近的字面量 phase 标题；null 表示无法静态确定，不是运行事实。 */
    phaseTitle: string | null;
  }>;
  workers: Array<{ id: string; cli: "codex" | "kimi" | null; label: string | null;
    /** 源码中最近的字面量 phase 标题；null 表示无法静态确定，不是运行事实。 */
    phaseTitle: string | null;
  }>;
  dynamicCount: number;
  pool: CliRuntime[];
  selectedByCli: Partial<Record<"codex" | "kimi", string>>;
  harnessRuntime: CliRuntime | null;
};
/** 主控经窄工具发起的用户决策；回答只唤醒原工具调用。 */
export type HarnessDecision = { decisionId: string; question: string; answerSchema?: Record<string, unknown>; createdAt: string; answer: Record<string, unknown> | null; answeredAt: string | null };
/** Desktop Engine 权威 Harness 会话快照。 */
export type HarnessSnapshot = {
  /** 原终态影响面义务；缺省为旧档案，不补造。 */
  impactSummaries?: import("../../../src/harness/types").ImpactSummary[];
  /** 原执行创建/终态的历史链接；attempt未知不猜测。 */
  executionHistory?:Array<{key:string;at:string;executionId:string;revision:number;attempt?:number;kind:"created"|"finished";status:RunStatus;diagnostic:string|null;summary:Record<string,unknown>|null}>;
  /** 此档案已应用事件数；仅用于迟到响应防倒退。历史兼容缺省。 */
  snapshotSequence?:number;
  /** 当前 Engine 活跃执行的待答计数；只作提示，缺省不猜测，不能用于授权。 */
  executionAttention?: Record<string,{workerRequests:number;scriptGates:number}>;
  task?: {
    /** 创建时冻结的模式；旧Task缺省多卡，不能由验收开关推断。 */
    workflowContract?:"single-workflow-v1";
    clientRequestId: string; payloadHash: string; title: string; initialGoal: string }; harnessRunId: string; projectId: string | null; cwd: string; status: HarnessStatus; diagnostic: string | null; completedAt: string | null; createdAt: string; messages: HarnessMessage[]; messageQueue: HarnessQueuedMessage[]; toolActivitiesByMessageId: Readonly<Record<string, readonly HarnessToolActivity[]>>; conversationEntries: HarnessConversationEntry[]; workflowRevisions: WorkflowRevision[]; executions: WorkflowExecution[]; decisions: HarnessDecision[] };
export type HarnessRunResponse = { harness: HarnessSnapshot };
export type HarnessRunListResponse = { harnesses: HarnessSnapshot[] };
/** 设置页展示的用户确认本机 CLI；不包含文件身份或任何环境变量。 */
export type CliRuntime = { runtimeId: string; cli: "codex" | "kimi"; executablePath: string; version: string; discoveredFrom: "shell-path" | "gui-path" | "manual"; discoveredShell: string | null; verifiedAdapter: { adapterId: "codex-acp" | "kimi-acp"; adapterVersion: string; acpProtocolVersion: number; harnessTools: boolean }; verifiedAt: string; status: "verified" | "needs-revalidation" | "invalid"; diagnostic: string | null };
export type CliRuntimeListResponse = { selectedByCli: Partial<Record<"codex" | "kimi", string>>; harnessRuntimeId: string | null; runtimes: CliRuntime[] };
/** 启动自动扫描的无敏感信息摘要；成功项已保存但尚未被设为默认。 */
export type ScanCliRuntimesResponse = { discovered: number; verified: number; runtimes: CliRuntimeListResponse };
export type DiscoveredCliCandidate = { cli: "codex" | "kimi"; executablePath: string; discoveredFrom: "shell-path" | "gui-path"; discoveredShell: string | null; aliases: string[] };
/** 侧边栏耐久项目；项目提供 cwd，会话不再自行选择路径。 */
export type HarnessProject = { projectId: string; cwd: string; title: string; createdAt: string; updatedAt: string };
export type HarnessProjectResponse = { project: HarnessProject };
export type HarnessProjectListResponse = { projects: HarnessProject[] };
/** Execution 详情响应：登记事实 + 权威快照 + 是否处于当前 Engine 可控制生命周期（false 时只能显式 resume）。 */
export type ExecutionResponse = {
  workspaceDiagnostic?:string;
  /** 最终ready来源证据；不创建交付分支，不代表已合入或push。 */
  sourceEvidence?: {
    /** 原Execution及幂等请求身份。 */ executionId:string; requestId:string;
    /** 受管来源分支及commit完整oid。 */ branch:string; commit:string;
    /** 内部最终成果及工作区身份。 */ sourceCommit:string; sourceWorkspaceId:string;
    /** 基准和冻结授权身份。 */ baseCommit:string; authorizationId:string;
    /** 实际变化文件与耐久时间。 */ paths:string[]; savedAt:string;
  };
  /** 收尾失败原因，不代表业务节点未complete。 */ sourceDiagnostic?:string;
  workspaceEvidence?:Array<{nodeId:string;branch:string;lease:{attempt:number}|null;results:Array<{attempt:number;commit:string;paths:string[];ready:boolean;unchanged:boolean;mergeParents:string[]}>}>;
  /** 原冻结源码静态无法枚举的调用数；只用于未知分母提示。 */
  dynamicCount?:number;
  execution: WorkflowExecution; snapshot: RunSnapshot; controllable: boolean };
export type ExecutionListResponse = { harnessRunId: string; executions: WorkflowExecution[] };
