import type { JsonObject } from "../shared/json";
import type { AgentCli, AgentSandbox, NormalizedAgentRequest, WorkflowMeta } from "../shared/workflow-types";

/** Agent 节点在一次 Run 内可见的状态；终态不可回退。 */
export type AgentNodeStatus = "queued" | "running" | "blocked" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";

/** Run 的聚合终态；由节点终态与顶层 Workflow 诊断决定。 */
export type RunStatus = "running" | "pausing" | "paused" | "recovering" | "completed" | "cancelled" | "interrupted";

/** 注入 Runtime 的可控节点执行器；本阶段不启动 CLI 或读取终端。 */
export type AgentNodeExecutor = {
  /** 可选的全局启动名额等待；未取得名额前节点必须保持 queued。 */
  waitForStart?(node: AgentNodeSnapshot): Promise<void>;
  /** 节点尚未进入 execute 即无法启动时归还先前取得的名额。 */
  cancelStart?(node: AgentNodeSnapshot): void;
  /** 是否已有节点因全局资源名额实际等待；仅用于异步 run 的安全交还。 */
  hasWaitingStart?(): boolean;
  /** 执行一个已进入 running 的节点；对象表示完成，null 或抛错都表示无法验证完成的中断。 */
  execute(node: AgentNodeSnapshot): Promise<JsonObject | null>;
  /** 业务completed已耐久后的宿主交接（writer退出核验与租约释放）；普通只读执行器省略，失败必须抛契约错误且不回退业务终态。 */
  finalizeCompleted?(node: AgentNodeSnapshot): Promise<void>;
  /** 用户普通stop后的宿主partial收尾；业务cancelled先耐久，失败保留锁/现场且不能回退业务终态。Desktop退出不调用。 */
  finalizePartial?(node: AgentNodeSnapshot): Promise<void>;
  /** 可选的运行期能力重检；真实会话执行器应在节点启动前返回当前环境快照。 */
  /** 停止当前节点的真实执行；成功后 Executor 必须保留同一会话用于 recover。 */
  pause?(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<void>;
  /** 在原会话中创建新的继续回合；成功后节点才可重新进入 running。 */
  recover?(node: AgentNodeSnapshot, signal?: AbortSignal): Promise<AgentRecovery>;
  /** 终止当前节点，不保留 recover 能力。 */
  stop?(node: AgentNodeSnapshot): Promise<void>;
};

/** recover 成功后可耐久记录的同一 ACP session 事实。 */
export type AgentRecovery = {
  /** 同一 ACP session 已启动恢复回合；用于耐久化恢复投递事实，不是业务完成依据。 */
  readonly acp?: { readonly launcherId: string; readonly sessionId: string; };
};

/** Agent 节点对执行器与查询层公开的不可变快照。 */
export type AgentNodeSnapshot = {
  /** Run 内唯一稳定节点 id。 */
  readonly id: string;
  /** 调用 agent() 时捕获的 Phase；未设置 Phase 时为 null。 */
  readonly phase: string | null;
  /** 节点所属执行尝试；旧 Journal 兼容投影为 1。 */
  readonly executionAttemptId: number;
  /** 节点所属阶段访问；同一 Phase 的不同回溯轮次不可混淆。 */
  readonly phaseVisitId: number;
  /** 同一 Run 内实际 agent() 调用顺序，从 1 开始。 */
  readonly sequence: number;
  /** Runtime 已知的调度批次；只表示串行/并行调度，不表示数据依赖。 */
  readonly executionBatch: import("./workflow-host").ExecutionBatch;
  /** 节点实际使用的 CLI。 */
  readonly cli: AgentCli;
  /** 节点实际使用的 sandbox。 */
  readonly sandbox: AgentSandbox;
  /** 已验证的节点工作目录；可为 Workflow 项目子目录或显式独立本地项目。 */
  readonly cwd: string;
  /** 面向界面的名称；省略时等于 id。 */
  readonly label: string;
  /** 当前节点状态。 */
  readonly status: AgentNodeStatus;
  /** 正常完成后的 JSON 对象；未完成时为 null。 */
  readonly result: JsonObject | null;
  /** 失败、中断或取消时的可诊断原因；正常完成时为 null。 */
  readonly diagnostic: string | null;
  /**
   * 最近一次执行器提示（例如停滞诊断），不改变业务状态，也不得当作失败依据；
   * null/缺省表示暂无提示。节点任意状态事件（agent.status / agent.completed /
   * agent.restarted）都会清空它，因此它只是“最后提示”，不是持久诊断。
   */
  readonly hint?: string | null;
  /** 节点创建、开始与终止时间；尚未发生时为 null。 */
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** 后续 Session Host 分配的会话身份；本阶段固定为 null。 */
  readonly agentSessionId: string | null;
  /** 当前业务型人工协助请求；非 blocked 节点固定为 null。 */
  readonly block: BlockSnapshot | null;
  /** 原始规范化请求，供 Journal / Replay 之后计算指纹。 */
  readonly request: NormalizedAgentRequest;
};

/** 某次实际进入已声明 Phase 的耐久查询视图。 */
export type PhaseVisitSnapshot = {
  /** 所属执行尝试。 */
  readonly executionAttemptId: number;
  /** 尝试内稳定阶段访问 id。 */
  readonly phaseVisitId: number;
  /** Phase 标题。 */
  readonly title: string;
  /** 同标题在本次尝试中的第几轮。 */
  readonly occurrence: number;
  /** 本轮创建的执行批次。 */
  readonly batches: readonly ExecutionBatchSnapshot[];
  /** 本轮创建时间。 */
  readonly createdAt: string;
};

/** 当前执行尝试中一个 Phase 的轻量摘要；不内联全部历史节点。 */
export type PhaseSummary = {
  /** Phase 标题。 */
  readonly title: string;
  /** 当前尝试内进入次数。 */
  readonly visits: number;
  /** 当前尝试内累计创建的 Agent 数。 */
  readonly agents: number;
  /** 各节点状态的聚合计数。 */
  readonly statusCounts: Readonly<Partial<Record<AgentNodeStatus, number>>>;
  /** 当前运行轮；没有活跃轮时为 null。 */
  readonly currentVisitId: number | null;
  /** 最近一个包含 Agent 的轮；没有时为 null。 */
  readonly latestVisitId: number | null;
};

/** 默认首页和 SSE 使用的当前尝试摘要。 */
export type CurrentAttemptSummary = {
  /** 当前执行尝试号。 */
  readonly executionAttemptId: number;
  /** 每个声明 Phase 的统计摘要。 */
  readonly phases: readonly PhaseSummary[];
  /** 最近一次发生变化的阶段访问；没有阶段访问时为 null。 */
  readonly latestPhaseVisitId: number | null;
};

/** Phase → Agent 视图中可展示的 pending block 摘要。 */
export type BlockSnapshot = {
  /** 原 Worker 请求的答案Schema；缺省允许JSON对象，Engine仍最终验证。 */
  readonly answerSchema?:JsonObject;
  /** 用于 answer / continue 绑定的稳定请求 id。 */
  readonly blockRequestId: string;
  /** Agent 为何无法安全继续、希望人如何帮助的说明。 */
  readonly needHelp: string;
  /** 人类答案是否已经耐久交付给原 Agent；不会自动恢复节点。 */
  readonly answered: boolean;
};

/** 受限 Workflow 脚本声明的业务决策门的查询视图；不属于任何 Agent 节点。 */
export type DecisionGateSnapshot = {
  /** Run 内稳定唯一的决策门 id。 */
  readonly gateId: string;
  /** 面向用户的问题说明。 */
  readonly question: string;
  /** 可选答案 JSON Schema；Engine 答题 action 按它校验。 */
  readonly answerSchema: JsonObject | undefined;
  /** 创建该 gate 的执行尝试与阶段访问；未进入阶段时为 null。 */
  readonly executionAttemptId: number;
  readonly phaseVisitId: number | null;
  /** 创建时间。 */
  readonly createdAt: string;
  /** 答案耐久时间；未回答时为 null。 */
  readonly answeredAt: string | null;
  /** 已耐久的 JSON 答案；未回答时为 null。 */
  readonly answer: JsonObject | null;
};

/** 一个 Phase 的查询投影；顺序与 Workflow meta 完全一致。 */
export type PhaseSnapshot = {
  /** Workflow meta 声明的唯一 Phase 标题。 */
  readonly title: string;
  /** 属于该 Phase 的节点，按调用序号排列。 */
  readonly agents: readonly AgentNodeSnapshot[];
  /** 按 Runtime 耐久批次分组的节点；Web 用于表达串行与并行布局。 */
  readonly batches: readonly ExecutionBatchSnapshot[];
};

/** 同一 Phase 内的一个已知调度批次。 */
export type ExecutionBatchSnapshot = {
  /** Run 内递增批次号。 */
  readonly sequence: number;
  /** serial 或 parallel 调度模式。 */
  readonly mode: "serial" | "parallel";
  /** 批次内按节点调用序排列。 */
  readonly agents: readonly AgentNodeSnapshot[];
};

/** Desktop 工作台消费的 Run 查询投影。 */
export type RunSnapshot = {
  /** Run 稳定 UUID。 */
  readonly id: string;
  /** 当前 Run 状态。 */
  readonly status: RunStatus;
  /** 已验证的 Workflow 元数据。 */
  readonly workflow: WorkflowMeta;
  /** 本次 Run 的 canonical 项目 cwd。 */
  readonly cwd: string;
  /** Run 创建与终止时间。 */
  readonly createdAt: string;
  readonly endedAt: string | null;
  /** Run 失败、中断或取消的诊断；正常运行或完成时为 null。 */
  readonly diagnostic: string | null;
  /** Phase → Agent 主视图。 */
  readonly phases: readonly PhaseSnapshot[];
  /** 当前耐久执行尝试；首次运行固定为 1。 */
  readonly currentExecutionAttemptId: number;
  /** 当前尝试的阶段访问；后续摘要 API 会替代完整内联历史。 */
  readonly phaseVisits: readonly PhaseVisitSnapshot[];
  /** 脚本声明的全部业务决策门；答案已耐久的 gate 一并保留供审计。 */
  readonly gates: readonly DecisionGateSnapshot[];
};
