import type { WorkflowMeta, WorkflowModule } from "./types";

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * 在实际启动 Agent 前检查 Workflow 的静态声明。
 * @param value 待检查的未知值，通常是动态导入模块的 meta 导出。
 * @returns 成功时通过 TypeScript 的 asserts 将 value 收窄为 WorkflowMeta。
 * @throws meta 缺失、字段错误、名称非 kebab-case、描述多行、阶段为空/重复或副作用非法时抛出。
 */
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

/**
 * 取得 Workflow 实际可调用的入口函数。
 * @param workflow 已加载的 Workflow 模块；先查看 default，再兼容命名 run。
 * @returns 统一形状的异步执行函数，参数依次为 Runtime 上下文和本次运行参数。
 * @throws 模块既没有 default 函数也没有 run 函数时抛出，且此时尚未启动任何 Agent。
 */
export function getWorkflowRun<Args, Result>(
  workflow: WorkflowModule<Args, Result>,
): (ctx: Parameters<NonNullable<WorkflowModule<Args, Result>["default"]>>[0], args: Args) => Promise<Result> {
  // default 是推荐的 ESM 写法；保留 run 以兼容命名导出的 Workflow。
  if (typeof workflow.default === "function") return workflow.default;
  if (typeof workflow.run === "function") return workflow.run;
  throw new Error("Workflow must export a default function or run function.");
}
