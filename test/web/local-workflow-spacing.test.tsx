import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalWorkflowPreview } from "../../src-tauri/web/src/local-workflow-preview";

test("本地文件输入与操作同行，空路径仍禁止检查", () => {
  const html = renderToStaticMarkup(<LocalWorkflowPreview projectId="spacing-test" onClose={() => {}} onPrepared={() => {}} />);
  expect(html).toContain('<label class="local-workflow-file-label" for="local-workflow-path">工作流文件</label>');
  expect(html).toMatch(/<div class="local-workflow-file-row"><input id="local-workflow-path"[^>]*><div class="local-workflow-file-actions">/);
  expect(html).toMatch(/<div class="local-workflow-file-actions"><button[^>]*>选择工作流文件<\/button><button[^>]*disabled=""[^>]*>检查文件<\/button><\/div>/);
  expect(html).toContain('class="local-workflow-intro"');
  expect(html).toContain('class="source-safety-note local-workflow-safety-note"');
});

test("原路径修订保留操作组但不能换文件", () => {
  const html = renderToStaticMarkup(<LocalWorkflowPreview projectId="spacing-test" onClose={() => {}} onPrepared={() => {}} revision={{ leadRunId: "run", baseRevision: 1, path: "workflow.ts", input: {} }} />);
  expect(html).not.toContain("选择工作流文件</button>");
  expect(html).toMatch(/<div class="local-workflow-file-actions"><button[^>]*>检查文件<\/button><\/div>/);
  expect(html).toContain('value="workflow.ts"');
});

test("操作区用 gap 分隔并允许窄窗口换行，不污染其他弹窗", async () => {
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain('.local-workflow-file-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:stretch; gap:12px; }');
  expect(css).toContain('.local-workflow-file-actions { display:flex; align-items:stretch; gap:12px; }');
  expect(css).toContain('.local-workflow-file-actions > button { min-height:40px; max-width:100%; margin:0; line-height:1.5; }');
  expect(css).toContain('@media(max-width:560px) { .workflow-source-content .local-workflow-file-row { grid-template-columns:minmax(0,1fr); }');
  expect(css).toContain('.local-workflow-safety-note { margin:16px 0 0; }');
});
