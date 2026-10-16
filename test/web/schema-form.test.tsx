import { expect, test } from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {SchemaForm} from "../../src-tauri/web/src/forms/schema-form";
import {
  coerceValue,
  initialValueFor,
  isSupportedSchema,
  validateAnswer,
} from "../../src-tauri/web/src/forms/schema-support";

test("支持的子集：标量、enum、嵌套 object 与 required", () => {
  expect(isSupportedSchema({ type: "string" }).supported).toBe(true);
  expect(isSupportedSchema({ type: "integer" }).supported).toBe(true);
  expect(isSupportedSchema({ type: "boolean" }).supported).toBe(true);
  expect(isSupportedSchema({ type: "string", enum: ["a", "b"] }).supported).toBe(true);
  expect(
    isSupportedSchema({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        addr: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      required: ["name"],
      additionalProperties: false,
    }).supported,
  ).toBe(true);
});

test("不支持的 Schema 明确拒绝：数组、$ref、anyOf、additionalProperties true、非法输入", () => {
  expect(isSupportedSchema({ type: "array", items: { type: "string" } }).supported).toBe(false);
  expect(isSupportedSchema({ $ref: "#/definitions/x" }).supported).toBe(false);
  expect(isSupportedSchema({ anyOf: [{ type: "string" }] }).supported).toBe(false);
  expect(isSupportedSchema({ type: "object", properties: {}, additionalProperties: true }).supported).toBe(false);
  expect(isSupportedSchema(null).supported).toBe(false);
  expect(isSupportedSchema("string").supported).toBe(false);
  expect(isSupportedSchema({ type: "object" }).supported).toBe(false);
  // 嵌套深处的不支持也要被发现。
  const deep = isSupportedSchema({
    type: "object",
    properties: { x: { type: "object", properties: { y: { type: "array" } } } },
  });
  expect(deep.supported).toBe(false);
  if (!deep.supported) expect(deep.reason).toContain("array");
});

test("initialValueFor 与 coerceValue：空串按未填写处理，数值归一化", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
      ok: { type: "boolean" },
    },
    required: ["name"],
  } as Record<string, unknown>;
  const initial = initialValueFor(schema) as Record<string, unknown>;
  expect(initial).toEqual({ name: "", count: "", ok: null });
  const coerced = coerceValue(schema, { name: "甲", count: "3", ok: null }) as Record<string, unknown>;
  expect(coerced).toEqual({ name: "甲", count: 3 });
  // 未填写的可选字段不出现在提交值中。
  const partial = coerceValue(schema, { name: "甲", count: "", ok: null }) as Record<string, unknown>;
  expect(partial).toEqual({ name: "甲" });
});

test("validateAnswer：必填/类型/枚举错误定位到字段路径", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
      level: { type: "string", enum: ["高", "低"] },
      addr: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
    required: ["name", "count"],
  };
  expect(validateAnswer(schema, { name: "甲", count: 2 })).toEqual([]);
  const errors = validateAnswer(schema, { count: "x", level: "中", addr: {} });
  const byPath = new Map(errors.map((error) => [error.path, error.message]));
  expect(byPath.get("name")).toBe("必填字段未填写");
  expect(byPath.get("count")).toBe("请填写整数");
  expect(byPath.get("level")).toBe("取值不在允许范围内");
  expect(byPath.get("addr.city")).toBe("必填字段未填写");
});
test("SchemaForm显示字段描述与必填，不支持Schema不回退裸JSON",()=>{const html=renderToStaticMarkup(<SchemaForm schema={{type:"object",required:["ready"],properties:{ready:{type:"boolean",description:"是否继续"}}}} busy={false} onSubmit={async()=>{}}/>);expect(html).toContain("ready");expect(html).toContain("必填");expect(html).toContain("是否继续");const unsupported=renderToStaticMarkup(<SchemaForm schema={{type:"array"}} busy={false} onSubmit={async()=>{}}/>);expect(unsupported).toContain("暂不支持表单回答");expect(unsupported).not.toContain("答案 JSON");});
