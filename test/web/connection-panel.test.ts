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

test("思考流使用与会话 runtime 无关的原生折叠控件，长回复不能读取 chainOfThought scope", async () => {
  const source = await Bun.file("web/src/App.tsx").text();
  const manifest = await Bun.file("package.json").text();
  expect(source).toContain('<details className="harness-reasoning">');
  expect(source).toContain("<pre>{reasoning}</pre>");
  expect(source).not.toContain("ChainOfThoughtPrimitive");
  expect(source).not.toContain("useLocalRuntime");
  expect(manifest).not.toContain("@assistant-ui/react");
});

test("主控输入框让裸 Enter 留给 IME/换行，仅以 ⌘/Ctrl + Enter 发送且显式绘制光标", async () => {
  const source = await Bun.file("web/src/App.tsx").text();
  const css = await Bun.file("web/src/workbench.css").text();
  expect(source).toContain("function shouldSubmitComposer");
  expect(source).toContain("event.nativeEvent.isComposing");
  expect(source).toContain("event.metaKey || event.ctrlKey");
  expect(source).not.toContain("keyCode !== 229");
  expect(source).toContain("⌘/Ctrl + Enter 发送 · Enter 换行");
  expect(css).toContain("caret-color:var(--wf-ink)");
});

test("完成会话后回到进行中第一个项目的新建会话页", async () => {
  const source = await Bun.file("web/src/App.tsx").text();
  const draftStart = source.indexOf("function beginHarnessDraft");
  const draftEnd = source.indexOf("async function sendHarness", draftStart);
  const draftSource = source.slice(draftStart, draftEnd);
  expect(draftSource).toContain('setHarnessView("active")');
  expect(draftSource).toContain("setHarness(null)");
  expect(draftSource).toContain("setDraftProjectId(projectId)");

  const completeStart = source.indexOf("api.completeHarness(harness.harnessRunId)");
  const completeEnd = source.indexOf("onOpenWorkflow", completeStart);
  const completeSource = source.slice(completeStart, completeEnd);
  expect(completeSource).toContain("const firstProjectId = projects[0]?.projectId ?? null");
  expect(completeSource).toContain('setHarnessView("active")');
  expect(completeSource).toContain("setSelectedProjectId(firstProjectId)");
  expect(completeSource).toContain("setDraftProjectId(firstProjectId)");
  expect(completeSource).toContain("setHarness(null)");
  expect(completeSource).not.toContain('setHarnessView("completed")');
});

test("当前回合按 SSE 顺序分段，最终正文只能补尾不能重排工具前后的文字", async () => {
  const source = await Bun.file("web/src/App.tsx").text();
  const css = await Bun.file("web/src/workbench.css").text();
  expect(source).toContain("type HarnessTurnPart =");
  expect(source).toContain('appendTurnText(current, "text", value.delta)');
  expect(source).toContain('type: "tool", toolCallId: value.toolCallId');
  expect(source).toContain("function HarnessTurnTimeline");
  expect(source).toContain("function reconcileTurnText");
  expect(source).toContain("if (!durableText.startsWith(streamedText)) return current");
  expect(source).toContain('appendTurnText(current, "text", missingTail)');
  expect(source).toContain("function HarnessTurnText");
  expect(source).toContain("message.id !== timelineMessageId");
  expect(source).not.toContain("timelineAssistantText");
  expect(source).toContain("class WorkflowPanelErrorBoundary");
  expect(source).toContain("无法显示 Workflow 详情");
  expect(source).toContain("<WorkflowPanelErrorBoundary");
  expect(css).toContain("white-space:pre-wrap");
  expect(css).toContain(".workflow-render-error");
  expect(css).toContain(".workflow-open { grid-template-columns:274px minmax(0,1fr) 0");
  expect(css).toContain(".workflow-pane { position:fixed");
  expect(css).toContain("visibility:hidden; pointer-events:none");
  expect(css).toContain(".workflow-pane.open { opacity:1; visibility:visible; pointer-events:auto");
});

test("工具过程作为 assistant 正文下方的安全尾注恢复，不显示敏感调用细节", async () => {
  const source = await Bun.file("web/src/App.tsx").text();
  const types = await Bun.file("web/src/types.ts").text();
  expect(types).toContain("toolActivitiesByMessageId");
  expect(source).toContain("harness.toolActivitiesByMessageId[message.id]");
  expect(source).toContain("key={`${message.id}:tool:${index}`}");
  expect(source).toContain("不保存参数、路径、命令或完整输出");
  expect(source).not.toContain("完整结果不会显示或保存");
});

test("Workflow 草案是受对话列宽约束的内联行动点，不能挤占或溢出主视图", async () => {
  const source = await Bun.file("web/src/App.tsx").text();
  const css = await Bun.file("web/src/workbench.css").text();
  expect(source).toContain('className="conversation-action workflow-revision"');
  expect(source).not.toContain('className="workflow-action"');
  expect(css).toContain(".agent-workbench .conversation-action {");
  expect(css).toContain("width:min(720px, 100%)");
  expect(css).toContain("min-width:0");
  expect(css).toContain("overflow-wrap:anywhere");
  expect(css).toContain(".agent-workbench .workflow-pane { position:fixed");
});

test("Execution 详情读取失败时说明后台服务重连，而不是误报 Workflow 失败", async () => {
  const source = await Bun.file("web/src/App.tsx").text();
  expect(source).toContain("function executionLoadMessage");
  expect(source).toContain("后台服务连接已中断；正在重新连接");
  expect(source).toContain("旧 Execution 会安全收敛为“已中断”");
});
