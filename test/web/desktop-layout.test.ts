import {expect,test} from 'bun:test';

test('工作台只从所属Task访问执行，不提供独立Run历史或控制旁路',async()=>{
 const app=await Bun.file('src-tauri/web/src/App.tsx').text();
 const css=await Bun.file('src-tauri/web/src/workbench.css').text();
 const api=await Bun.file('src-tauri/web/src/api.ts').text();
 for(const removed of ['独立运行历史','独立运行记录','workflow-run-picker','selectedId','setSelectedId','RunDetail','toRunListItem','api.listRuns()','api[action](selected.runId)'])expect(app).not.toContain(removed);
 expect(css).not.toContain('workflow-run-picker');
 for(const action of ['runs.list','runs.create','runs.pause','runs.recover','runs.stop','runs.resume','runs.currentAttempt','runs.executionAttempts'])expect(api).not.toContain(`"${action}"`);
 expect(api).toContain('"executions.resume"');
 expect(api).toContain('"executions.get"');
 expect(api).toContain('"runs.phaseVisits"');
 expect(app).toContain('const workflowPanelOpen = route.kind === "workflow";');
 expect(app).toContain('routeMatchesTask(harness,route)');
 expect(app).toContain('api.resumeExecution(');
 expect(app).toContain('<HistoricalResults');
 expect(app).toContain('<PreviousRecords');
});

test('窄窗导航独占顶部安全行，归档动作复用紧凑按钮',async()=>{
 const css=await Bun.file('src-tauri/web/src/workbench.css').text();
 const app=await Bun.file('src-tauri/web/src/App.tsx').text();
 expect(css).toContain('.agent-workbench { box-sizing:border-box; padding-top:44px; }');
 expect(css).toContain('.agent-workbench.native-titlebar { padding-top:82px; }');
 expect(css).toContain('.agent-workbench.native-titlebar .navigation-toggle { top:44px; }');
 expect(css).not.toContain('left:8px; bottom:8px; z-index:100;');
 expect(app).toContain('className="button-secondary" onClick={onClose}>返回处理');
 expect(app).toContain('className="button-danger" onClick={onConfirm}>放弃总结并归档');
 expect(app).not.toContain('className="danger" onClick={onConfirm}');
 expect(app).toContain("if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}");
});

test('短历史记录仅压缩相邻记录，不压缩完整消息或结果卡',async()=>{
 const css=await Bun.file('src-tauri/web/src/workbench.css').text();
 expect(css).toContain('.task-event { margin:0; padding:4px 0; line-height:1.6; }');
 expect(css).toContain('.workflow-timeline-item:has(> .task-event) + .workflow-timeline-item:has(> .task-event)');
});
test('版本入口脱离正文流，局部避让不遮挡原状态',async()=>{
 const css=await Bun.file('src-tauri/web/src/workbench.css').text();
 expect(css).toContain('.workflow-version-tools { position:absolute; right:0; top:0;');
 expect(css).toContain('.central-plan:has(.workflow-version-menu) .wf-plan-head { padding-right:116px;');
});
test('macOS保留原生窗口装饰与安全拖动区，归档独立于任务导航',async()=>{
 const config=await Bun.file('src-tauri/tauri.conf.json').json();
 const app=await Bun.file('src-tauri/web/src/App.tsx').text();
 const conversation=await Bun.file('src-tauri/web/src/conversation/conversation-view.tsx').text();
 expect(config.app.windows[0].titleBarStyle).toBe('Overlay');
 expect(config.app.windows[0].hiddenTitle).toBe(true);
 expect(config.app.windows[0].decorations).not.toBe(false);
 expect(app).toContain('data-tauri-drag-region="deep"');
 expect(app).not.toContain('getCurrentWindow().startDragging()');
 expect(app).not.toContain('onMouseDown={event=>{if(event.button===0)');
 expect(app).toContain('onClick={()=>onArchive(item)}');
 expect(app).toContain('item.executions.some(execution=>!execution.finishedAt)');
 expect(app).toContain('background.forEach(item=>item.inert=true)');
 expect(app).toContain('onArchive={target=>void archiveTask(target)}');
 expect(app).not.toContain('归档这个任务？');
 expect(app).toContain('await taskMutation(id,()=>api.completeHarness(id))');
 const css=await Bun.file('src-tauri/web/src/workbench.css').text();
 expect(css).toContain('.desktop-titlebar::before');
 expect(css).toContain('height:100%; font-size:12px;');
 expect(css).not.toContain('align-self:flex-start; font-size:12px;');
 expect(css).toContain('body { margin:0; min-height:100%; overscroll-behavior:none; }');
 expect(css).toContain('width:var(--wf-rail-width); background:var(--wf-rail); border-right:1px solid var(--wf-line-soft);');
 expect(conversation).not.toContain('data-archive-task');
});
