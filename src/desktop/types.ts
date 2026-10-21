import type { JsonObject } from "../shared/json";
import type { HarnessSnapshot, WorkflowExecutionRecord } from "../harness/types";
import type { HarnessProject } from "../harness/projects";
import type { CliRuntimeView, DiscoveredCliCandidate, RuntimeCli } from "../runtimes/types";
import type { CliProbeStatus } from "../runtimes/cli-probe";
import type { CurrentAttemptSummary, PhaseVisitSnapshot, RunSnapshot } from "../runtime/run-types";

/** 创建 Run 的 Desktop action 参数；Workflow 路径相对于 cwd 解析。 */
export type CreateRunRequest = {
  /** Desktop 为本次创建生成的 UUID；IPC 响应丢失后的重试必须复用它。 */
  readonly clientRequestId: string;
  /** 用户明确指定的本地 TypeScript Workflow 路径。 */
  readonly workflowPath: string;
  /** 项目 cwd；Engine 以此限制 Workflow 和状态目录边界。 */
  readonly cwd: string;
  /** 传给 Workflow default run(args) 的 JSON-safe 对象。 */
  readonly input: JsonObject;
};

/** 创建或查询 Run 的 Engine 权威响应。 */
export type RunResponse = {
  /** Journaled Run 的稳定 id。 */
  readonly runId: string;
  /** Engine 权威的 Phase → Agent 查询快照。 */
  readonly snapshot: RunSnapshot;
};

/** Run 列表的轻量条目；不包含阶段访问、批次、Agent 或结果。 */
export type RunListItem = {
  /** Run 稳定 id。 */
  readonly runId: string;
  /** Workflow 展示信息。 */
  readonly workflow: { readonly name: string; readonly description: string };
  /** 当前 Run 状态。 */
  readonly status: RunSnapshot["status"];
  /** Workflow 项目目录。 */
  readonly cwd: string;
  /** Run 创建时间。 */
  readonly createdAt: string;
  /** Run 终止时间；未终止为 null。 */
  readonly endedAt: string | null;
  /** Run 诊断信息。 */
  readonly diagnostic: string | null;
  /** 当前尝试内是否有需要协助的节点。 */
  readonly hasBlockedAgent: boolean;
};

/** 菜单栏读取的 Desktop Engine 权威摘要；只暴露计数，不泄露会话或 Journal 内容。 */
export type DesktopStatusResponse = {
  /** 当前私有 Engine IPC 协议版本。 */
  readonly protocolVersion: number;
  /** 未终结 Run 数量。 */
  readonly activeRuns: number;
  /** 等待人工协助的 Run 数量。 */
  readonly blockedRuns: number;
  /** 正在生成回复的 Harness 回合数。 */
  readonly activeHarnesses: number;
  /** ACP 不支持跨 Engine 认领、需要用户显式恢复的 Worker 数量。 */
  readonly acpWorkersNeedingResume: number;
};

/** Run 当前执行尝试的轻量首页数据，不包含全部历史 Agent。 */
export type CurrentAttemptResponse = {
  /** Run 稳定 id。 */
  readonly runId: string;
  /** Engine 权威 Run 状态。 */
  readonly status: RunSnapshot["status"];
  /** 当前尝试的阶段摘要。 */
  readonly summary: CurrentAttemptSummary;
};

/** 可供审计界面选择的执行尝试列表。 */
export type ExecutionAttemptsResponse = {
  /** Run 稳定 id。 */
  readonly runId: string;
  /** 默认展示的当前尝试。 */
  readonly currentExecutionAttemptId: number;
  /** 已耐久的尝试号，按创建顺序排列。 */
  readonly executionAttemptIds: readonly number[];
};

/** 单次阶段访问的完整阅读数据。 */
export type PhaseVisitResponse = {
  /** Run 稳定 id。 */
  readonly runId: string;
  /** 所属执行尝试。 */
  readonly executionAttemptId: number;
  /** 当前请求的阶段访问详情。 */
  readonly visit: PhaseVisitSnapshot;
};

/** 分页执行记录响应；nextCursor 为 null 表示没有下一页。 */
export type PhaseVisitPageResponse = {
  /** Run 稳定 id。 */
  readonly runId: string;
  /** 被查询的执行尝试。 */
  readonly executionAttemptId: number;
  /** 当前页阶段访问。 */
  readonly items: readonly PhaseVisitSnapshot[];
  /** 下一页稳定 cursor。 */
  readonly nextCursor: number | null;
};

/** Execution 的 Phase 访问分页响应；attempt 缺省时跨全部 attempt 聚合（cursor 为组合键）。 */
export type ExecutionPhaseVisitPageResponse = {
  /** 所属 Execution 稳定 id。 */
  readonly executionId: string;
  /** 单 attempt 查询时回显该尝试号；跨 attempt 聚合查询为 null。 */
  readonly executionAttemptId: number | null;
  /** 当前页阶段访问；聚合查询按（尝试号, phaseVisitId）稳定排序。 */
  readonly items: readonly PhaseVisitSnapshot[];
  /** 下一页稳定 cursor。 */
  readonly nextCursor: number | null;
};

/** 用户显式请求同一 Run 的调用级恢复；runId 仅来自 URL，避免客户端覆写 Manifest 身份。 */
export type ResumeRunRequest = {
  /** true 代表用户已确认允许从第一个 interrupted 节点创建新 attempt。 */
  readonly authorized: true;
};

/** 完成 Harness 会话请求；空对象表示无额外参数。 */
export type CompleteHarnessRequest = Record<string, never>;

/** 创建只读 Harness 主控会话的 Desktop action 参数；不创建 Workflow Run 或 Worker。 */
export type CreateHarnessRunRequest = {
  /** 已选择的耐久项目 id；Engine 从 Project Store 获取 cwd。 */
  readonly projectId: string;
};
/** 首次发送创建 Harness；草稿文本只在浏览器内存中，Engine 仅在此 action 抵达后创建档案。 */
export type StartHarnessConversationRequest = {
  /** 首条消息的图片暂存身份；默认空，沿用每条最多5个与图片能力校验。 */ readonly stagedAttachmentIds?: readonly string[];
  /** Task 创建重试 UUID，必填；重试保持原身份，无字段请求拒绝且不创建档案。 */
  readonly clientRequestId: string;
  /** 固定任务标题；缺省取初始目标首行，1–120 个单行字符。 */
  readonly title?: string;
  /** 已选择的耐久项目 id；Engine 从 Project Store 获取 cwd。 */
  readonly projectId: string;
  /** 新会话的首条非空用户消息；成功后才产生 Harness manifest 与 Journal。 */
  readonly text: string;
};
/** 创建侧边栏项目；cwd 会 realpath 校验，title 省略时取目录名。 */
export type CreateHarnessProjectRequest = { readonly cwd: string; readonly title?: string };
/** 创建或查询单个侧边栏项目。 */
export type HarnessProjectResponse = { readonly project: HarnessProject };
/** 当前用户全部耐久项目。 */
export type HarnessProjectListResponse = { readonly projects: readonly HarnessProject[] };

/** Harness 主控会话的 Engine 权威响应。 */
export type HarnessRunResponse = { readonly harness: HarnessSnapshot };
/** 临时 ACP 会话发现的斜杠命令/技能目录；不创建 Harness 或 Journal。 */
export type HarnessCommandCatalogResponse = { readonly commands: readonly import("../harness/types").HarnessAvailableCommand[] };
/** 当前用户的已耐久主控会话列表；不扫描、创建或接管 Workflow Run。 */
export type HarnessRunListResponse = { readonly harnesses: readonly HarnessSnapshot[] };
/** 发送一条用户消息；响应确认 Engine 已耐久接收，完整消息由后续快照读取。 */
export type HarnessMessageRequest = { readonly text: string; /** 客户端生成的 UUID，用于重试幂等；重复提交不重复入队或开回合。 */ readonly clientMessageId?: string; /** true 表示“立即发送”：中断当前回合后优先投递。 */ readonly immediate?: boolean; /** Engine 暂存区的待发送附件身份；发送时才耐久绑定，不传输路径。 */ readonly stagedAttachmentIds?: string[] };
/** 用户明确接受最新草案；接受后 hash 冻结，仍不创建 Run。 */
export type AcceptWorkflowRevisionRequest = { readonly revision: number };

/** 创建 WorkflowExecution 的 Desktop action 参数；只能绑定已接受冻结的 revision。 */
export type CreateExecutionRequest = {
  /** 已接受冻结的 revision 序号；草稿序号必须被拒绝。 */
  readonly revision: number;
  /** 传给受限脚本 run(args) 的 JSON-safe 输入；省略时为 {}。 */
  readonly input?: JsonObject;
  /** 分配卡冻结的执行配置快照；Harness Execution 必填，缺失即拒绝创建。 */
  readonly config?: import("../harness/types").ExecutionConfigSnapshot;
};

/** executions.plan 的响应：枚举 Worker、已验证池与主控 Runtime 摘要，供分配卡渲染。 */
export type ExecutionPlanResponse = {
  /** 原执行可安全接续的共享worktree；写修订默认自动接续，不复制节点完成状态。 */
  readonly continuationPlan?: {
    /** 同Task最近写执行UUID；中间只读轮次不清除已有成果。 */ readonly executionId:string;
    /** 原冻结Git基准，保留累计diff。 */ readonly baseCommit:string;
    /** 唯一受管worktree UUID。 */ readonly workspaceId:string;
    /** 交接时worktree权威HEAD；漂移拒绝旧确认。 */ readonly head:string;
  }|null;
  /** 最新终态执行的现场证据hash；首次为null，确认须携带，变化拒绝旧确认；不是授权凭据。 */
  readonly sceneEvidenceHash?: string | null;
  /** 固定写节点与实时Git基准预检；无写节点为null，无法验证有diagnostic并禁止受管写。 */
  readonly workspacePlan?: { readonly nodeIds: readonly string[]; readonly repository: string; readonly baseCommit: string | null; readonly dirtyPaths: readonly string[]; readonly diagnostic: string | null } | null;
  /** 已校验 meta.phases 的声明顺序标题；只作预览词表，不表达执行顺序或依赖。 */
  readonly phaseTitles: readonly string[];
  /** 每个源码 agent() 调用一个展示示意（含动态 id）；不用于分配校验或运行节点定位。 */
  readonly previewAgents: readonly import("../workflow/restricted/extract-agents").PreviewAgent[];
  /** 所属 Harness Run id。 */
  readonly harnessRunId: string;
  /** 已接受冻结的 revision 序号。 */
  readonly revision: number;
  /** 静态枚举出的字面量 Worker；分配卡逐 Worker 展示。 */
  readonly workers: readonly import("../workflow/restricted/extract-agents").ExtractedAgentWorker[];
  /** 非字面量 id 的 agent() 调用数；它们运行时落 default 分配。 */
  readonly dynamicCount: number;
  /** 已验证即候选的 Worker Runtime 池；不含文件身份。 */
  readonly pool: readonly import("../runtimes/types").CliRuntimeView[];
  /** 每个 CLI 的用户偏好 runtime id；Engine 解析 cli → Runtime 时优先使用。 */
  readonly selectedByCli: Readonly<Partial<Record<RuntimeCli, string>>>;
  /** 主控 Runtime（回退目标）；未设置时为 null，UI 必须阻止创建。 */
  readonly harnessRuntime: import("../runtimes/types").CliRuntimeView | null;
};

/** Execution 创建、控制或答题后的权威响应。 */
export type ExecutionResponse = {
  /** 原冻结源码静态无法枚举的调用数；只作进度分母提示，不代表实际节点数。 */
  readonly dynamicCount?:number;
  /** Execution 登记事实；终态与摘要由 harness.execution_finished 固定。 */
  readonly execution: WorkflowExecutionRecord;
  /** Execution 内嵌 Run 的 Engine 权威快照；gates 字段携带决策门状态。 */
  readonly snapshot: RunSnapshot;
  /**
   * 该 Execution 是否在当前 Engine 的可控制生命周期内（Engine 进程持有活跃实例）。
   * false 时 pause/recover/stop/answerGate 都会被拒绝，唯一前进路径是显式 resume；
   * 重启后尚未收敛或尚未 resume 的 Execution 会长期处于 false。
   */
  readonly controllable: boolean;
  /** 受管Git成果投影；只展示共享worktree与租约事实，不改变Run业务状态。 */
  readonly workspaceEvidence?: {
    /** 本Execution唯一受管worktree UUID。 */ readonly workspaceId:string;
    /** 受管分支短名。 */ readonly branch:string;
    /** worktree当前HEAD；已清理为null。 */ readonly head:string|null;
    /** 当前仍存活的本Execution writer租约。 */ readonly leases:readonly { readonly nodeId:string; readonly attempt:number }[];
    /** 该worktree累计被显式resume释放的旧Engine租约数（含其他接续Execution）。 */ readonly staleLeases:number;
    /** worktree是否已安全清理。 */ readonly cleaned:boolean;
  };
  /** Git证据读取失败不影响原Run状态读取；错误不代表无改动。 */
  readonly workspaceDiagnostic?: string;
  /** 最终封存与自动应用证据；缺省表示尚未收尾。 */
  readonly sourceEvidence?: import("../workspace/workspace-manager").WorkspaceSource;
  /** 最终收尾失败原因，与Run业务状态分开展示；缺省无已登记失败。 */
  readonly sourceDiagnostic?: string;
};

/** 单个执行尝试的只读结果证据；缺失结果不从其他 attempt 补造。 */
export type ExecutionAttemptResultsResponse = {
  /** 所属 Execution UUID。 */
  readonly executionId:string;
  /** 已耐久且存在的正整数尝试号。 */
  readonly attempt:number;
  /** 原终态；尚未登记为 null。 */
  readonly status:WorkflowExecutionRecord["status"]|null;
  /** 原脚本对象返回值；未保存或非对象为 null。 */
  readonly summary:JsonObject|null;
  /** 本 attempt 真正完成的节点；不混入其他尝试的新结果。 */
  readonly nodes:readonly {
    /** Run 内稳定节点身份。 */
    readonly id:string;
    /** 原耐久可读名称。 */
    readonly label:string;
    /** 原完成 JSON 结果。 */
    readonly result:JsonObject|null;
  }[];
};

/** Harness 顺序拥有的 Execution 登记列表；执行细节需按 executionId 单独读取。 */
export type ExecutionListResponse = {
  /** 所属 Harness Run id。 */
  readonly harnessRunId: string;
  /** 按创建顺序排列的 Execution 登记。 */
  readonly executions: readonly WorkflowExecutionRecord[];
};

/** 用户显式恢复中断的 Execution；必须明确授权，Engine 重启绝不自动继续。 */
export type ResumeExecutionRequest = {
  /** true 代表用户确认允许同一冻结 revision 创建新的 executionAttempt。 */
  readonly authorized: true;
};

/** 用户对脚本决策门或主控决策请求提交 JSON 答案；答案不自动推进任何节点状态。 */
export type AnswerDecisionRequest = {
  /** 已通过对应 answerSchema 校验前的原始 JSON 对象；Engine 负责校验。 */
  readonly answer: JsonObject;
};

/** 当前用户的本机 CLI Runtime 与默认选择；不含 inode、PATH 或环境变量。 */
export type CliRuntimeListResponse = {
  /** 每个 CLI 的 Worker 偏好 runtime id。 */
  readonly selectedByCli: Readonly<Partial<Record<RuntimeCli, string>>>;
  /** 新建主控会话使用的 runtime id；未设置时为 null。 */
  readonly harnessRuntimeId: string | null;
  /** 设置页可展示的 runtime 列表。 */
  readonly runtimes: readonly CliRuntimeView[];
};
/** 用户明确扫描 PATH 后返回的候选；候选尚未经过 ACP 验证。 */
export type DiscoverCliRuntimesResponse = { readonly candidates: readonly DiscoveredCliCandidate[] };
/** 一次启动扫描的汇总；成功候选已完成完整 ACP 验证并写入 Registry，但绝不改变默认项。 */
export type ScanCliRuntimesResponse = {
  /** 本次从受控 PATH 与常见安装目录发现的去重候选数。 */
  readonly discovered: number;
  /** 本次完整验证并保存成功的候选数。 */
  readonly verified: number;
  /** 未得到可用候选的 CLI 及探测结论；`absent` 表示确实没找到，`timeout` 表示无法判断，不得当成未安装。 */
  readonly failures: Partial<Record<RuntimeCli, CliProbeStatus>>;
  /** 当前安全可展示的 Runtime 列表；不含 PATH、环境或文件身份。 */
  readonly runtimes: CliRuntimeListResponse;
};
/** 验证发现候选或手动绝对路径；成功不会自动成为默认项。 */
export type ValidateCliRuntimeRequest = {
  /** 用户明确给出的 CLI 绝对路径；Engine 会 realpath 并复核身份。 */
  readonly executablePath: string;
  /** 该路径声称的 CLI 种类；决定使用哪个内置 validator，不允许猜测。 */
  readonly cli: RuntimeCli;
  readonly discoveredFrom?: "shell-path" | "gui-path" | "install-dir" | "manual";
  readonly discoveredShell?: string | null;
};
/** 设置默认 Runtime 的响应。 */
export type SelectCliRuntimeResponse = { readonly runtime: CliRuntimeView };
