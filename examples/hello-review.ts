import type { WorkflowContext, WorkflowMeta } from "../src/types";

export const meta: WorkflowMeta = {
  name: "hello-review",
  description: "Review one target with a single agent.",
  phases: ["review"],
  sideEffects: "none",
};

export default async function run(ctx: WorkflowContext, args: { target: string }) {
  return ctx.agent(`Review target: ${args.target}`, { label: "initial-review" });
}
