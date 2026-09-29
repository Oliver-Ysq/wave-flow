import type { WorkflowMeta, WorkflowModule } from "./types";

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function validateMeta(value: unknown): asserts value is WorkflowMeta {
  if (!value || typeof value !== "object") {
    throw new Error("Workflow must export a meta object.");
  }

  const meta = value as Record<string, unknown>;
  if (typeof meta.name !== "string" || !KEBAB_CASE.test(meta.name)) {
    throw new Error("Workflow meta.name must be kebab-case.");
  }
  if (
    typeof meta.description !== "string" ||
    meta.description.trim() === "" ||
    /[\r\n]/.test(meta.description)
  ) {
    throw new Error("Workflow meta.description must be a non-empty single line.");
  }
  if (
    !Array.isArray(meta.phases) ||
    meta.phases.length === 0 ||
    meta.phases.some((phase) => typeof phase !== "string" || phase.trim() === "") ||
    new Set(meta.phases).size !== meta.phases.length
  ) {
    throw new Error("Workflow meta.phases must contain unique, non-empty names.");
  }
  if (meta.sideEffects !== "none" && meta.sideEffects !== "workspace") {
    throw new Error("Workflow meta.sideEffects must be none or workspace.");
  }
}

export function getWorkflowRun<Args, Result>(
  workflow: WorkflowModule<Args, Result>,
): (ctx: Parameters<NonNullable<WorkflowModule<Args, Result>["default"]>>[0], args: Args) => Promise<Result> {
  if (typeof workflow.default === "function") return workflow.default;
  if (typeof workflow.run === "function") return workflow.run;
  throw new Error("Workflow must export a default function or run function.");
}
