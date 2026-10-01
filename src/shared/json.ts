/** JSON 中允许出现的标量值。 */
export type JsonPrimitive = string | number | boolean | null;

/** 可安全序列化、写入结果文件或传递给下游节点的 JSON 值。 */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** 键为字符串且值为 JSON-safe 的对象。 */
export type JsonObject = { readonly [key: string]: JsonValue };

/** 判断未知值是否可安全表示为有限、无循环引用的 JSON 值。 */
export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

/** 判断未知值是否为 JSON-safe 对象，供 meta.exampleArgs 与 agent.input 使用。 */
export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}
