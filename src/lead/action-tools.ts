import type { JsonObject } from "../shared/json";

/**
 * 主控可用的行动类窄工具回调。所有回调都由 Desktop Engine 侧服务实现：
 * 校验并 Journal 化后才生效；工具本身不持有 Runtime、Control 或 Journal 对象。
 */
export type LeadActionCallbacks = {
  /** 提交新的workflow草案；baseRevision绑定读取依据，单链已有版本必填，首版允许省略或0；只产生revision，不执行。 */
  readonly proposeWorkflowRevision: (source: string, goal?: string, scope?: string, parameters?: TemplateParameterProposal, baseRevision?: number) => Promise<{ readonly revision: number; readonly sourceHash: string }>;
  /** 查看本 Lead 的 Execution 登记或单个 Execution 的权威快照；省略 id 时返回列表。 */
  readonly inspectExecution: (executionId?: string) => Promise<unknown>;
  /** 读取有界Task或同Task原attempt证据；executionId与正整数attempt须同时提供，缺省总结回合使用原义务。 */
  readonly readRunCapsule: (executionId?: string, attempt?: number) => Promise<unknown>;
  /** 没有用户决定就不能安全继续时发起决策请求；阻塞等待已校验的 JSON 答案。 */
  readonly requestUserDecision: (question: string, answerSchema?: JsonObject) => Promise<JsonObject>;
};
/** 现有提案工具的模板参数模式；不赋予主控执行权或源码写权限。 */
export type TemplateParameterProposal = {
  /** 整理依据的当前候选版本；过期时拒绝，不覆盖新修改。 */ readonly baseRevision:number;
  /** 按冻结模板Schema完整校验的参数，不从exampleArgs推导契约。 */ readonly input:JsonObject;
};

/** ACP 主控行动类窄工具名称全集；服务硬门仅允许这四个名称，不授予 Worker 控制权。 */
export const LEAD_ACTION_TOOL_NAMES = ["propose_workflow_revision", "inspect_execution", "read_run_capsule", "request_user_decision"] as const;
