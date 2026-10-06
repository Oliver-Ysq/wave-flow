import type { JsonObject } from "../shared/json";
import type { NormalizedAgentRequest, WorkflowMeta } from "../shared/workflow-types";
import type { AgentNodeStatus, RunStatus } from "../runtime/run-types";
import type { SessionIdentity } from "../sessions/types";

/** 当前耐久目录格式对应的 Runtime 版本；变更时 Resume 必须显式兼容。 */
export const RUNTIME_VERSION = 6;
/** 当前实现可安全读取的历史耐久格式；旧格式只读兼容，不允许追加新的 Replay attempt。 */
export const COMPATIBLE_RUNTIME_VERSIONS = [3, 4, 5, RUNTIME_VERSION] as const;

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
  /** 一次实际执行路径的开始；纯复用 resume 不产生该事实。 */
  readonly type: "execution-attempt.started";
  /** Run 内递增的执行尝试号；首次运行固定为 1。 */
  readonly executionAttemptId: number;
} | {
  /** 一次进入已声明 Phase 的耐久事实；即使本轮没有 Agent 也保留。 */
  readonly type: "phase.entered";
  /** 所属执行尝试。 */
  readonly executionAttemptId: number;
  /** 尝试内递增、稳定的阶段访问 id。 */
  readonly phaseVisitId: number;
  /** 已声明的 Phase 标题。 */
  readonly title: string;
  /** 同标题在本次尝试中的进入轮次，从 1 开始。 */
  readonly occurrence: number;
} | {
  readonly type: "phase.changed";
  readonly title: string;
} | {
  readonly type: "log.written";
  readonly message: string;
} | {
  readonly type: "agent.created";
  /** Journal 展示顺序；动态分支的新节点从历史最大值继续。 */
  readonly sequence: number;
  /** Workflow 中本次实际 agent() 调用位置；v3/v4 省略时等于 sequence。 */
  readonly logicalSequence?: number;
  readonly phase: string | null;
  /** 创建该节点的实际执行尝试。 */
  readonly executionAttemptId?: number;
  /** 节点所属的稳定阶段访问；旧 Journal 缺失时只读兼容投影。 */
  readonly phaseVisitId?: number;
  /** Runtime 已知的调度批次；v5 缺失时只读兼容投影为单节点 serial 批次。 */
  readonly executionBatch?: import("../runtime/workflow-host").ExecutionBatch;
  readonly request: NormalizedAgentRequest;
} | {
  /** 用户显式 resume 后，为同一逻辑节点创建新的真实执行尝试。 */
  readonly type: "agent.restarted";
  /** 与原 agent.created 相同的稳定节点 id。 */
  readonly sequence: number;
  /** Workflow 中本次实际 agent() 调用位置；用于后续再次 resume。 */
  readonly logicalSequence?: number;
  /** 新 attempt 的会话身份；不得复用旧会话 id。 */
  readonly newAgentSessionId: string;
  /** true 表示此前已有节点不能复用，当前 completed 旧结果也必须随下游重新执行。 */
  readonly invalidatedByPriorRestart: boolean;
  /** 新 attempt 所属执行尝试。 */
  readonly executionAttemptId?: number;
  /** 新 attempt 所属阶段访问。 */
  readonly phaseVisitId?: number;
  /** 当前重新执行时验证到的请求；必须与原请求完全一致。 */
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
  /** paused 后同一 thread 的新继续回合；不创建新 Agent attempt。 */
  readonly type: "agent.recovered";
  /** 原 session 不变，只有当前 App Server turn 坐标更新。 */
  readonly appServer: {
    readonly endpoint: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly protocolVersion: 1;
  };
} | {
  /** recover 后重建的 tmux viewer；替换旧 viewer 坐标，不改变 Agent session 身份。 */
  readonly type: "agent.viewer";
  /** 新 viewer 的完整受管会话身份，用于 daemon 重启后的精确认领。 */
  readonly session: SessionIdentity;
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
