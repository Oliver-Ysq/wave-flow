import {expect,test} from "bun:test";

test("单版本不显示无效版本下拉，多版本保留切换入口",async()=>{
 const app=await Bun.file('src-tauri/web/src/App.tsx').text();
 expect(app).toContain('<WorkflowVersions\n');
 expect(app).not.toContain('<label>方案版本<select');
});

test("结果页逐一显示原总结与现场补充，过时义务不暴露重试按钮或计入归档待办", async () => {
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain('aria-label="原总结与补充"');
 expect(source).toContain('summaryKey={item.key}');
 expect(source).toContain('if (obligation.supersededBy)');
 expect(source).toContain('此补充已被更新的检查结果替代');
 expect(source).toContain('(item) => !item.supersededBy && item.status !== "completed"');
 expect(source).toContain('重新整理改动（不会重新执行）');
 expect(source).toContain('重新检查并重试补充');
 expect(source).toContain('api.checkExecutionScene');
});
test("归档与旧Execution隐藏成果恢复合入清理，保留diff阅读",async()=>{
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 const panel=await Bun.file("src-tauri/web/src/changes-panel.tsx").text();
 expect(app).toContain('(harness.task?.workflowContract === "single-workflow-v1" &&');
 expect(app).toContain('harness.executions.at(-1)?.executionId !==');
 expect(app).toContain('const changesApplied =');
 expect(app).toContain('所选工作流记录暂时不可用');
 expect(app).not.toContain('所选工作流记录已失效');
 expect(app).toContain('(detail.workspaceEvidence?.leases.length ?? 0) > 0');
 expect(app).not.toContain('TEMP DEBUG');
 expect(app).toContain('const applySkipped =');
 expect(app).toContain('applySkipped) && (');
 expect(app).toContain('applied={changesApplied}');
 expect(app).toContain('{!readOnly && (');
 expect(app).toContain('<div className="execution-actions">');
 expect(app).toContain('<ChangesPanel');
 expect(app).not.toContain("executions.merge");
 expect(app).not.toContain("changesWritable");
 expect(panel).toContain("已自动应用到主工作区（未提交、未推送）");
 expect(panel).not.toContain("采用这些改动");
});

test("整工作区授权并入确认运行，自动应用，内部检查点默认折叠",async()=>{
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 const design=await Bun.file("src-tauri/web/src/workflow-design.tsx").text();
 expect(design).toContain("完成后自动应用到主工作区");
 expect(design).toContain("所有写节点共享同一 worktree");
 expect(design).not.toContain("工作区分组");
 expect(design).not.toContain("集成来源节点");
 expect(design).not.toContain("接续上次改动");
 expect(design).not.toContain("approveGit");
 expect(app).toContain("<ChangesPanel");
 const review=await Bun.file("src-tauri/web/src/changes-panel.tsx").text();
 expect(review).toContain("已自动应用到主工作区（未提交、未推送）");
 expect(review).toContain("未自动应用");
 expect(review).toContain("generation.current === token");
 expect(app).toContain("改动还没有整理好");
 // 诊断与 Git 检查点合并为一个折叠入口，不再出现两个相邻的“高级 / 诊断”。
 expect(app).toContain("<summary>高级 / 诊断信息</summary>");
 expect(app).toContain("<ExecutionDiagnostics");
 expect(app).toContain("bare");
 expect(app).not.toContain("高级 / 诊断 · 内部 Git 检查点");
 expect(app).not.toContain("onDeliverSquash");
});

/** 组件接线回归；只证明加载/重试/启动互斥代码存在，不代替真实 DOM 与像素验收。 */
test("执行配置预检失败提供重检入口，检查期间与失败状态均禁止确认",async()=>{
 const source=await Bun.file("src-tauri/web/src/workflow-design.tsx").text();
 expect(source).toContain("重新检查执行配置");
 expect(source).toContain("参数与选择已保留，请重新检查后运行");
 expect(source).toContain("setCheckAttempt(attempt=>attempt+1)");
 expect(source).toContain("identity,checkAttempt]");
 expect(source).toContain("busy||checking||!!planError||!plan||!revision.localOrigin&&!plan.harnessRuntime");
 expect(source).toContain("if(!editable||busy||checking||planError||!plan||!revision.localOrigin&&!plan.harnessRuntime)return");
 expect(source).toContain("setPlanError(local||result.harnessRuntime?null:");
 expect(source).toContain("尚未设置已验证的 Wave Flow CLI，请在执行环境设置中选择");
 expect(source).toContain('role="status"');
 expect(source).toContain('const confirmations=new DesignConfirmationCache()');
 expect(source).toContain('confirmations.get(identity,input,choices,plan,workspaces)');
 expect(source).toContain('workspaceConfirmations.get(identity,plan.workspacePlan,true,plan.continuationPlan)');
 expect(source).toContain('localChoices[worker.id]=runtimeId');
});

test("本地来源替换明确导航到新方案，目标态已有执行不再提示选择无关工作流",async()=>{
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain('openWorkflow(\n                response.harness,\n                response.harness.workflowRevisions.at(-1)!,\n                "plan",\n              )');
 expect(source).not.toContain('运行工作流 → 选择工作流');
 expect(source).not.toContain('查看原工作流与修订方案');
 expect(source).not.toContain('继续准备工作流');
 expect(source).toContain('<AbandonedPlan');
 expect(source).toContain('!harness.executions.length\n                                  ? () => setTemplatePicker(true)');
});
test("详情页页头用方案短名称，完整目标在方案正文而非页头",async()=>{
 const source=await Bun.file("src-tauri/web/src/conversation/revision-card.tsx").text();
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain("hideGoal=false");
 expect(source).toContain('!hideGoal&&<p className="wf-plan-goal">');
 expect(app).toContain("proposalTitle(headerRevision)");
 expect(app).not.toContain("revision={revision} harness={harness} hideGoal");
});
test("窄窗详情底部为固定导航保留安全空间",async()=>{
 const css=await Bun.file("src-tauri/web/src/workbench.css").text();
 expect(css).toContain(".agent-workbench .central-workflow { padding:24px 20px 80px; }");
});

test("影响面总结按所选Execution的受管配置显示Git证据限制，不固定宣称无基线",async()=>{
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain("const gitLimitation = harness.executions.find(");
 expect(source).toContain("受管Git证据仅覆盖受管Git文件；缺失或不可读取的记录不代表没有改动");
 expect(source).toContain("<p>{gitLimitation}</p>");
 expect(source).not.toContain("<p>尚无Git起止基线，不能证明文件归因、完整diff或外部副作用。</p>");
});

test("工作区外写入不再提供文件审批UI或API",async()=>{
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 const api=await Bun.file("src-tauri/web/src/api.ts").text();
 expect(app).not.toContain("FilePermissionCards");
 expect(api).not.toContain("executions.decideFilePermission");
});
