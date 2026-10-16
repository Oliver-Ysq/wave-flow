import { expect, test } from "bun:test";

test("中断诊断在对话内可见并提供显式重试提示", async () => {
  const conversation = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  expect(conversation).toContain('harness.status === "interrupted"');
  expect(conversation).toContain('className="conversation-interruption" role="alert"');
  expect(conversation).toContain("harness.diagnostic");
  expect(conversation).toContain('主控暂时无法启动');
  expect(conversation).toContain('主控启动失败');
  const source=await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain('onRetryInitialization={()=>taskMutation(');
  expect(source).toContain('正在检查 CLI 并启动主控');
  expect(source).toContain('执行底座设置');
  expect(source).toContain('setRetryError(error instanceof Error');
  expect(conversation).toContain("可直接发送下一条消息重试");
});

test("用户手工源码提案弹窗移除，方案只在中央详情展示", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).not.toContain("function WorkflowDraftModal(");
  expect(source).not.toContain("api.proposeWorkflowRevision");
  expect(source).toContain('className="central-workflow"');
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toMatch(/\.connection-backdrop\s*\{[^}]*position:fixed;[^}]*inset:0;/);
});
