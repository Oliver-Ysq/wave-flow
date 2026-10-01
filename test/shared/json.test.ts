import { describe, expect, test } from "bun:test";
import { isJsonObject, isJsonValue } from "../../src/shared/json";

describe("JSON-safe 值", () => {
  test("接受 JSON 可表示的有限值与嵌套对象", () => {
    expect(isJsonValue({ enabled: true, retries: 3, tags: ["review", null] })).toBe(true);
    expect(isJsonObject({ target: "src", filters: { severity: "high" } })).toBe(true);
  });

  test("拒绝无法安全序列化的值", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Infinity)).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(() => undefined)).toBe(false);
    expect(isJsonValue(1n)).toBe(false);
    expect(isJsonValue(cyclic)).toBe(false);
    expect(isJsonObject(["not", "an", "object"])).toBe(false);
  });
});
