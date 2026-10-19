import { expect, test } from "bun:test";

test("侧栏不再展示或维护任务搜索，项目列表直接呈现",async()=>{
  const app=await Bun.file("src-tauri/web/src/App.tsx").text();
  const css=await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(app).not.toContain('className="task-search"');
  expect(app).not.toContain("搜索任务");
  expect(app).not.toContain("const [search, setSearch]");
  expect(app).not.toContain("revision.goal?.includes(search)");
  expect(css).not.toContain(".task-search");
  expect(css).toContain("grid-template-rows: auto auto auto auto minmax(0, 1fr) auto");
});

test("预置与本地工作流复用居中弹窗，不回退主网格或伪切换入口",async()=>{
  const app=await Bun.file("src-tauri/web/src/App.tsx").text();
  const template=await Bun.file("src-tauri/web/src/template-picker.tsx").text();
  const local=await Bun.file("src-tauri/web/src/local-workflow-preview.tsx").text();
  const shell=await Bun.file("src-tauri/web/src/workflow-source-dialog.tsx").text();
  const css=await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(app).toContain(">本地工作流</button>");
  expect(template).toContain('<WorkflowSourceDialog title="预置工作流"');
  expect(template).not.toContain("本地工作流请从新建任务页选择");
  expect(local).toContain('<WorkflowSourceDialog title="本地工作流"');
  expect(local).toContain('setPath(event.target.value);setResult(null);setError(null);');
  expect(local).toContain('找不到工作流文件，请检查路径，或重新选择文件。');
  expect(shell).toContain('className="connection-backdrop workflow-source-backdrop"');
  expect(shell).toContain('role="dialog" aria-modal="true"');
  expect(css).not.toContain(".template-picker { position: fixed");
  expect(template).toContain("Wave Flow 帮我填");
  expect(template.indexOf('className="source-guidance"')).toBeGreaterThan(template.indexOf("<ParameterForm"));
  expect(css).toContain('.compact-parameters > details { margin:24px 0 0; }');
  expect(css).toContain('details[open] > .compact-parameter-grid { margin-top:16px; }');
  expect(css).toContain('.source-guidance { margin-top:24px;');
  expect(css).toContain('.workflow-source-content .compact-parameter-grid { grid-template-columns:1fr; gap:20px; }');
  expect(css).toContain('.compact-parameters { margin-top:24px; padding-bottom:0; border-bottom:0; }');
  expect(shell).toContain('className="workflow-source-actions"');
  expect(css).toContain('overflow:hidden;');
  expect(css).toContain('.workflow-source-content { min-height:0; overflow:auto;');
  expect(css).not.toContain('.compact-parameters > button { margin-top:20px; width:100%');
  expect(app).not.toContain("本地主控工作台");
  expect(template).not.toContain("让主控帮我填写");
  expect(template).toContain("Wave Flow 帮我填");
});

test("主页快捷入口位于输入框外上方，不占用输入框底部", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  const home = app.slice(app.indexOf("function DraftConversation("), app.indexOf("function HarnessConversation("));
  const actions = home.indexOf('className="draft-quick-actions"');
  const composer = home.indexOf('className="conversation-composer"');
  expect(actions).toBeGreaterThan(-1);
  expect(actions).toBeLessThan(composer);
  expect(home.slice(composer)).not.toContain("预置工作流");
  expect(home.slice(composer)).not.toContain("draft-name");
  expect(home).not.toContain("source-card");
  expect(home.indexOf('className="draft-project-name"')).toBeLessThan(home.indexOf("预置工作流"));
  expect(home.slice(composer)).not.toContain("draft-composer-context");
  expect(home).not.toContain("<span>本地</span>");
  expect(home).toContain(">本地工作流</button>");
  expect(home).not.toContain(">本地文件</button>");
  expect(home).toContain('event.key==="Escape"');
  expect(home).toContain('event.currentTarget.open=false');
  expect(home).toContain('aria-label="添加图片附件"');
  expect(home).toContain('onClick={onAddAttachments}');
  expect(home).toContain('aria-label="待发送附件"');
});

test("浅色主页上下文文字与快捷入口有独立层级，深色样式不被覆盖", async () => {
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain('--wf-home-action-bg: #fff');
  expect(css).toContain('--wf-home-action-line: rgb(209 209 219 / 45%)');
  expect(css).toContain('--wf-home-context-ink: #686872');
  expect(css).toContain(':root[data-theme="light"] .agent-workbench .draft-conversation .draft-project-branch');
  expect(css).toContain(':root[data-theme="light"] .agent-workbench .draft-conversation .draft-name summary');
  expect(css).toContain('box-shadow:inset 0 0 0 1px var(--wf-home-action-line)');
  expect(css).toContain('.draft-source-link:focus-visible');
});

test("待发送附件按草稿身份隔离，迟到选择和发送不清空其他草稿",async()=>{
  const app=await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain("attachmentDrafts.get(attachmentOwner)");
  expect(app).toContain("current.get(attachmentOwner)??[]");
  expect(app).toContain("attachmentErrors.get(attachmentOwner)");
  expect(app).toContain('className="attachment-error" role="alert"');
  expect(app).toContain("requestAnimationFrame(()=>attachmentButton.current?.focus())");
  expect(app).toContain("ref={attachmentButton}");
  expect(app).toContain("current=>current.filter(item=>!stagedIds.includes(item.stagedId))");
  expect(app).toContain("pendingMessage.current.owner!==owner");
  expect(app).toContain("pendingMessage.current.attachmentIds!==attachmentIds");
  expect(app).not.toContain("useEffect(() => { setPendingAttachments([]); }");
  expect(app).toContain("existing+paths.length>5");
  expect(app.indexOf("existing+paths.length>5")).toBeLessThan(app.indexOf("await api.stageAttachment(path)"));
  expect(app).toContain("attachmentBusy={stagingOwner===attachmentOwner}");
  expect(app).toContain("正在添加图片…");
  expect(app).toContain("sending.current || stagingOwner===attachmentOwner");
  expect(app).toContain("disabled={!ready || !text.trim() || attachmentBusy}");
  const conversation=await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  expect(conversation).toContain("disabled={!draft.trim()||attachmentBusy}");
  expect(conversation).toContain("aria-busy={attachmentBusy}");
});
