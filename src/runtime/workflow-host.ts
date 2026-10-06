import type { JsonObject } from "../shared/json";
import type { NormalizedAgentRequest } from "../shared/workflow-types";

/** Runtime 已知的节点调度批次；仅表达可并发调度关系，不表示数据依赖。 */
export type ExecutionBatch = {
  /** Run 内递增批次号；同号节点属于同一批次。 */
  readonly sequence: number;
  /** serial 为顺序调用，parallel 为同一并发调用域。 */
  readonly mode: "serial" | "parallel";
};

/** 当前作者 phase() 返回给 Runtime 的稳定阶段访问身份。 */
export type PhaseVisit = {
  /** 所属执行尝试号。 */
  readonly executionAttemptId: number;
  /** 尝试内递增的阶段访问 id。 */
  readonly phaseVisitId: number;
  /** 当前 Phase 标题。 */
  readonly title: string;
  /** 当前标题在本次尝试中的第几轮。 */
  readonly occurrence: number;
};

/** Workflow 作者 API 在本阶段委派给 Runtime 的最小操作集合。 */
export interface WorkflowExecutionHost {
  /** 接收已验证的 Agent 请求及其调度批次；本阶段由内存宿主返回 JSON 对象或 null，不启动 CLI。 */
  agent(request: NormalizedAgentRequest, batch: ExecutionBatch, phaseVisit: PhaseVisit): Promise<JsonObject | null>;
  /** 接收已验证的 Phase 切换；后续状态机将据此建立 Phase → Agent 分组。 */
  phase(title: string): PhaseVisit;
  /** 接收作者日志；本阶段不解释文本，后续 Journal/Web 可消费该事件。 */
  log(message: string): void;
}
