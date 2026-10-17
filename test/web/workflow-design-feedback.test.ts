import {expect,test} from "bun:test";

test("结果页逐一显示原总结与现场补充，过时义务不暴露重试按钮或计入归档待办", async () => {
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain('aria-label="原总结与现场补充"');
 expect(source).toContain('summaryKey={item.key}');
 expect(source).toContain('if(obligation.supersededBy)return');
 expect(source).toContain('此现场补充已被新的证据版本替代');
 expect(source).toContain('filter(item=>!item.supersededBy&&item.status!=="completed")');
 expect(source).toContain('重试 Git 成果收尾（不重跑业务）');
 expect(source).toContain('重新检查现场并重试补充');
 expect(source).toContain('api.checkExecutionScene');
});
test("归档与旧Execution隐藏成果恢复合入清理，保留diff阅读",async()=>{
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(app).toContain('readOnly={harness.status==="completed"||harness.task?.workflowContract==="single-workflow-v1"&&harness.executions.at(-1)?.executionId!==executionDetail.execution.executionId}');
 expect(app).toContain('writable={!readOnly&&Boolean(onCleanupWorkspaces)&&!historical}');
 expect(app).toContain('!readOnly&&!historical&&detail.workspaceEvidence');
 expect(app).toContain('{!readOnly&&<div className="actions">');
});

test("整工作区授权与显式diff合入，内部检查点默认折叠",async()=>{
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 const design=await Bun.file("src-tauri/web/src/workflow-design.tsx").text();
 expect(design).toContain("授权保存整个 worktree 的实际 Git 改动");
 expect(design).not.toContain("成果文件路径（每行一个）");
 expect(app).toContain("<GitReviewPanel");
 const review=await Bun.file("src-tauri/web/src/git-review.tsx").text();expect(review).toContain("确认 squash 合入");expect(review).toContain("generation.current === token");
 expect(app).toContain("尚未形成完整成果来源");
 expect(app).toContain("<summary>内部 Git 检查点与诊断详情</summary>");
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
 expect(source).toContain("尚未设置已验证主控 CLI，请在执行底座设置中验证并选择");
 expect(source).toContain('role="status"');
 expect(source).toContain('const confirmations=new DesignConfirmationCache()');
 expect(source).toContain('confirmations.get(identity,input,choices,plan,workspaces)');
 expect(source).toContain('workspaceConfirmations.get(identity,plan.workspacePlan,workspaceDraft,excludeDirty,approveGit,plan.continuationPlan)');
 expect(source).toContain('localChoices[worker.id]=runtimeId');
});

test("本地来源替换明确导航到新方案，目标态已有执行不再提示选择无关工作流",async()=>{
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain('openWorkflow(response.harness,response.harness.workflowRevisions.at(-1)!,"plan")');
 expect(source).not.toContain('运行工作流 → 选择工作流');
 expect(source).not.toContain('查看原工作流与修订方案');
 expect(source).not.toContain('继续准备工作流');
 expect(source).toContain('<AbandonedPlan');
 expect(source).toContain('onTemplate={!harness.executions.length?');
});
test("详情页隐藏重复目标标题且缩短导航留白，保留对话独立卡目标",async()=>{
 const source=await Bun.file("src-tauri/web/src/conversation/revision-card.tsx").text();
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain("hideGoal=false");
 expect(source).toContain('!hideGoal&&<p className="wf-plan-goal">');
 expect(app).toContain("revision={revision} harness={harness} hideGoal");
});
test("窄窗详情底部为固定导航保留安全空间",async()=>{
 const css=await Bun.file("src-tauri/web/src/workbench.css").text();
 expect(css).toContain(".agent-workbench .central-workflow { padding:24px 20px 80px; }");
});

test("影响面总结按所选Execution的受管配置显示Git证据限制，不固定宣称无基线",async()=>{
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain("const gitLimitation=harness.executions.find(item=>item.executionId===executionId)?.config?.workspaces");
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
