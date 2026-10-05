import type { JsonObject } from "../shared/json";
import type { NormalizedAgentRequest, WorkflowMeta } from "../shared/workflow-types";
import type { AgentNodeStatus, RunStatus } from "../runtime/run-types";
import type { SessionIdentity } from "../sessions/types";

/** 当前耐久目录格式对应的 Runtime 版本；变更时 Resume 必须显式兼容。 */
export const RUNTIME_VERSION = 3;

/** 一次 Run 创建后不可变的耐久身份信息。 */
export type RunManifest = {
  /** Run 的 UUID；仅接受 Runtime 创建的标准 UUID。 */
  readonly runId: string;
  /** CLI 创建请求的稳定 UUID；响应丢失重试只能复用同一 Run。 */
  readonly clientRequestId: string;
  /** Manifest 格式与 Runtime 兼容版本。 */
  readonly runtimeVersion: number;
  /** 已验证 Workflow 元数据。 */
  readonly workflow: WorkflowMeta;
  /** Workflow 主文件内容 hash；后续 Resume 用于匹配。 */
  readonly workflowHash: string;
  /** realpath 后的 Workflow 文件，用于恢复时验证同一受信任源码。 */
  readonly workflowPath: string;
  /** Workflow 所属项目目录，用于相对节点 cwd 解析与恢复校验。 */
  readonly workflowProjectCwd: string;
  /** 本次 Workflow 的 JSON-safe 输入。 */
  readonly input: JsonObject;
  /** Run 创建时间。 */
  readonly createdAt: string;
};

/** 每条追加 Journal 事实共有的身份与诊断字段。 */
export type JournalBase = {
  /** 事实发生的 ISO 时间。 */
  readonly at: string;
  /** 所属 Run id。 */
  readonly runId: string;
  /** 所属节点；Run 级事件为 null。 */
  readonly nodeId: string | null;
  /** Session Host 会话身份；本阶段尚未分配，固定为 null。 */
  readonly agentSessionId: string | null;
  /** 便于诊断的稳定原因；无原因时为 null。 */
  readonly diagnostic: string | null;
};

/** 追加式 Journal 中允许的状态事实。 */
export type JournalEvent = JournalBase & ({
  readonly type: "run.created";
  readonly runStatus: "running";
} | {
  readonly type: "phase.changed";
  readonly title: string;
} | {
  readonly type: "log.written";
  readonly message: string;
} | {
  readonly type: "agent.created";
  readonly sequence: number;
  readonly phase: string | null;
  readonly request: NormalizedAgentRequest;
} | {
  readonly type: "agent.status";
  readonly status: AgentNodeStatus;
} | {
  /** 已确认首条任务投递的真实会话坐标；必须早于该节点的 complete。 */
  readonly type: "agent.session";
  /** 首条任务的实际投递通道。 */
  readonly delivery: "tmux" | "codex-rpc";
  /** Session Host 返回的完整稳定会话身份。 */
  readonly session: SessionIdentity;
  /** hybrid 投递的官方 thread/turn 坐标；普通 tmux 投递没有此字段。 */
  readonly appServer?: {
    readonly endpoint: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly protocolVersion: 1;
  };
} | {
  readonly type: "agent.completed";
  readonly resultPath: string;
  /** 可选 Schema 校验证据文件；Control complete 写入后必须随事件记录，开发执行器旧事件可省略。 */
  readonly validationPath?: string;
  /** 已写入结果文件的 JSON 对象副本，供 Journal 重建查询视图。 */
  readonly result: JsonObject;
} | {
  /** Agent 请求人工协助；状态机据此从 running 进入 blocked。 */
  readonly type: "block.created";
  /** 同一 Run 内稳定且全局不可猜的请求 id。 */
  readonly blockRequestId: string;
  /** 面向人的完整求助说明。 */
  readonly needHelp: string;
  /** 人类答案的可选 JSON Schema；未提供时接受任意 JSON 对象。 */
  readonly answerSchema?: JsonObject;
} | {
  /** 用户答案已经耐久保存；不改变 blocked 状态。 */
  readonly type: "block.answered";
  readonly blockRequestId: string;
  /** 已校验为 JSON 对象的人类答案。 */
  readonly answer: JsonObject;
} | {
  /** 原 Agent 确认已可继续，唯一合法的 blocked → running 迁移。 */
  readonly type: "agent.continued";
  readonly blockRequestId: string;
} | {
  readonly type: "run.status";
  readonly status: RunStatus;
});
