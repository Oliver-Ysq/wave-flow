import type { WorkflowContext, WorkflowMeta } from "../src/workflow/types";

/**
 * 最小 Workflow 示例：meta 供 Runtime 启动前预检，run 只表达确定性编排。
 * 真正的 Agent 由 Runtime 注入的 ctx.agent() 启动，而不是此模块自行创建。
 */
export const meta: WorkflowMeta = {
  name: "hello-review",
  description: "Review one target with a single agent.",
  phases: ["review"],
  sideEffects: "none",
};

export default async function run(ctx: WorkflowContext, args: { target: string }) {
  // Prompt 是 Workflow 的语义，label 是 Runtime 用于事件与未来回放的稳定节点标识。
  return ctx.agent(`Review target: ${args.target}`, { label: "initial-review" });
}
