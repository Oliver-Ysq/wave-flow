import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionDiagnostics } from "../../src-tauri/web/src/execution/execution-diagnostics";

const props = {
  executionId: "exec-123",
  sourceHash: "a".repeat(64),
  runtimeVersion: 9,
  currentAttempt: 2,
  fallbackRuntimeId: "runtime-xyz",
};

test("工程标识默认收进折叠诊断区，完整值不截断且可复制", () => {
  const html = renderToStaticMarkup(createElement(ExecutionDiagnostics, props));
  // 信息存在于 DOM 但包裹在默认折叠的 details 内，不是默认视觉层级。
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(html).toContain("exec-123");
  expect(html).toContain("a".repeat(64));
  expect(html).toContain("v9");
  expect(html).toContain("#2");
  expect(html).toContain("runtime-xyz");
  expect(html).toContain("高级 / 诊断信息");
  // 每个可复制的工程标识都有复制入口。
  expect(html.match(/class="copy-value"/g)).toHaveLength(3);
});

test("无分配配置时不渲染回退 Runtime 行", () => {
  const html = renderToStaticMarkup(
    createElement(ExecutionDiagnostics, { ...props, fallbackRuntimeId: null }),
  );
  expect(html).not.toContain("回退 Runtime");
  expect(html.match(/class="copy-value"/g)).toHaveLength(2);
});
