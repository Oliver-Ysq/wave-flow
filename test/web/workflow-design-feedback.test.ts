import {expect,test} from "bun:test";

/** 组件接线回归；只证明加载/重试/启动互斥代码存在，不代替真实 DOM 与像素验收。 */
test("执行配置预检失败提供重检入口，检查期间与失败状态均禁止确认",async()=>{
 const source=await Bun.file("src-tauri/web/src/workflow-design.tsx").text();
 expect(source).toContain("重新检查执行配置");
 expect(source).toContain("参数与选择已保留，请重新检查后运行");
 expect(source).toContain("setCheckAttempt(attempt=>attempt+1)");
 expect(source).toContain("identity,checkAttempt]");
 expect(source).toContain("busy||checking||!!planError||!plan?.harnessRuntime");
 expect(source).toContain("if(!editable||busy||checking||planError||!plan?.harnessRuntime)return");
 expect(source).toContain("setPlanError(result.harnessRuntime?null:");
 expect(source).toContain("尚未设置已验证主控 CLI，请在执行底座设置中验证并选择");
 expect(source).toContain('role="status"');
 expect(source).toContain('const confirmations=new DesignConfirmationCache()');
 expect(source).toContain('confirmations.get(identity,input,choices,plan)');
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
