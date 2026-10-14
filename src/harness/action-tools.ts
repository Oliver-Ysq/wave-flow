import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { JsonObject } from "../shared/json";

/**
 * 主控可用的行动类窄工具回调。所有回调都由 Desktop Engine 侧服务实现：
 * 校验并 Journal 化后才生效；工具本身不持有 Runtime、Control 或 Journal 对象。
 */
export type HarnessActionCallbacks = {
  /** 提交新的 workflow.ts 草案；只产生耐久 revision，不创建执行。 */
  readonly proposeWorkflowRevision: (source: string) => Promise<{ readonly revision: number; readonly sourceHash: string }>;
  /** 查看本 Harness 的 Execution 登记或单个 Execution 的权威快照；省略 id 时返回列表。 */
  readonly inspectExecution: (executionId?: string) => Promise<unknown>;
  /** 读取本任务的耐久 capsule：消息摘要、revision 与 Execution 状态。 */
  readonly readRunCapsule: () => Promise<unknown>;
  /** 没有用户决定就不能安全继续时发起决策请求；阻塞等待已校验的 JSON 答案。 */
  readonly requestUserDecision: (question: string, answerSchema?: JsonObject) => Promise<JsonObject>;
};

/** 行动类窄工具名称全集；Pi beforeToolCall 硬门只放行已注册工具名。 */
export const HARNESS_ACTION_TOOL_NAMES = ["propose_workflow_revision", "inspect_execution", "read_run_capsule", "request_user_decision"] as const;

/** 创建主控的行动类窄工具；参数经 typebox 约束，返回值统一 JSON 文本。 */
export function createHarnessActionTools(actions: HarnessActionCallbacks): AgentTool[] {
  return [
    {
      name: "propose_workflow_revision",
      label: "提议 Workflow 草案",
      description: "提交一份新的受限 workflow TypeScript 草案，返回 revision 序号与源码 hash。草案只在用户于界面明确接受后才可能创建 Execution；本工具不会执行任何代码、不会创建 Worker。",
      parameters: Type.Object({ source: Type.String({ description: "受限 workflow.ts 源码：顶层只有纯字面量 meta 与 async function run(args)，只能调用 agent/phase/parallel/pipeline/log/decisionGate" }) }),
      execute: async (_id, params) => {
        const { source } = params as { source: string };
        const result = await actions.proposeWorkflowRevision(source);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { operation: "propose_workflow_revision", ...result } };
      },
      executionMode: "sequential",
    },
    {
      name: "inspect_execution",
      label: "查看 Execution 状态",
      description: "读取本任务 WorkflowExecution 的耐久登记与权威快照：状态、节点、决策门与摘要。省略 executionId 时返回全部 Execution 列表。",
      parameters: Type.Object({ executionId: Type.Optional(Type.String({ description: "Execution UUID；省略时列出全部" })) }),
      execute: async (_id, params) => {
        const { executionId } = params as { executionId?: string };
        const result = await actions.inspectExecution(executionId);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { operation: "inspect_execution", executionId: executionId ?? null } };
      },
      executionMode: "sequential",
    },
    {
      name: "read_run_capsule",
      label: "读取任务 capsule",
      description: "读取本任务的耐久 capsule：对话摘要、全部 workflow revision 状态与 Execution 结果摘要。用于回合恢复或汇总时对齐已验证事实，不要凭记忆声称状态。",
      parameters: Type.Object({}),
      execute: async () => {
        const result = await actions.readRunCapsule();
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { operation: "read_run_capsule" } };
      },
      executionMode: "sequential",
    },
    {
      name: "request_user_decision",
      label: "请求用户决策",
      description: "仅当没有用户决定就无法安全继续时使用。提出完整问题与可选答案 JSON Schema，阻塞等待用户在界面的回答；普通工具错误或环境问题应自行处理，不要升级为用户决策。",
      parameters: Type.Object({
        question: Type.String({ description: "面向用户的完整问题：为什么必须有人类决定、可选方案与影响" }),
        answerSchema: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "答案 JSON Schema；省略时接受任意 JSON 对象" })),
      }),
      execute: async (_id, params) => {
        const { question, answerSchema } = params as { question: string; answerSchema?: JsonObject };
        const answer = await actions.requestUserDecision(question, answerSchema);
        return { content: [{ type: "text", text: JSON.stringify({ answer }) }], details: { operation: "request_user_decision" } };
      },
      executionMode: "sequential",
    },
  ];
}
