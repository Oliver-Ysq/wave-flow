import { expect, test } from "bun:test";

test("中断诊断在对话内可见并提供显式重试提示", async () => {
  const conversation = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  expect(conversation).toContain('harness.status === "interrupted"');
  expect(conversation).toContain('className="conversation-interruption" role="alert"');
  expect(conversation).toContain("harness.diagnostic");
  expect(conversation).toContain("可直接发送下一条消息重试");
});

test("Workflow 草案复用固定覆盖层，不能作为工作台 Grid 的新行", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  const modal = source.slice(source.indexOf("function WorkflowDraftModal("), source.indexOf("function HarnessToolActivity("));
  expect(modal).toContain('className="connection-backdrop"');
  expect(modal).toContain('className="connection-panel workflow-draft"');
  expect(modal).toContain('role="dialog"');
  expect(modal).toContain('aria-label="Workflow 草案源码"');
  expect(modal).toContain('event.key === "Escape"');
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toMatch(/\.connection-backdrop\s*\{[^}]*position:fixed;[^}]*inset:0;/);
  expect(css).toMatch(/\.workflow-draft\s*\{[^}]*display:flex;[^}]*width:min\(800px, 100%\)/);
});
