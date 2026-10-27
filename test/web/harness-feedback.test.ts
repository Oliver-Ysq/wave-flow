import { expect, test } from "bun:test";

test("中断诊断在对话内可见并提供显式重试提示", async () => {
  const conversation = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  expect(conversation).toContain('harness.status === "interrupted"');
  expect(conversation).toContain('className="conversation-interruption" role="alert"');
  expect(conversation).toContain("harness.diagnostic");
  expect(conversation).toContain('Wave Flow 暂时无法启动');
  expect(conversation).toContain('主控启动失败');
  const source=await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain('onRetryInitialization={() =>\n              taskMutation(');
  expect(source).toContain('正在检查执行工具');
  expect(source).toContain('执行环境设置');
  expect(source).toContain('setRetryError(\n                    error instanceof Error');
  expect(conversation).toContain("回合已中断 · 发送消息继续");
  expect(conversation).toContain("仅恢复待命");
});

test("用户手工源码提案弹窗移除，方案只在中央详情展示", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).not.toContain("function WorkflowDraftModal(");
  expect(source).not.toContain("api.proposeWorkflowRevision");
  expect(source).toContain('className="central-workflow"');
  expect(source).not.toContain("changes-open");
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toMatch(/\.connection-backdrop\s*\{[^}]*position:fixed;[^}]*inset:0;/);
});
