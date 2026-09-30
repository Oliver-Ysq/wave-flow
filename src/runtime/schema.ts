import Ajv, { type ErrorObject } from "ajv";

/** 单例 Ajv 编译器；只校验标准 JSON Schema，不加载远程 schema 或自定义代码。 */
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * 将 Agent 的最终文本解析并验证为结构化结果。
 * @param output Adapter 返回的最终文本。
 * @param schema Workflow 传入的 JSON Schema。
 * @returns 通过 JSON.parse 与 Ajv 校验后的结构化值。
 * @throws 文本不是 JSON 或实际值不满足 Schema 时抛出，阻止不可靠结果进入下游。
 */
export function parseStructuredOutput<T>(output: string, schema: object): T {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Agent 结构化输出不是合法 JSON。");
  }

  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(`Agent 结构化输出不满足 JSON Schema：${formatErrors(validate.errors)}`);
  }
  return value as T;
}

/** @param errors Ajv 的机器错误列表。@returns 面向 Workflow 作者的紧凑字段错误摘要。 */
function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "未知校验错误";
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
    .join("; ");
}
