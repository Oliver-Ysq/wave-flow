import type { WorkflowContext, WorkflowMeta } from "../src/workflow/types";

/** 并行审查示例：第七课 resume 时，每个已完成的审查节点会从同一 run Journal 回放。 */
export const meta: WorkflowMeta = {
  name: "parallel-review",
  description: "Review one target from independent perspectives.",
  phases: ["review"],
  sideEffects: "none",
};

export default async function run(ctx: WorkflowContext, args: { target: string }) {
  return ctx.parallel([
    () => ctx.agent(`Review ${args.target} for security issues.`, { label: "security-review" }),
    () => ctx.agent(`Review ${args.target} for correctness issues.`, { label: "correctness-review" }),
  ]);
}
