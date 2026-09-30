import type { WorkflowContext, WorkflowMeta } from "../src/workflow/types";

/**
 * 可执行的结构化输出示例。Schema 是 Runtime 契约；Readiness 类型是 Workflow 作者的开发期提示，
 * 两者需要保持一致，Runtime 会在下游收到结果前使用 Ajv 再次验证实际 JSON。
 */
type Readiness = {
  canProceed: boolean;
  issues: string[];
  verification: {
    status: "passed" | "failed" | "not_run" | "blocked_by_environment";
    reason: string;
  };
};

const readinessSchema = {
  type: "object",
  required: ["canProceed", "issues", "verification"],
  additionalProperties: false,
  properties: {
    canProceed: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    verification: {
      type: "object",
      required: ["status", "reason"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["passed", "failed", "not_run", "blocked_by_environment"] },
        reason: { type: "string" },
      },
    },
  },
};

export const meta: WorkflowMeta = {
  name: "readiness-check",
  description: "Check whether a target is ready for the next workflow step.",
  phases: ["check"],
  sideEffects: "none",
};

/** @param ctx Runtime 注入的受控 Workflow API。@param args 要检查的目标。 */
export default async function run(ctx: WorkflowContext, args: { target: string }) {
  return ctx.agent<Readiness>(
    `Inspect ${args.target}. Return whether the next workflow step can proceed and list concrete blocking issues. ` +
      `Also report verification.status: use passed only if validation actually passed; failed only if validation actually ran and failed; ` +
      `not_run if no validation was attempted; blocked_by_environment if sandbox, permissions, dependencies, or environment prevented validation. ` +
      `Do not treat blocked_by_environment as a code failure.`,
    { label: "readiness-check", schema: readinessSchema },
  );
}
