import Ajv from "ajv";
import type { JsonObject } from "./json";
import type { JsonSchema } from "./workflow-types";

const ROOT_KEYS = new Set(["type", "title", "description", "properties", "required", "additionalProperties"]);
const COMMON_FIELD_KEYS = new Set(["type", "title", "description", "default"]);
const FIELD_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  string: new Set([...COMMON_FIELD_KEYS, "enum", "oneOf", "minLength", "maxLength", "format"]),
  number: new Set([...COMMON_FIELD_KEYS, "minimum", "maximum"]),
  integer: new Set([...COMMON_FIELD_KEYS, "minimum", "maximum"]),
  boolean: COMMON_FIELD_KEYS,
};

/**
 * 规范化 Worker 人工答案 Schema。
 *
 * 只接受 ACP Elicitation 与 Desktop 表单共同支持的扁平字段，返回带
 * `additionalProperties: false` 的副本。任何无法完整表达的约束都在
 * `block.created` 前失败，避免产生用户无法回答的 Journal 事实。
 */
export function normalizeHitlAnswerSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("wave_flow_block 必须提供 answerSchema。 ");
  if (schema.type !== "object") throw new Error("answerSchema 根 type 必须是 object。 ");
  assertKeys(schema, ROOT_KEYS, "answerSchema");
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) throw new Error("answerSchema.properties 必须是对象。 ");
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) throw new Error("answerSchema 至少需要一个命名字段。 ");
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error("answerSchema 不允许 additionalProperties。 ");
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string")) throw new Error("answerSchema.required 必须是字符串数组。 ");
    const required = schema.required as string[];
    if (new Set(required).size !== required.length) throw new Error("answerSchema.required 不得重复。 ");
    for (const key of required) if (!entries.some(([name]) => name === key)) throw new Error(`answerSchema.required 包含未知字段：${key}`);
  }
  const properties = Object.fromEntries(entries.map(([name, field]) => {
    if (!name.trim()) throw new Error("answerSchema 字段名不能为空。 ");
    return [name, normalizeField(name, field)];
  }));
  const normalized: JsonObject = {
    ...schema,
    type: "object",
    properties,
    additionalProperties: false,
  };
  new Ajv({ allErrors: true, strict: false }).compile(normalized);
  return normalized as JsonSchema;
}

function normalizeField(name: string, field: unknown): JsonObject {
  if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error(`字段 ${name} 的 Schema 必须是对象。`);
  const value = field as JsonObject;
  const type = value.type;
  if (typeof type !== "string" || !Object.hasOwn(FIELD_KEYS, type)) throw new Error(`字段 ${name} 只支持 string、number、integer 或 boolean。`);
  assertKeys(value, FIELD_KEYS[type]!, `字段 ${name}`);
  validateDefault(name, type, value.default);
  if (type === "string" && value.format !== undefined && !["email", "uri", "date", "date-time"].includes(value.format as string)) throw new Error(`字段 ${name} 的 format 只支持 email、uri、date 或 date-time。`);
  if (value.enum !== undefined) {
    if (type !== "string" || !Array.isArray(value.enum) || value.enum.length === 0 || value.enum.some(option => typeof option !== "string")) throw new Error(`字段 ${name} 的 enum 必须是非空字符串数组。`);
    if (new Set(value.enum).size !== value.enum.length) throw new Error(`字段 ${name} 的 enum 不得重复。`);
    if (value.default !== undefined && !value.enum.includes(value.default as string)) throw new Error(`字段 ${name} 的 default 必须属于 enum。`);
  }
  if (value.oneOf !== undefined) {
    if (type !== "string" || !Array.isArray(value.oneOf) || value.oneOf.length === 0) throw new Error(`字段 ${name} 的 oneOf 必须是非空字符串枚举。`);
    const options = new Set<string>();
    for (const option of value.oneOf) {
      if (!option || typeof option !== "object" || Array.isArray(option) || typeof (option as JsonObject).const !== "string" || typeof (option as JsonObject).title !== "string") throw new Error(`字段 ${name} 的 oneOf 选项必须包含字符串 const 和 title。`);
      assertKeys(option as JsonObject, new Set(["const", "title", "description"]), `字段 ${name} 的 oneOf 选项`);
      const constant = (option as JsonObject).const as string;
      if (options.has(constant)) throw new Error(`字段 ${name} 的 oneOf 选项值不得重复。`);
      options.add(constant);
    }
    if (value.default !== undefined && !options.has(value.default as string)) throw new Error(`字段 ${name} 的 default 必须属于 oneOf。`);
  }
  if (value.enum !== undefined && value.oneOf !== undefined) throw new Error(`字段 ${name} 不能同时声明 enum 和 oneOf。`);
  return value;
}

function validateDefault(name: string, type: string, value: unknown): void {
  if (value === undefined) return;
  if (type === "string" && typeof value !== "string") throw new Error(`字段 ${name} 的 default 必须是 string。`);
  if ((type === "number" || type === "integer") && (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isSafeInteger(value)))) throw new Error(`字段 ${name} 的 default 必须是 ${type}。`);
  if (type === "boolean" && typeof value !== "boolean") throw new Error(`字段 ${name} 的 default 必须是 boolean。`);
}

function assertKeys(value: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} 包含不支持的约束：${key}`);
}
