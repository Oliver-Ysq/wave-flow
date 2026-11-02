import { expect, test } from "bun:test";
import { withDeadline } from "./deadline";

test("withDeadline 成功时透传结果", async () => {
  await expect(withDeadline(Promise.resolve("ok"), 1_000, "测试")).resolves.toBe("ok");
});

test("withDeadline 超时拒绝并给出可诊断标签", async () => {
  await expect(withDeadline(new Promise<never>(() => {}), 30, "测试等待")).rejects.toThrow("测试等待超过 30ms 未完成");
});
