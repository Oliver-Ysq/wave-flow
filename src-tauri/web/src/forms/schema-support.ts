import Ajv from "ajv";

/** 表单答案的字段级错误；path 为点分路径（嵌套对象逐层连接），空串表示顶层错误。 */
export type SchemaFieldError = {
  /** 点分字段路径；无法定位到具体字段时为空串。 */
  path: string;
  /** 原始 JSON Pointer；字段名含点号/斜线时用于无歧义定位，历史调用方可忽略。 */
  pointer?: string;
  /** 面向用户的中文错误文案。 */
  message: string;
};

/** Schema 子集判定结果；supported=false 时 reason 给出面向用户的原因。 */
export type SchemaSupport =
  | { supported: true; reason: null }
  | { supported: false; reason: string };

/** 判定一个 JSON Schema 是否落在表单可渲染子集内（unknown 输入安全）。 */
export function isSupportedSchema(schema: unknown): SchemaSupport {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { supported: false, reason: "Schema 不是 JSON 对象" };
  }
  return checkNode(schema as Record<string, unknown>, "顶层");
}
/** 递归校验单个 Schema 节点；path 只用于错误文案定位。 */
function checkNode(node: Record<string, unknown>, path: string): SchemaSupport {
  const unsupported = (keyword: string): SchemaSupport => ({
    supported: false,
    reason: `${path}使用了暂不支持的 ${keyword}`,
  });
  for (const keyword of ["$ref", "anyOf", "oneOf", "allOf", "not", "if", "then", "else", "patternProperties", "dependencies"]) {
    if (keyword in node) return unsupported(keyword);
  }
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    return unsupported("additionalProperties（仅允许 false 或缺失）");
  }
  const type = node.type;
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      return unsupported("非空数组以外的 enum");
    }
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
      return unsupported("标量类型以外的 enum");
    }
  }
  switch (type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return { supported: true, reason: null };
    case "object": {
      const properties = node.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
        return unsupported("缺少 properties 的 object");
      }
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((item) => typeof item !== "string"))) {
        return unsupported("非字符串数组的 required");
      }
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        if (!child || typeof child !== "object" || Array.isArray(child)) {
          return { supported: false, reason: `${path}的字段 ${key} 不是合法 Schema` };
        }
        const result = checkNode(child as Record<string, unknown>, `${path}的字段 ${key}`);
        if (!result.supported) return result;
      }
      return { supported: true, reason: null };
    }
    default:
      return { supported: false, reason: `${path}的类型 ${String(type)} 暂不支持表单回答` };
  }
}

/** 为子集 Schema 生成初始空值：字符串/枚举空串、数值 null、布尔 null、对象递归。 */
export function initialValueFor(schema: Record<string, unknown>): unknown {
  switch (schema.type) {
    case "string":
    case "number":
    case "integer":
      return "";
    case "boolean":
      return null;
    case "object": {
      const value: Record<string, unknown> = {};
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [key, child] of Object.entries(properties)) {
        value[key] = initialValueFor(child);
      }
      return value;
    }
    default:
      return "";
  }
}

/** 把受控输入值按 Schema 类型归一化：数值字段空串按未填写处理，其余原样。 */
export function coerceValue(schema: Record<string, unknown>, value: unknown): unknown {
  switch (schema.type) {
    case "number":
    case "integer": {
      if (value === "" || value === null || value === undefined) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "string":
      return value === "" ? undefined : value;
    case "boolean":
      return value === null || value === undefined ? undefined : value;
    case "object": {
      const input = (value ?? {}) as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [key, child] of Object.entries(properties)) {
        const coerced = coerceValue(child, input[key]);
        if (coerced !== undefined) output[key] = coerced;
      }
      return output;
    }
    default:
      return value;
  }
}

/** ajv 实例与编译缓存；编译失败（非法 Schema）抛错，由调用方转为不支持提示。 */
const ajv = new Ajv({ allErrors: true, strict: false });

/** 用 ajv 整体校验答案，并把错误映射为字段级中文提示；合法时返回空数组。 */
export function validateAnswer(
  schema: Record<string, unknown>,
  value: unknown,
): SchemaFieldError[] {
  const validator = ajv.compile(schema);
  if (validator(value)) return [];
  return (validator.errors ?? []).map((error) => {
    const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
    if (error.keyword === "required") {
      const missing = (error.params as { missingProperty?: string }).missingProperty ?? "";
      return {
        path: basePath ? `${basePath}.${missing}` : missing,
        pointer: `${error.instancePath}/${missing.replace(/~/g,"~0").replace(/\//g,"~1")}`,
        message: "必填字段未填写",
      };
    }
    if (error.keyword === "type" || error.keyword === "enum") {
      return {
        path: basePath,
        pointer: error.instancePath,
        message:
          error.keyword === "enum"
            ? "取值不在允许范围内"
            : `请填写${({string:"文字",number:"数字",integer:"整数",boolean:"是或否",array:"列表",object:"有效参数",null:"空值"} as Record<string,string>)[String((error.params as {type?:unknown}).type)]??"有效值"}`,
      };
    }
    const limit=(error.params as {limit?:unknown}).limit;
    const messages:Record<string,string>={
      minLength:limit===1?"请填写内容":`至少填写 ${limit} 个字符`,maxLength:`最多填写 ${limit} 个字符`,
      minimum:`不能小于 ${limit}`,maximum:`不能大于 ${limit}`,exclusiveMinimum:`必须大于 ${limit}`,exclusiveMaximum:`必须小于 ${limit}`,
      minItems:`至少填写 ${limit} 项`,maxItems:`最多填写 ${limit} 项`,uniqueItems:"列表中不能有重复项",pattern:"内容格式不符合要求",additionalProperties:"包含未支持的参数",multipleOf:"数字步长不符合要求",
    };
    return { path: basePath, pointer:error.instancePath, message: messages[error.keyword]??"取值不符合参数要求" };
  });
}
