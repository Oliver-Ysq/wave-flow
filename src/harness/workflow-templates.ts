import { createHash } from "node:crypto";
import Ajv from "ajv";
import { isJsonObject, type JsonObject } from "../shared/json";
import type { WorkflowMeta } from "../shared/workflow-types";
import {validateWorkflowMeta} from "../workflow/validate-meta";
import { inspectWorkflowModuleSource } from "../workflow/preflight-local";
// 内置预置的编排脚本以独立 TypeScript 模块维护：模块可单独审阅、复用与类型检查，
// 由 src/harness/template-sources.js 按文本内嵌进 Engine 单二进制，主控会话 cwd 是用户项目时也读得到。
// 这些文件是作者模块形态（import wave-flow、export meta、默认导出 run），
// 不参与主工程的类型检查，另由 src/harness/templates/tsconfig.json 单独检查。
// 文件内容即模块源码本体，模板身份按文件字节计算。
import { templateSources } from "./template-sources.js";

/** 内置目录的不可变版本；Schema 是目录契约，不从示例或模型推测。 */
export type WorkflowTemplate = {
  /** kebab-case 稳定模板身份；同用途升级不改身份。 */
  readonly id: string;
  /** 正整数目录版本；源码或 Schema 变化必须升级。 */
  readonly version: number;
  /** 模块源码 SHA-256；启动读取已保存源码而不是最新目录。 */
  readonly sourceHash: string;
  /** 模块 TypeScript 原文，不允许 URL 或顶层副作用。 */
  readonly source: string;
  /** 从源码静态解析得到的 meta；只用于展示。 */
  readonly meta: WorkflowMeta;
  /** run(args) 的对象 Schema；全输入采用 AJV 校验，不修改输入或填默认。 */
  readonly inputSchema: JsonObject;
  /** 用户可见的用途、权限和限制。 */
  readonly explanation: string;
};

/** 保存的来源快照；不带第二份源码，绑定所属 revision.sourceHash。 */
export type TemplateOrigin = Omit<WorkflowTemplate, "source">;

/** 规范 JSON 指纹，不受对象键插入顺序影响；调用前必须验证 JSON-safe。 */
export function canonicalJson(value: unknown): string {
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if(value!==null&&typeof value==="object") return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson((value as Record<string,unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** 验证未知目录选择载荷，不允许夹带源码、Schema 或未来字段。 */
export function isTemplateSelection(value: unknown): value is import("./task-contract").TemplateSelection {
  return isJsonObject(value)&&Object.keys(value).every(key=>["id","version","sourceHash","input","needsGuidance"].includes(key))&&(value.needsGuidance===undefined||typeof value.needsGuidance==="boolean")&&typeof value.id==="string"&&/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value.id)&&Number.isInteger(value.version)&&(value.version as number)>0&&/^[a-f0-9]{64}$/.test(String(value.sourceHash))&&isJsonObject(value.input);
}

/** 重放仅验证冻结快照，不查询最新目录；目录升级不会改历史批准。 */
export function isTemplateOrigin(value: unknown): value is TemplateOrigin {
  if(!isJsonObject(value)||typeof value.id!=="string"||!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value.id)||!Number.isInteger(value.version)||(value.version as number)<1||!/^[a-f0-9]{64}$/.test(String(value.sourceHash))||typeof value.explanation!=="string"||!value.explanation.trim()||!isJsonObject(value.meta)||!isJsonObject(value.inputSchema)||value.inputSchema.type!=="object") return false;
  try {validateWorkflowMeta(value.meta);ajv.compile(value.inputSchema);return true;} catch {return false;}
}

const ajv = new Ajv({ allErrors: true, strict: false });

/** 目录静态校验与 Schema 验证不运行 run()，也不创建 Worker；Schema 以源码 meta 为唯一来源。 */
export function defineTemplate(id: string, version: number, source: string, explanation: string): WorkflowTemplate {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id) || !Number.isInteger(version) || version < 1 || !explanation.trim()) throw new Error("模板目录身份无效。");
  const { meta, inputSchema } = inspectWorkflowModuleSource(source, `${id}.ts`, "内置模板");
  if (meta.name !== id) throw new Error("内置模板 meta.name 必须匹配目录 id。");
  return { id, version, source, sourceHash: createHash("sha256").update(source).digest("hex"), meta, inputSchema, explanation };
}

/** 失败保留原输入；校验只证明输入形状，不证明任务完成或路径安全。 */
export function validateTemplateInput(schema: JsonObject, input: unknown): asserts input is JsonObject {
  if (!isJsonObject(input)) throw new Error("工作流参数必须是 JSON-safe 对象。");
  const validator = ajv.compile(schema);
  if (!validator(input)) throw new Error(`工作流参数无效：${ajv.errorsText(validator.errors, { separator: "；", dataVar: "参数" })}`);
}

/** 取目录内某个预置的模块源码；缺失或为空立刻失败，不静默产出空模板。 */
function templateSource(id: string): string {
  const source = templateSources[id];
  if (typeof source !== "string" || !source.trim()) throw new Error(`内置预置源码缺失：${id}`);
  return source;
}

const codeReview = defineTemplate("code-review", 3, templateSource("code-review"), "两个顺序只读 Worker：先审查，再独立复核。只检查明确指定的范围，不修改文件；结果不代表全仓库已验证。");

const deepResearch = defineTemplate("deep-research", 4, templateSource("deep-research"), "深度调研：计划 Agent 把主题拆解为研究问题并经你确认后，并行多源调研；每条结论由独立核验员重新打开原始来源复核；交叉检查矛盾、证据家族与单源风险；deep 模式按缺口做第二轮定向补证；最后撰写-红队-修订产出带引用与置信度分级的报告。全程只读，不修改文件。");

const deepCr = defineTemplate("deep-cr", 5, templateSource("deep-cr"), "深度代码审查：先摸底变更面、模块结构与仓库审查规范；六个专项审查员(正确性/安全/并发与状态/错误处理与资源/接口与数据兼容/意图与测试)并行审查；每个发现由独立复核员重新打开源码逐条核实并剔除误报；交叉裁决去重排序并给出合并建议；盲区扫描披露未被覆盖的高风险文件；最终产出带证据、触发场景与修复建议的分级报告。全程只读，不修改文件、不运行构建或测试。");

/** 返回独立 JSON 快照，调用方不能修改进程内目录。 */
export function listWorkflowTemplates(): readonly WorkflowTemplate[] {
  return structuredClone([codeReview, deepResearch, deepCr]);
}

/** 精确版本/hash 选择；失配必须重新选择，不能静默升级。 */
export function resolveWorkflowTemplate(id: string, version: number, sourceHash: string): WorkflowTemplate {
  const template = listWorkflowTemplates().find(item => item.id === id && item.version === version && item.sourceHash === sourceHash);
  if (!template) throw new Error("模板版本不存在或已变化，请重新选择模板。");
  return template;
}
