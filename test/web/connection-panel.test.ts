import { expect, test } from "bun:test";

test("Runtime 门禁与项目弹窗都使用连接面板样式，不回退旧浅色表单", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
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

test("桌面端不渲染未耐久思考流，也不依赖第三方会话 runtime", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  const manifest = await Bun.file("package.json").text();
  expect(source).not.toContain("harness-reasoning");
  expect(source).not.toContain("reasoning_delta");
  expect(source).not.toContain("ChainOfThoughtPrimitive");
  expect(source).not.toContain("useLocalRuntime");
  expect(manifest).not.toContain("@assistant-ui/react");
});

test("主控输入框让裸 Enter 留给 IME/换行，仅以 ⌘/Ctrl + Enter 发送且显式绘制光标", async () => {
  const source = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(source).toContain("function shouldSubmitComposer");
  expect(source).toContain("event.nativeEvent.isComposing");
  expect(source).toContain("event.metaKey || event.ctrlKey");
  expect(source).not.toContain("keyCode !== 229");
  expect(source).toContain("⌘/Ctrl + Enter 发送 · Enter 换行");
  expect(css).toContain("caret-color:var(--wf-ink)");
});

test("完成会话后回到进行中第一个项目的新建会话页", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  const draftStart = source.indexOf("function beginHarnessDraft");
  const draftEnd = source.indexOf("async function sendHarness", draftStart);
  const draftSource = source.slice(draftStart, draftEnd);
  expect(draftSource).toContain('setHarnessView("active")');
  expect(draftSource).toContain("setHarness(null)");
  expect(draftSource).toContain("setDraftProjectId(projectId)");

  const completeStart = source.indexOf("async function confirmArchive");
  const completeEnd = source.indexOf("async function beginArchive", completeStart);
  const completeSource = source.slice(completeStart, completeEnd);
  expect(completeSource).toContain("api.completeHarness(id)");
  expect(completeSource).toContain("api.archiveAbandoningPending(id)");
  expect(completeSource).toContain("const firstProjectId = projects[0]?.projectId ?? null");
  expect(completeSource).toContain('setHarnessView("active")');
  expect(completeSource).toContain("setSelectedProjectId(firstProjectId)");
  expect(completeSource).toContain("setDraftProjectId(firstProjectId)");
  expect(completeSource).toContain("setHarness(null)");
  expect(completeSource).not.toContain('setHarnessView("completed")');
});

test("桌面端不保留 HTTP/SSE 流，只展示 Engine 已耐久的完整主控消息", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(source).not.toContain("EventSource(");
  expect(source).not.toContain("assistant_delta");
  expect(source).not.toContain("reasoning_delta");
  expect(source).toContain("harness.messages");
  expect(source).toContain("class WorkflowPanelErrorBoundary");
  expect(source).toContain("无法显示 Workflow 详情");
  expect(source).toContain("<WorkflowPanelErrorBoundary");
  expect(css).toContain("white-space:pre-wrap");
  expect(css).toContain(".workflow-render-error");
  expect(css).toContain("grid-template-columns: 260px minmax(0, 1fr)");
  expect(source).toContain('className="central-workflow"');
  expect(source).not.toContain('className="workflow-peek"');
});

test("工具过程作为 assistant 正文下方的安全尾注恢复，不显示敏感调用细节", async () => {
  const source = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  const types = await Bun.file("src-tauri/web/src/types.ts").text();
  expect(types).toContain("toolActivitiesByMessageId");
  expect(source).toContain("harness.toolActivitiesByMessageId[turn.assistant.id]");
  expect(source).toContain("key={`${turn.assistant!.id}:tool:${index}`}");
  expect(source).toContain("不保存参数、路径、命令或完整输出");
  expect(source).not.toContain("完整结果不会显示或保存");
});

test("Workflow 草案是受对话列宽约束的内联行动点，不能挤占或溢出主视图", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  const card = await Bun.file("src-tauri/web/src/conversation/revision-card.tsx").text();
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(source).toContain("WorkflowRevisionCard");
  expect(card).toContain('className={`conversation-action workflow-revision');
  expect(source).not.toContain('className="workflow-action"');
  expect(css).toContain(".agent-workbench .conversation-action {");
  expect(css).toContain("width:min(720px, 100%)");
  expect(css).toContain("min-width:0");
  expect(css).toContain("overflow-wrap:anywhere");
  expect(css).not.toContain(".agent-workbench .workflow-pane");
  expect(css).not.toContain(".agent-workbench .workflow-peek");
  expect(css).toContain(".agent-workbench .central-workflow");
});

test("Execution 详情读取失败时说明 Desktop Engine 重连，而不是误报 Workflow 失败", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain("function executionLoadMessage");
  expect(source).toContain("Desktop Engine 连接已中断；正在重新连接");
  expect(source).toContain("旧 Execution 会安全收敛为“已中断”");
  // 触发条件必须挂在 invoke 的稳定错误文案上，而不是永不出现的 fetch 网络错误。
  expect(source).toContain("Desktop Engine (已退出|请求超时|管道错误|未运行)");
});

test("退出取消的 Run 与中断 Run 都提供显式恢复入口", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain('run.status === "interrupted" || run.status === "cancelled"');
  expect(source).toContain('label={run.status === "cancelled" ? "恢复已停止 Run" : "重新执行"}');
  expect(source).toContain('onClick={() => void onControl("resume")}');
});

test("取消或中断的 Execution 都提供同一冻结 revision 的显式恢复入口", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain('detail.snapshot.status === "interrupted" || detail.snapshot.status === "cancelled"');
  expect(source).toContain('label={detail.snapshot.status === "cancelled" ? "恢复已停止 Execution" : "恢复中断 Execution"}');
  expect(source).toContain('onClick={() => void onControl("resume")}');
});

test("活动 Run 仅通过 Engine action 轮询当前尝试，不回退 SSE", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain("Desktop 不再有 Run SSE");
  expect(source).toContain("window.setInterval(reload, 1_000)");
  expect(source).toContain("api.currentAttempt(run.runId)");
  expect(source).not.toContain("EventSource(");
});
