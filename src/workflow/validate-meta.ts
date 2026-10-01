import { isJsonObject } from "../shared/json";
import type { WorkflowMeta } from "../shared/workflow-types";

const kebabCase = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** 验证动态导入后得到的 Workflow meta 值，防止绕过静态分析的非法模块。 */
export function validateWorkflowMeta(value: unknown): asserts value is WorkflowMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow meta 必须是对象。");
  if (!isJsonObject(value)) throw new Error("Workflow meta 必须完全由 JSON-safe 值组成。");
  const meta = value as Record<string, unknown>;
  if (typeof meta.name !== "string" || !kebabCase.test(meta.name)) throw new Error("Workflow meta.name 必须为 kebab-case。");
  if (typeof meta.description !== "string" || meta.description.trim() === "" || /[\r\n]/.test(meta.description)) {
    throw new Error("Workflow meta.description 必须为非空单行字符串。");
  }
  if (!Array.isArray(meta.phases) || meta.phases.length === 0 || meta.phases.some((phase) => !isPhase(phase))) {
    throw new Error("Workflow meta.phases 必须是非空的 { title } 数组。");
  }
  const titles = meta.phases.map((phase) => (phase as { title: string }).title);
  if (new Set(titles).size !== titles.length) throw new Error("Workflow meta.phases 的 title 必须唯一。");
  if ("exampleArgs" in meta && !isJsonObject(meta.exampleArgs)) throw new Error("Workflow meta.exampleArgs 必须是 JSON-safe 对象。");
}

function isPhase(value: unknown): value is { title: string } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as { title?: unknown }).title === "string"
    && (value as { title: string }).title.trim() !== "";
}
