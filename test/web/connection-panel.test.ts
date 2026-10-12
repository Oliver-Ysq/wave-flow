import { expect, test } from "bun:test";

test("Runtime 与项目弹窗都使用连接面板样式，不回退旧浅色表单", async () => {
  const source = await Bun.file("web/src/App.tsx").text();
  const css = await Bun.file("web/src/workbench.css").text();
  expect(source).toContain('className="connection-panel runtime-settings"');
  expect(source).toContain('className="connection-panel project-create"');
  expect(source).not.toContain('className="workflow-draft project-create"');
  expect(css).toContain(".agent-workbench .connection-panel");
  expect(css).toContain(":root[data-theme=\"light\"]");
  expect(css).toContain(".agent-workbench .connection-field input:focus");
  expect(css).toContain(".agent-workbench .button-primary");
});
