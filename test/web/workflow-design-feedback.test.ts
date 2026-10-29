import {expect,test} from "bun:test";

test("单版本不显示无效版本下拉，多版本保留切换入口",async()=>{
 const app=await Bun.file('src-tauri/web/src/App.tsx').text();
 expect(app).toContain('<WorkflowVersions\n');
 expect(app).not.toContain('<label>方案版本<select');
});

test("执行总结只在主控对话中提示，结果页不重复展示总结与现场补充", async () => {
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(source).toContain("ImpactSummaryNotice");
 expect(source).toContain('summaryKey={item.key}');
 expect(source).toContain('(item) => !item.supersededBy && item.status !== "completed"');
 expect(source).not.toContain('aria-label="原总结与补充"');
 expect(source).not.toContain("ImpactSummaryPanel");
 expect(source).not.toContain("重新检查现场");
});
test("归档与旧Execution隐藏成果恢复合入清理，不保留变更面板",async()=>{
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 expect(app).toContain('(harness.task?.workflowContract === "single-workflow-v1" &&');
 expect(app).toContain('harness.executions.at(-1)?.executionId !==');
 expect(app).toContain('所选工作流记录暂时不可用');
 expect(app).not.toContain('所选工作流记录已失效');
 expect(app).toContain('(detail.workspaceEvidence?.leases.length ?? 0) > 0');
 expect(app).not.toContain('TEMP DEBUG');
 expect(app).toContain('{!readOnly && (');
 expect(app).toContain('<div className="execution-actions">');
 expect(app).not.toContain('<ChangesPanel');
 expect(app).not.toContain('changes-panel');
 expect(app).not.toContain("executions.merge");
 expect(app).not.toContain("changesWritable");
});

test("整工作区授权并入确认运行，结果保留在 worktree，内部检查点默认折叠",async()=>{
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 const design=await Bun.file("src-tauri/web/src/workflow-design.tsx").text();
 expect(design).toContain("完成后改动保留在工作区，不会自动写入项目目录");
 expect(design).not.toContain("本次执行共用一个工作区");
 expect(design).not.toContain("基于版本");
 expect(design).not.toContain("循环写节点按已披露前缀生成");
 expect(design).not.toContain("工作区分组");
 expect(design).not.toContain("集成来源节点");
 expect(design).not.toContain("接续上次改动");
 expect(design).not.toContain("approveGit");
 expect(app).not.toContain("<ChangesPanel");
 expect(app).not.toContain("成果还没有保存完整");
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
 expect(source).toContain("重新检查执行环境");
 expect(source).toContain("参数已保留，请稍后重新检查");
 expect(source).toContain("setCheckAttempt(attempt=>attempt+1)");
 expect(source).toContain("identity,checkAttempt]");
 expect(source).toContain("busy||checking||!!planError||!plan||!local&&!script&&!plan.harnessRuntime");
 expect(source).toContain("if(!editable||busy||checking||planError||!plan||!local&&!script&&!plan.harnessRuntime)return");
 expect(source).toContain("setPlanError(local||script||result.harnessRuntime?null:");
 expect(source).toContain("还没有选择可用的本地执行工具");
 expect(source).toContain('role="status"');
 expect(source).toContain('const confirmations=new DesignConfirmationCache()');
 expect(source).toContain('confirmations.script(identity,input,plan,workspaces)');
 expect(source).toContain('workspaceConfirmations.get(identity,plan.workspacePlan,true,plan.continuationPlan)');
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

test("结果页不再展示Git证据限制说明，诚实约束由总结正文承担",async()=>{
 const source=await Bun.file("src-tauri/web/src/App.tsx").text();
 const service=await Bun.file("src/harness/service.ts").text();
 expect(source).not.toContain("const gitLimitation = harness.executions.find(");
 expect(source).not.toContain("受管Git证据仅覆盖受管Git文件");
 expect(service).toContain("不要因为结构化校验通过就说结果正确");
});

test("工作区外写入不再提供文件审批UI或API",async()=>{
 const app=await Bun.file("src-tauri/web/src/App.tsx").text();
 const api=await Bun.file("src-tauri/web/src/api.ts").text();
 expect(app).not.toContain("FilePermissionCards");
 expect(api).not.toContain("executions.decideFilePermission");
});
