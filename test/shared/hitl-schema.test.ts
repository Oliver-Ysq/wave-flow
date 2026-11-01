import { describe, expect, test } from "bun:test";
import { normalizeHitlAnswerSchema } from "../../src/shared/hitl-schema";

describe("HITL answerSchema", () => {
  test("规范化扁平标量与单选字段并禁止额外字段", () => {
    const schema = normalizeHitlAnswerSchema({
      type: "object",
      properties: {
        approved: { type: "boolean" },
        count: { type: "integer", minimum: 1 },
        mode: { type: "string", enum: ["safe", "fast"] },
      },
      required: ["approved"],
    });
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["approved"] });
  });

  test("缺失 Schema、空字段与嵌套结构在落盘前拒绝", () => {
    expect(() => normalizeHitlAnswerSchema(undefined)).toThrow("必须提供");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: {} })).toThrow("至少需要一个命名字段");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { nested: { type: "object", properties: {} } } })).toThrow("只支持");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { items: { type: "array" } } })).toThrow("只支持");
  });

  test("拒绝动态字段、条件约束和多选", () => {
    expect(() => normalizeHitlAnswerSchema({ type: "object", additionalProperties: true, properties: { approved: { type: "boolean" } } })).toThrow("additionalProperties");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { approved: { type: "boolean" } }, if: { type: "object" } })).toThrow("不支持的约束");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { choices: { type: "string", oneOf: [{ const: 1 }] } } })).toThrow("字符串 const");
  });

  test("重复单选值和自由正则在落盘前拒绝", () => {
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { choice: { type: "string", oneOf: [{ const: "yes", title: "是" }, { const: "yes", title: "确认" }] } }, required: ["choice"] })).toThrow("不得重复");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { value: { type: "string", pattern: "^(a+)+$" } } })).toThrow("不支持的约束");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { value: { type: "constructor" } } })).toThrow("只支持");
  });

  test("只接受 ACP 可往返的约束、默认值和带标题单选", () => {
    expect(normalizeHitlAnswerSchema({ type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 5, default: 2 }, contact: { type: "string", format: "email" }, choice: { type: "string", oneOf: [{ const: "a", title: "甲" }], default: "a" } } })).toMatchObject({ type: "object" });
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { count: { type: "number", multipleOf: 2 } } })).toThrow("不支持的约束");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { count: { type: "integer", exclusiveMinimum: 1 } } })).toThrow("不支持的约束");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { secret: { type: "string", format: "password" } } })).toThrow("format");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { choice: { type: "string", oneOf: [{ const: "a" }] } } })).toThrow("title");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { count: { type: "integer", default: "2" } } })).toThrow("default");
    expect(() => normalizeHitlAnswerSchema({ type: "object", properties: { choice: { type: "string", enum: ["a"], default: "b" } } })).toThrow("属于 enum");
  });

  test("__proto__ 作为普通字段名保留且可编译", () => {
    const properties = JSON.parse('{"__proto__":{"type":"string"}}') as Record<string, { type: "string" }>;
    const schema = normalizeHitlAnswerSchema({ type: "object", properties, required: ["__proto__"] });
    expect(Object.prototype.hasOwnProperty.call(schema.properties, "__proto__")).toBe(true);
    expect((schema.properties as unknown as Record<string, unknown>)["__proto__"]).toEqual({ type: "string" });
  });
});
