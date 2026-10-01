import type { JsonObject } from "../shared/json";
import type { NormalizedAgentRequest } from "../shared/workflow-types";

/** Workflow 作者 API 在本阶段委派给 Runtime 的最小操作集合。 */
export interface WorkflowExecutionHost {
  /** 接收已验证的 Agent 请求；本阶段由内存宿主返回 JSON 对象或 null，不启动 CLI。 */
  agent(request: NormalizedAgentRequest): Promise<JsonObject | null>;
  /** 接收已验证的 Phase 切换；后续状态机将据此建立 Phase → Agent 分组。 */
  phase(title: string): void;
  /** 接收作者日志；本阶段不解释文本，后续 Journal/Web 可消费该事件。 */
  log(message: string): void;
}
