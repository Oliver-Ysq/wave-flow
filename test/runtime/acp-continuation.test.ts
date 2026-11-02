import { expect, test } from "bun:test";
import { AcpAmbiguousPromptError } from "../../src/adapters/acp-session";
import { acpContinuationPrompt, classifyContinuationFailure } from "../../src/runtime/acp-continuation";

test("续用指令只陈述中断事实并要求先核对，不重发业务任务", () => {
  const prompt = acpContinuationPrompt();
  expect(prompt).toContain("上一回合被中断");
  expect(prompt).toContain("核对最近一次动作");
  expect(prompt).toContain("不要重复执行");
  expect(prompt).not.toContain("请重新执行任务");
});

test("投递结果不确定按 unknown 处理，其他异常按拒绝", () => {
  expect(classifyContinuationFailure(new AcpAmbiguousPromptError("连接中断"))).toEqual({ outcome: "unknown", reason: "连接中断" });
  expect(classifyContinuationFailure(new Error("session/load 失败"))).toEqual({ outcome: "refused", reason: "session/load 失败" });
});
