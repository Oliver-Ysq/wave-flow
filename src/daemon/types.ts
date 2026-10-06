import type { JsonObject } from "../shared/json";
import type { CurrentAttemptSummary, PhaseVisitSnapshot, RunSnapshot } from "../runtime/run-types";

/** 创建 Run 的 loopback API 请求；Workflow 路径相对于 cwd 解析。 */
export type CreateRunRequest = {
  /** 当前 CLI 为本次创建生成的 UUID；网络响应丢失后的重试必须复用它。 */
  readonly clientRequestId: string;
  /** 用户明确指定的本地 TypeScript Workflow 路径。 */
  readonly workflowPath: string;
  /** 项目 cwd；daemon 以此限制 Workflow 和状态目录边界。 */
  readonly cwd: string;
  /** 传给 Workflow default run(args) 的 JSON-safe 对象。 */
  readonly input: JsonObject;
  /** 是否使用 Botmux 风格 App Server hybrid 投递；默认 true，Workflow 源码不可设置。 */
  readonly codexRpcInput?: boolean;
};

/** 创建或查询 Run 的 loopback API 响应。 */
export type RunResponse = {
  /** Journaled Run 的稳定 id。 */
  readonly runId: string;
  /** daemon 权威的 Phase → Agent 查询快照。 */
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

/** Run 当前执行尝试的轻量首页数据，不包含全部历史 Agent。 */
export type CurrentAttemptResponse = {
  /** Run 稳定 id。 */
  readonly runId: string;
  /** daemon 权威 Run 状态。 */
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

/** Run SSE 的轻量进度事件；详情需按 phaseVisitId 单独读取。 */
export type RunProgressEvent = {
  /** Run 稳定 id。 */
  readonly runId: string;
  /** daemon 权威 Run 状态。 */
  readonly status: RunSnapshot["status"];
  /** 当前尝试摘要。 */
  readonly summary: CurrentAttemptSummary;
};

/** 用户显式请求同一 Run 的调用级恢复；runId 仅来自 URL，避免客户端覆写 Manifest 身份。 */
export type ResumeRunRequest = {
  /** true 代表用户已确认允许从第一个 interrupted 节点创建新 attempt。 */
  readonly authorized: true;
};

/** 用户暂停当前 Run；RunId 仅来自 URL，防止客户端跨 Run 操作。 */
export type PauseRunRequest = Record<string, never>;
/** 用户恢复已暂停 Run；恢复会在原 thread 创建新 turn。 */
export type RecoverRunRequest = Record<string, never>;

/** daemon 接受优雅关闭请求后的确认；Run 不会被隐式标记为完成或回滚。 */
export type CloseDaemonResponse = {
  /** true 表示 daemon 已接受关闭安排，响应发送后将自行退出。 */
  readonly closing: true;
};
