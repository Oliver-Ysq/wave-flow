import { createHash } from "node:crypto";

/** 对 JSON 安全值做稳定序列化，保证对象键顺序不影响回放匹配。 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

/** @param value 可序列化输入。@returns SHA-256 十六进制摘要。 */
export function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
