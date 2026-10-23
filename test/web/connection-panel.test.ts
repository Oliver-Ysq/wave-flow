import { expect, test } from "bun:test";

test("退出确认锁定背景并默认聚焦取消，快捷键与菜单都进入确认而非直接退出",async()=>{
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 const modal=app.slice(app.indexOf('function DesktopExitModal('),app.indexOf('type SettingsSection'));
 expect(modal).toContain('sibling.inert = true');
 expect(modal).toContain('cancel.current?.focus()');
 expect(modal).toContain('event.key === "Tab"');
 expect(modal).toContain('if (!busyRef.current) closeRef.current()');
 const source=await Bun.file('src-tauri/src/main.rs').text();
 expect(source).toContain('Some("CmdOrCtrl+Q")');
 expect(source).not.toContain('CmdOrMeta+Q');
 expect(source).toContain('matches!(event.id().as_ref(), "settings" | "shutdown")');
});
test("每个 CLI 只展示一个安装，其余安装默认折叠并可查看真实验证状态",async()=>{
 const source=await Bun.file('src-tauri/web/src/App.tsx').text();
 expect(source).toContain('runtime-badge');
 expect(source).toContain('<summary>其他安装（');
 expect(source).toContain('runtime.status === "invalid"');
 expect(source).toContain('runtime.diagnostic &&');
});
test("手动CLI验证绑定当前输入，修改后清旧错误，关闭不冒充取消验证",async()=>{
 const source=await Bun.file('src-tauri/web/src/App.tsx').text();
 expect(source).toContain('if (runtimeBusy || !manualPath.trim()) return');
 expect(source).toContain('setManualPath(value);\n                    setManualError(null);');
 expect(source).toContain('else if (base.includes("codex")) setManualCli("codex");');
 expect(source).toContain('关闭窗口不会取消验证');
 expect(source).toContain('{runtimeBusy ? "关闭窗口" : "取消"}');
 expect(source).toContain('manualErrorRef.current?.focus()');
 expect(source).toContain('ref={manualErrorRef}');
 expect(source).toContain('tabIndex={-1}');
 expect(source).toContain('!manualOpen && manualError');
 expect(source).toContain('请重新打开「手动添加」修改后重试。');
 expect(source).toContain('onClick={() => setManualOpen(false)}');
 expect(source).toContain('setRuntimeOperation("validate");\n    setManualError(null);');
});
test("扫描、验证、切换的状态文案只对应当前动作",async()=>{
 const source=await Bun.file('src-tauri/web/src/App.tsx').text();
 expect(source).toContain('runtimeOperation === "scan" || scanning');
 expect(source).toContain('!manualOpen && runtimeOperation === "validate"');
 expect(source).toContain('runtimeOperation === "select"');
 expect(source).not.toContain('!manualOpen&&runtimeBusy&&<p role="status">正在验证 CLI');
});
test("工作流阅读导航聚焦标题，返回保留原任务入口且后台更新不抢焦点",async()=>{
 const source=await Bun.file('src-tauri/web/src/App.tsx').text();
 expect(source).toContain('workflowPanelOpen && !wasWorkflowOpen.current');
 expect(source).toContain('workflowTitle.current?.focus({ preventScroll: true })');
 expect(source).toContain('if (prior?.taskId === (harness?.harnessRunId ?? null))');
 expect(source).toContain('const target = prior.button.isConnected');
 expect(source).toContain('ref={workflowTitle}\n                tabIndex={-1}\n                role="heading"\n                aria-level={1}');
});

test("原生设置菜单使用当前菜单库支持的跨平台快捷键名称",async()=>{
 const source=await Bun.file("src-tauri/src/main.rs").text();
 expect(source).toContain('"settings", "设置…", true, Some("CmdOrCtrl+,")');
 expect(source).not.toContain('"settings", "设置…", true, Some("CmdOrMeta+,")');
});
test("设置在应用最小宽度附近改用顶部导航，CLI动作不挤压正文",async()=>{
 const css=await Bun.file("src-tauri/web/src/workbench.css").text();
 expect(css).toContain('@media(max-width:760px)');
 expect(css).toContain('.settings-layout { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); }');
 expect(css).toContain('.settings-nav { display:flex;');
 expect(css).toContain('.runtime-list article { align-items:stretch; flex-direction:column; }');
});

test("设置与手动添加只锁定当前弹窗，支持Esc及原入口焦点恢复",async()=>{
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain('const activePanel = manualOpen');
 expect(source).toContain('sibling.inert = true');
 expect(source).toContain('element.inert = inert');
 expect(source).toContain('document.addEventListener("keydown", keydown, true)');
 expect(source).toContain('else if (!gateMode) settingsClose.current?.()');
 expect(source).toContain('querySelector<HTMLElement>(".add-runtime")');
 expect(source).toContain('querySelector<HTMLElement>(\n          \'[aria-label="打开任务导航"]\',\n        )');
});

test("CLI设置默认项只在顶部展示，其他项保留技术详情与二次确认",async()=>{
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain('const preferredByCli = (() => {');
 expect(source).toContain('runtimeState.selectedByCli?.[runtime.cli]');
 expect(source).toContain('...otherRuntimes].map((runtime) => runtimeRow(runtime))');
 expect(source).toContain('当前默认工具');
 expect(source).toContain('["cli", "执行工具"]');
 expect(source).toContain('<summary>技术信息</summary>');
 expect(source).toContain('confirmSwitchId !== runtime.runtimeId');
 expect(source).toContain('runtime.verifiedAdapter.harnessTools ? (');
 expect(source).toContain('extraRuntimes.map((runtime) => runtimeRow(runtime, true))');
 expect(source).toContain('confirmRemoveId === runtime.runtimeId ? "确认移除？" : "移除"');
});

test("Runtime 门禁与项目弹窗都使用连接面板样式，不回退旧浅色表单", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(source).toContain('runtime-settings--gate');
  expect(source).toContain('api.scanCliRuntimes()');
  expect(source).toContain('连接本地执行工具');
  expect(source).toContain('手动添加执行工具');
  expect(source).toContain('connection-panel--nested');
  expect(source).toContain('manual-runtime-error');
  expect(source).toContain('setManualError(message)');
  expect(source).toContain('agent-workbench theme-${theme}');
  const projectDialog = await Bun.file("src-tauri/web/src/project-create-dialog.tsx").text();
  expect(projectDialog).toContain('className="connection-panel project-create"');
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
  expect(css).toContain("grid-template-columns: var(--wf-rail-width, 260px) minmax(0, 1fr)");
  expect(source).toContain('central-workflow${changesView ? " changes-open" : ""}');
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
  expect(source).toContain("本地服务连接中断，正在重连");
  expect(source).toContain("若执行被中断");
  // 触发条件必须挂在 invoke 的稳定错误文案上，而不是永不出现的 fetch 网络错误。
  expect(source).toContain("Desktop Engine (已退出|请求超时|管道错误|未运行)");
});

test("取消或中断的 Execution 都提供显式恢复入口，中断走产品级恢复卡", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  // 中断不再暴露技术性的“恢复中断 Execution”，而是唯一主按钮“重新尝试”。
  expect(source).toContain("function ExecutionRecoveryCard");
  expect(source).toContain('detail.snapshot.status === "interrupted" && (');
  expect(source).toContain('label={busy ? "正在重新尝试…" : "重新尝试"}');
  expect(source).toContain('onClick={() => void onControl("resume")}');
  // 用户主动停止仍保留明确的恢复按钮，不与异常恢复混淆。
  expect(source).toContain('detail.snapshot.status === "cancelled"');
  expect(source).toContain('"重新开始执行"');
});

test("Task 执行仅通过 Engine action 刷新，不回退独立 Run 详情或 SSE", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain("window.setInterval(reload, 1_000)");
  expect(source).toContain(".execution(harness.harnessRunId, selectedExecutionId)");
  expect(source).not.toContain("api.currentAttempt(");
  expect(source).not.toContain("EventSource(");
});

test("默认 CLI 门禁是居中模态并带背景模糊，而不是铺满窗口", async () => {
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain(".settings-backdrop.connection-backdrop--gate");
  expect(css).toContain("backdrop-filter: blur(22px) saturate(1.25)");
  expect(css).toContain("place-items: center");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
});

test("停止操作必须先内联确认，首次配置提供安装引导", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  const conversation = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  expect(conversation).toContain('role="alertdialog"');
  expect(conversation).toContain('aria-label="确认停止当前回合"');
  expect(conversation).toContain('setConfirmStop(true)');
  expect(conversation).toContain("确认停止");
  expect(app).toContain('className="execution-stop-confirm"');
  expect(app).toContain('setConfirmStop(true)');
  expect(app).toContain("确认停止");
  expect(app).toContain("重试成果收尾");
  expect(app).toContain("execution-workspace-location");
  expect(app).toContain("runtime-setup-guide");
  expect(app).toContain("如何安装并登录？");
  expect(app).toContain("重新检查");
  expect(app).not.toContain("未检测到本机 CLI。如果已安装仍未出现，可能是探测超时。");
});
