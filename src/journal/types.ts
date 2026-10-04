import type { JsonObject } from "../shared/json";
import type { NormalizedAgentRequest, WorkflowMeta } from "../shared/workflow-types";
import type { AgentNodeStatus, RunStatus } from "../runtime/run-types";

/** 当前耐久目录格式对应的 Runtime 版本；变更时 Resume 必须显式兼容。 */
export const RUNTIME_VERSION = 1;

/** 一次 Run 创建后不可变的耐久身份信息。 */
export type RunManifest = {
  /** Run 的 UUID；仅接受 Runtime 创建的标准 UUID。 */
  readonly runId: string;
  /** Manifest 格式与 Runtime 兼容版本。 */
  readonly runtimeVersion: number;
  /** 已验证 Workflow 元数据。 */
  readonly workflow: WorkflowMeta;
  /** Workflow 主文件内容 hash；本阶段由调用方提供，后续 Resume 用于匹配。 */
  readonly workflowHash: string;
  /** 本次 Run 的 canonical 项目 cwd。 */
  readonly cwd: string;
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
  readonly type: "agent.completed";
  readonly resultPath: string;
  /** 可选 Schema 校验证据文件；Control complete 写入后必须随事件记录，开发执行器旧事件可省略。 */
  readonly validationPath?: string;
  /** 已写入结果文件的 JSON 对象副本，供 Journal 重建查询视图。 */
  readonly result: JsonObject;
} | {
  readonly type: "run.status";
  readonly status: RunStatus;
});
