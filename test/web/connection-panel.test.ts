import { expect, test } from "bun:test";

test("Runtime 门禁与项目弹窗都使用连接面板样式，不回退旧浅色表单", async () => {
  const source = await Bun.file("web/src/App.tsx").text();
  const css = await Bun.file("web/src/workbench.css").text();
  expect(source).toContain('runtime-settings--gate');
  expect(source).toContain('api.scanCliRuntimes()');
  expect(source).toContain('选择主控 CLI');
  expect(source).toContain('手动添加 CLI');
  expect(source).toContain('connection-panel--nested');
  expect(source).toContain('manual-runtime-error');
  expect(source).toContain('setManualError(message)');
  expect(source).toContain('agent-workbench theme-${theme}');
  expect(source).toContain('className="connection-panel project-create"');
  expect(source).not.toContain('className="workflow-draft project-create"');
  expect(css).toContain(".agent-workbench .connection-panel");
  expect(css).toContain(":root[data-theme=\"light\"]");
  expect(css).toContain(".agent-workbench .connection-field input:focus");
  expect(css).toContain(".agent-workbench .button-primary");
  expect(css).toContain(".connection-backdrop--gate");
  expect(css).toContain(".toast-layer { position:fixed; z-index:200");
  expect(css).toContain(".manual-runtime-error");
});
