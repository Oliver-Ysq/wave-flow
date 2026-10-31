export type AgentStatus = "queued" | "running" | "blocked" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";
export type RunStatus = "running" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";

/** 前端可识别的本机 Agent CLI 种类；与后端 RuntimeCli 联合一一对应，新增种类必须同步 `cli-meta.ts`。 */
export type RuntimeCli = "codex" | "kimi" | "claude" | "dsh";
/** 已验证 ACP Adapter id；与 CLI 种类一一对应。 */
export type RuntimeAdapterId = "codex-acp" | "kimi-acp" | "claude-acp" | "dsh-acp";

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
  cli: RuntimeCli;
  /** 节点当前权威状态。 */
  status: AgentStatus;
  /** Agent 实际工作目录。 */
  cwd: string;
  /** 完成后的结构化结果；未完成为 null。 */
  result: Record<string, unknown> | null;
  /** 当前可展示的诊断信息；无信息为 null。 */
  diagnostic: string | null;
  /**
   * 节点停滞等人机提示；可选，缺省或 null 表示无提示。
   * 仅补充可见性，不代表节点状态改变，也不构成失败或人工确认依据。
   */
  hint?: string | null;
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
export type DesktopStatusResponse = { protocolVersion: number; activeRuns: number; blockedRuns: number; activeLeads: number; acpWorkersNeedingResume: number };

/** 独立主控会话状态；不等同于 Workflow Run 状态。 */
export type LeadStatus = "idle" | "running" | "interrupted" | "completed";
/** 已耐久的用户或完整主控消息；reasoning 不会出现在这里。 */
export type LeadMessageAttachment = { id: string; name: string; mimeType: string; sizeBytes: number; sha256: string; file: string };
export type LeadMessage = { /** 自动总结义务来源，缺省普通消息。 */ summaryKey?:string; id: string; role: "user" | "assistant"; text: string; createdAt: string; /** 与消息耐久绑定的附件；发送前经 Adapter 能力验证。 */ attachments?: LeadMessageAttachment[] };
/** Engine 暂存区的待发送附件描述；选择只创建暂存，不自动发送。 */
export type StagedAttachment = { stagedId: string; name: string; mimeType: string; sizeBytes: number; sha256: string; previewDataUrl?: string };
/** 主控忙碌时耐久排队的用户消息；priority 表示“立即发送”等待优先投递。 */
export type LeadQueuedMessage = { message: LeadMessage; priority: boolean; queuedAt: string };
/** 绑定完整 assistant 消息的工具安全摘要；不含参数、路径、命令或完整输出。 */
export type LeadToolActivity = { label: string; finishedAt: string; outcome: "completed" | "failed" };
/** 工具动作分类；与来源分开，经 MCP 执行的文件读取仍保留 MCP 徽标。 */
export type LeadToolKind = "file-read" | "file-write" | "search" | "command" | "mcp" | "unknown";
/** 工具调用来源；engine-mcp 展示 MCP 徽标，acp 为 CLI 原生上报。 */
export type LeadToolSource = "engine-mcp" | "acp";
/** 对话条目状态；interrupted 表示回合中断时仍未完成。 */
export type LeadConversationEntryStatus = "running" | "completed" | "failed" | "interrupted";
/** 对话条目公共身份字段。 */
export type LeadConversationEntryBase = {
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
export type LeadBodyEntry = LeadConversationEntryBase & { kind: "body"; text: string; completed: boolean; truncated: boolean; startedAt: string; finishedAt: string | null };
/** 思考条目；耗时只由起止时间计算。 */
export type LeadThoughtEntry = LeadConversationEntryBase & { kind: "thought"; text: string; startedAt: string; finishedAt: string | null; status: "running" | "completed" | "interrupted"; truncated: boolean };
/** 工具调用条目；含目标、起止、状态、参数摘要与限长输出。 */
export type LeadToolEntry = LeadConversationEntryBase & { kind: "tool"; callId: string; source: LeadToolSource; name: string; toolKind: LeadToolKind; target: string | null; paramsSummary: string | null; startedAt: string; finishedAt: string | null; status: LeadConversationEntryStatus; output: string | null; outputTruncated: boolean; exitCode: number | null; hasDetail: boolean };
/** 耐久对话条目；实时展示与重开回放同源。 */
export type LeadConversationEntry = LeadBodyEntry | LeadThoughtEntry | LeadToolEntry;
/** ACP 主控会话广告的斜杠命令/技能；只来自运行时事件，不进入 Journal。 */
export type LeadAvailableCommand = {
  name: string;
  description: string;
  inputHint: string | null;
  /**
   * UI 合并托管技能时使用的分组提示；ACP 原始命令不带该字段。
   * 只影响斜线菜单分组，不改变 Engine 或 CLI 语义。
   */
  groupHint?: "skills";
};
/** Engine 事件帧中的会话事件（耐久派生子集）。 */
export type LeadStreamEvent = (
  | { /** 最终标题耐久后重读快照。 */ type:"title_changed" }
  | { /** ACP 命令/技能目录变化；仅内存态，不触发快照重读。 */ type: "commands_changed"; commands: LeadAvailableCommand[] }
  | { type: "entry_started"; entry: LeadConversationEntry }
  | { type: "entry_appended"; entryId: string; text: string; truncated: boolean }
  | { type: "entry_finished"; entry: LeadConversationEntry }
  | { type: "turn_finished"; messageId: string; text: string }
  | { type: "turn_interrupted"; diagnostic: string }
  | { type: "queue_changed" }
  | { type: "execution_changed"; executionId: string }) & {/** 已耐久档案序号；旧帧缺省。 */snapshotSequence?:number};
/** Tauri 转发的 Engine 事件包裹；generation 变化表示 Engine 已重启，必须重读快照。 */
export type EngineEventEnvelope = { generation: number; frame: { type: "event"; protocolVersion: 1; stream: "lead"; leadRunId: string; seq: number; event: LeadStreamEvent } };
export type WorkflowRevision = {
  /** 保存时确定的更新原因；缺省为未知旧记录，仅展示，不影响批准或执行。 */
  updateReason?: "save-template" | "save-local" | "generate-plan" | "modify-plan" | "modify-parameters" | "modify-configuration";
  /** 源码形态；缺省时按 localOrigin 推断，旧 restricted 稿只读。 */
  sourceFormat?: "module" | "restricted";
  /** 保存并接管的请求 UUID；仅由用户保存生成的 revision 有。 */
  exportRequestId?: string;
  /** 保存并接管的耐久时间；仅由用户保存生成的 revision 有。 */
  exportedAt?: string;
  /** 保存请求载荷指纹；仅用于幂等冲突检测。 */
  exportPayloadHash?: string;
  /** Engine预检保存的本地来源快照，不能由主控或表单提交源码伪造。 */
  localOrigin?:import("../../../src/lead/types").WorkflowRevision["localOrigin"];
  /** 参数待补齐，不能直接批准运行。 */
  parametersPending?:boolean;
  /** 内置版本来源，保存后不跟随目录升级。 */
  templateOrigin?: import("../../../src/lead/workflow-templates").TemplateOrigin;
  /** 主控控制流修改后的原模板来源。 */
  derivedFrom?: import("../../../src/lead/workflow-templates").TemplateOrigin;
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
    /** 已校验 inputSchema；仅用于参数表单，执行仍以冻结 meta 为准。 */
    inputSchema?: Record<string, unknown>;
    /** 源码调用示意，不是实际执行节点名单。 */
    previewAgents: ExecutionPlanResponse["previewAgents"];
  };
};
/** Lead 内一次冻结脚本的执行登记；细节由 executionId 对应的 Run 快照提供。 */
export type WorkflowExecution = {
 /** 本次明确确认冻结的前执行现场hash；首次缺省，不构成Replay或权限。 */ sceneEvidenceHash?:string;
 executionId: string; revision: number; sourceHash: string; runtimeVersion: number; policy: { maxNodes: number; maxPhaseVisits: number; maxGates: number }; createdAt: string; status: RunStatus; finishedAt: string | null; diagnostic: string | null; summary: Record<string, unknown> | null; config?: ExecutionConfigSnapshot | null };

/** 分配卡冻结的一个 Worker 指派；创建 Execution 时随配置快照耐久。 */
export type WorkerAssignment = { agentId: string; cli: RuntimeCli; model: "cli-default"; source: "lead-cli" | "user" | "random" | "rule" | "literal-cli"; runtimeId: string; adapterId: RuntimeAdapterId; adapterVersion: string };
/** 分配卡冻结的不可变执行配置；缺失时 Engine 拒绝创建 Lead Execution。 */
export type ExecutionWorkspaceConfig = {
 /** 明确接续同Task最近写Execution的共享worktree；缺省首次分配。 */ continuation?:{executionId:string;workspaceId:string;head:string};
 version:3; authorization:{authorizationId:string;approvedAt:string;repository:string;baseCommit:string;excludeExistingDirty:boolean;nodes:Array<{nodeId:string}>;/** 循环写节点的稳定字面量前缀；用户确认时逐前缀披露，实际节点在执行记录中核验。 */dynamicNodes?:Array<{nodeIdPrefix:string}>}; workspaceId:string };
export type ExecutionConfigSnapshot =
  | { version: 1; assignmentMode?: "assigned"; createdAt: string; fallbackRuntimeId: string; ruleText: string | null; ruleDegraded: boolean; defaultAssignment: WorkerAssignment; assignments: WorkerAssignment[]; workspaces?: ExecutionWorkspaceConfig }
  | { version: 1; assignmentMode: "script"; createdAt: string; /** 逐节点 CLI 选择；键为源码中省略 cli 的字面量节点 id。 */ nodeClis?: Record<string, RuntimeCli>; /** 动态节点（无法静态枚举 id）的兜底 CLI。 */ cli?: RuntimeCli; workspaces?: ExecutionWorkspaceConfig };
/** executions.plan 的分配卡数据。 */
export type ExecutionPlanResponse = {
  /** 已核验原执行共享worktree，写修订自动接续；不复制节点状态。 */
  continuationPlan?:{executionId:string;baseCommit:string;workspaceId:string;head:string}|null;
  /** 最新终态执行现场证据；首次null，确认绑定此版本，不构成授权。 */
  sceneEvidenceHash?:string|null;
  /** 受管写计划：固定写节点逐个枚举；循环写节点只给稳定字面量前缀，实际节点在执行记录中核验。 */
  workspacePlan?:{nodeIds:string[];/** 循环写节点 id 的字面量前缀，随确认载荷冻结并展示。 */dynamicNodePrefixes?:string[];repository:string;baseCommit:string|null;dirtyPaths:string[];diagnostic:string|null}|null;
  leadRunId: string;
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
    cli: RuntimeCli | null;
    /** 最近的字面量 phase 标题；null 表示无法静态确定，不是运行事实。 */
    phaseTitle: string | null;
  }>;
  workers: Array<{ id: string; cli: RuntimeCli | null; label: string | null;
    /** 源码中最近的字面量 phase 标题；null 表示无法静态确定，不是运行事实。 */
    phaseTitle: string | null;
  }>;
  dynamicCount: number;
  /** 逐节点 CLI 选择所需事实；仅当存在省略 cli 的节点或动态调用时非空。 */
  cliChoices?: { available: RuntimeCli[]; suggested: RuntimeCli | null; nodes: Array<{ nodeId: string; label: string | null }>; dynamicCount: number } | null;
  pool: CliRuntime[];
  selectedByCli: Partial<Record<RuntimeCli, string>>;
  leadRuntime: CliRuntime | null;
};
/** 主控经窄工具发起的用户决策；回答只唤醒原工具调用。 */
export type LeadDecision = { decisionId: string; question: string; answerSchema?: Record<string, unknown>; createdAt: string; answer: Record<string, unknown> | null; answeredAt: string | null };
/** Desktop Engine 权威 Lead 会话快照。 */
export type LeadSnapshot = {
  /** 创建时冻结的主控 runtime 来源；历史档案可能缺省。 */
  runtime?: { runtimeId: string } | null;
  /** 原终态影响面义务；缺省为旧档案，不补造。 */
  impactSummaries?: import("../../../src/lead/types").ImpactSummary[];
  /** 原执行创建/终态的历史链接；attempt未知不猜测。 */
  executionHistory?:Array<{key:string;at:string;executionId:string;revision:number;attempt?:number;kind:"created"|"finished";status:RunStatus;diagnostic:string|null;summary:Record<string,unknown>|null}>;
  /** 此档案已应用事件数；仅用于迟到响应防倒退。历史兼容缺省。 */
  snapshotSequence?:number;
  /** 当前 ACP 会话广告的斜杠命令/技能；仅内存态，缺省表示尚无会话或尚未收到。 */
  availableCommands?: LeadAvailableCommand[];
  /** 当前 Engine 活跃执行的待答计数；只作提示，缺省不猜测，不能用于授权。 */
  executionAttention?: Record<string,{workerRequests:number;scriptGates:number}>;
  task?: {
    /** 人工名称已耐久保存；缺省无人工覆盖，自动命名不得覆盖manual。 */
    titleSource?: "manual";
    /** 本Task已消费后台一次性命名尝试，不因重开而补跑。 */
    namingAttempted?: boolean;
    /** 创建时冻结的模式；旧Task缺省多卡，不能由验收开关推断。 */
    workflowContract?:"single-workflow-v1";
    clientRequestId: string; payloadHash: string; title: string; initialGoal: string }; leadRunId: string; projectId: string | null; cwd: string; status: LeadStatus; diagnostic: string | null; completedAt: string | null; createdAt: string; messages: LeadMessage[]; messageQueue: LeadQueuedMessage[]; toolActivitiesByMessageId: Readonly<Record<string, readonly LeadToolActivity[]>>; conversationEntries: LeadConversationEntry[]; workflowRevisions: WorkflowRevision[]; executions: WorkflowExecution[]; decisions: LeadDecision[] };
export type LeadRunResponse = { lead: LeadSnapshot };
/** 临时 ACP 会话发现的斜杠命令/技能目录；不创建 Lead 或 Journal。 */
export type LeadCommandCatalogResponse = { commands: LeadAvailableCommand[] };
export type LeadRunListResponse = { leads: LeadSnapshot[] };
/** 设置页展示的用户确认本机 CLI；不包含文件身份或任何环境变量。 */
export type CliRuntime = { runtimeId: string; cli: RuntimeCli; executablePath: string; version: string; discoveredFrom: "shell-path" | "gui-path" | "install-dir" | "manual"; discoveredShell: string | null; verifiedAdapter: { adapterId: RuntimeAdapterId; adapterVersion: string; acpProtocolVersion: number; leadTools: boolean }; verifiedAt: string; status: "verified" | "needs-revalidation" | "invalid"; diagnostic: string | null };
export type CliRuntimeListResponse = { selectedByCli: Partial<Record<RuntimeCli, string>>; leadRuntimeId: string | null; runtimes: CliRuntime[] };

/** 可作为技能导入来源的本机 CLI 技能目录种类。 */
export type SkillSourceCli = "codex" | "claude" | "dsh" | "kimi" | "agents";

/** 一个可导入的本机 CLI 技能来源；exists=false 表示目录不存在，不是错误。 */
export type SkillImportSource = {
  /** 来源 CLI 种类；agents 表示共享的 ~/.agents/skills。 */
  cli: SkillSourceCli;
  /** 面向用户的来源名称。 */
  label: string;
  /** 技能根目录绝对路径。 */
  root: string;
  /** 扫描时该目录是否存在。 */
  exists: boolean;
};

/** 从 CLI 目录发现的一个候选 skill。 */
export type DiscoveredSkill = {
  /** skill 名称。 */
  name: string;
  /** frontmatter description；非法候选为空字符串。 */
  description: string;
  /** 来源 CLI 种类。 */
  sourceCli: SkillSourceCli;
  /** 来源展示名称。 */
  sourceLabel: string;
  /** skill 目录绝对路径，用于导入时定位。 */
  path: string;
  /** SKILL.md 摘要；非法候选为 null。 */
  skillMdSha256: string | null;
  /** 与托管库的同名关系。 */
  installed: "none" | "same" | "different";
  /** 是否通过静态校验。 */
  valid: boolean;
  /** 校验失败原因；valid=true 时为 null。 */
  issue: string | null;
};

/** 技能导入发现结果。 */
export type SkillDiscoverResult = {
  /** 扫描过的全部来源，含缺失来源。 */
  sources: SkillImportSource[];
  /** 有效或可解释的候选 skill。 */
  skills: DiscoveredSkill[];
};

/** 设置页技能库状态；由 Engine 只读扫描产生，不含技能正文或凭据。 */
export type SkillLibraryStatus = {
  /** 技能库根目录绝对路径。 */
  root: string;
  /** 扫描时目录是否存在。 */
  exists: boolean;
  /** 库摘要；空库为 null。 */
  digest: string | null;
  /** 合法 skill 数量。 */
  count: number;
  /** 合法 skill、声明依赖与只读缺失诊断。 */
  skills: Array<{ name: string; description: string; bytes: number; requiredBins: string[]; missingBins: string[] }>;
  /** 所有 skill 声明中缺失的依赖并集；仅提示，不阻止注入。 */
  missingDependencies: string[];
  /** 被跳过、不参与注入的非法 skill；不影响其他合法项。 */
  invalid: Array<{ name: string; issue: string }>;
  /** 每个可选 CLI 的注入能力。 */
  capabilities: Array<{ cli: RuntimeCli; displayName: string; injection: "verified" | "unsupported" }>;
  /** 暂时下线的 CLI 与原因。 */
  unavailable: Array<{ cli: RuntimeCli; reason: string }>;
};
/** 启动自动扫描的无敏感信息摘要；成功项已保存但尚未被设为默认。 */
export type ScanCliRuntimesResponse = { discovered: number; verified: number; failures: Partial<Record<RuntimeCli, "absent" | "timeout" | "exec_failed" | "limit_reached">>; runtimes: CliRuntimeListResponse };
export type DiscoveredCliCandidate = { cli: RuntimeCli; executablePath: string; discoveredFrom: "shell-path" | "gui-path" | "install-dir"; discoveredShell: string | null; aliases: string[] };
/** 侧边栏耐久项目；项目提供 cwd，会话不再自行选择路径。 */
export type LeadProject = { projectId: string; cwd: string; title: string; createdAt: string; updatedAt: string };
export type LeadProjectResponse = { project: LeadProject };
export type LeadProjectListResponse = { projects: LeadProject[] };
/** Execution 详情响应：登记事实 + 权威快照 + 是否处于当前 Engine 可控制生命周期（false 时只能显式 resume）。 */
export type ExecutionResponse = {
  /** 工作区现场读取失败；不代表目录不存在或没有改动。 */ workspaceDiagnostic?:string;
  /** 共享worktree与租约投影；closedWriters 为恢复前终止或确认退出的旧writer数。 */
  workspaceEvidence?:{workspaceId:string;cwd:string;branch:string;head:string|null;leases:Array<{nodeId:string;attempt:number}>;closedWriters:number;cleaned:boolean};
  /** 原冻结源码静态无法枚举的调用数；只用于未知分母提示。 */
  dynamicCount?:number;
  execution: WorkflowExecution; snapshot: RunSnapshot; controllable: boolean };
export type ExecutionListResponse = { leadRunId: string; executions: WorkflowExecution[] };
