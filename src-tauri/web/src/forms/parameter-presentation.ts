import { validateAnswer, type SchemaFieldError } from "./schema-support";

/** 参数展示分组；只折叠可选字段和具有合法显式默认值的必填字段，不修改参数或 Schema。 */
export function parameterGroups(schema: Record<string, unknown>): { primary: string[]; advanced: string[] } {
  const fields = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required as string[] ?? []).filter(key => fields[key]);
  const defaultIsValid = (key: string) => {
    const node = fields[key];
    if (!Object.hasOwn(node, "default")) return false;
    try {
      return validateAnswer({ type: "object", properties: { [key]: node }, required: [key] }, { [key]: node.default }).length === 0;
    } catch { return false; }
  };
  const primary = required.filter(key => !defaultIsValid(key));
  return { primary, advanced: [...required.filter(defaultIsValid), ...Object.keys(fields).filter(key => !required.includes(key))] };
}

/** 从原 JSON Pointer 读取顶层字段身份；无法定位的根级错误返回 undefined，不猜测字段。 */
export function parameterErrorKey(error: SchemaFieldError, fields: Record<string, unknown>): string | undefined {
  return error.pointer === undefined ? (Object.hasOwn(fields, error.path) ? error.path : undefined)
    : error.pointer.startsWith("/") ? error.pointer.split("/")[1]?.replace(/~1/g, "/").replace(/~0/g, "~") : undefined;
}

/** 表单层动作指引；保留非空值的原校验原因，不改变完整 AJV/Engine 校验结果。 */
export function parameterErrorMessage(error: SchemaFieldError, node: Record<string, unknown> | undefined, label: string, value: unknown): string {
  if (!node || ![undefined, null, ""].includes(value as undefined | null | string)) return error.message;
  if (Array.isArray(node.enum)) return `请选择${label}`;
  const type = Array.isArray(node.type) ? node.type.find(item => item !== "null") : node.type;
  if (type === "boolean") return "请选择是或否";
  if (type === "number" || type === "integer") {
    const range = typeof node.minimum === "number" && typeof node.maximum === "number" ? ` ${node.minimum}–${node.maximum}` : "";
    return `请输入${range}${type === "integer" ? " 的整数" : " 的数字"}`.replace("请输入 的", "请输入");
  }
  return type === "string" ? `请填写${label}` : error.message;
}
