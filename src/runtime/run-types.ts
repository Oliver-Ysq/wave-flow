import type { JsonObject } from "../shared/json";
import type { AgentCli, AgentSandbox, NormalizedAgentRequest, WorkflowMeta } from "../shared/workflow-types";

/** Agent 节点在一次 Run 内可见的状态；终态不可回退。 */
export type AgentNodeStatus = "queued" | "running" | "waiting_for_input" | "completed" | "failed" | "cancelled" | "interrupted";

/** Run 的聚合终态；由节点终态与顶层 Workflow 诊断决定。 */
export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** 注入 Runtime 的可控节点执行器；本阶段不启动 CLI 或读取终端。 */
export type AgentNodeExecutor = {
  /** 执行一个已进入 running 的节点；对象表示完成，null 表示明确业务失败，抛错表示中断。 */
  execute(node: AgentNodeSnapshot): Promise<JsonObject | null>;
};

/** Agent 节点对执行器与查询层公开的不可变快照。 */
export type AgentNodeSnapshot = {
  /** Run 内唯一稳定节点 id。 */
  readonly id: string;
  /** 调用 agent() 时捕获的 Phase；未设置 Phase 时为 null。 */
  readonly phase: string | null;
  /** 同一 Run 内实际 agent() 调用顺序，从 1 开始。 */
  readonly sequence: number;
  /** 节点实际使用的 CLI。 */
  readonly cli: AgentCli;
  /** 节点实际使用的 sandbox。 */
  readonly sandbox: AgentSandbox;
  /** 已验证的项目内工作目录。 */
  readonly cwd: string;
  /** 面向界面的名称；省略时等于 id。 */
  readonly label: string;
  /** 当前节点状态。 */
  readonly status: AgentNodeStatus;
  /** 正常完成后的 JSON 对象；未完成时为 null。 */
  readonly result: JsonObject | null;
  /** 失败、中断或取消时的可诊断原因；正常完成时为 null。 */
  readonly diagnostic: string | null;
  /** 节点创建、开始与终止时间；尚未发生时为 null。 */
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** 后续 Session Host 分配的会话身份；本阶段固定为 null。 */
  readonly agentSessionId: string | null;
  /** 原始规范化请求，供 Journal / Replay 之后计算指纹。 */
  readonly request: NormalizedAgentRequest;
};

/** 一个 Phase 的查询投影；顺序与 Workflow meta 完全一致。 */
export type PhaseSnapshot = {
  /** Workflow meta 声明的唯一 Phase 标题。 */
  readonly title: string;
  /** 属于该 Phase 的节点，按调用序号排列。 */
  readonly agents: readonly AgentNodeSnapshot[];
};

/** Local Web 与后续 daemon 可消费的 Run 查询投影。 */
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
};
