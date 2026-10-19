import {expect,test} from "bun:test";
import {designExecutionConfig,DesignConfirmationCache,WorkspaceConfirmationCache} from "../../src-tauri/web/src/workflow-design-config";
import type {ExecutionPlanResponse} from "../../src-tauri/web/src/types";
const runtime=(runtimeId:string,cli:"codex"|"kimi")=>({runtimeId,cli,status:"verified",verifiedAdapter:{adapterId:cli==="codex"?"codex-acp":"kimi-acp",adapterVersion:"1",harnessTools:true}});
const plan={workers:[{id:"reviewer"},{id:"verifier"}],pool:[runtime("c","codex"),runtime("k","kimi")],harnessRuntime:runtime("c","codex")} as unknown as ExecutionPlanResponse;
test("内联CLI默认主控，手工选择记录user，动态默认与固定Worker独立",()=>{
 const config=designExecutionConfig(plan,{verifier:"k","*":"k"},"2026-10-16T00:00:00Z");
 expect(config.assignments[0]).toMatchObject({agentId:"reviewer",cli:"codex",source:"harness-cli"});
 expect(config.assignments[1]).toMatchObject({agentId:"verifier",cli:"kimi",source:"user"});
 expect(config.defaultAssignment).toMatchObject({cli:"kimi",source:"user"});
 expect(config.fallbackRuntimeId).toBe("c");expect(config.ruleText).toBeNull();
});
test("内联CLI失效或未知节点拒绝，不静默随机或替换",()=>{
 expect(()=>designExecutionConfig(plan,{reviewer:"missing"})).toThrow("不可用");
 expect(()=>designExecutionConfig(plan,{ghost:"c"})).toThrow("未知");
});
test("导航后相同确认重试复用UUID和原配置，读取副本不能污染缓存",()=>{
 const cache=new DesignConfirmationCache();
 const first=cache.get("task:card:1",{target:"a.ts"},{reviewer:"k"},plan);
 const expected=structuredClone(first);
 first.config.assignments[0]!.runtimeId="mutated";
 const retry=cache.get("task:card:1",{target:"a.ts"},{reviewer:"k"},plan);
 expect(retry).toEqual(expected);
});
test("参数或CLI改变生成新确认，返回原载荷仍复用原请求，身份之间不串用",()=>{
 const cache=new DesignConfirmationCache();
 const first=cache.get("task:card:1",{target:"a.ts"},{},plan);
 expect(cache.get("task:card:1",{target:"b.ts"},{},plan).id).not.toBe(first.id);
 expect(cache.get("task:card:1",{target:"a.ts"},{reviewer:"k"},plan).id).not.toBe(first.id);
 expect(cache.get("other:card:1",{target:"a.ts"},{},plan).id).not.toBe(first.id);
 expect(cache.get("task:card:2",{target:"a.ts"},{},plan).id).not.toBe(first.id);
 expect(cache.get("task:card:1",{target:"a.ts"},{},plan)).toEqual(first);
});
test("确认缓存有界且App新会话不假装恢复旧请求",()=>{
 const cache=new DesignConfirmationCache();
 const first=cache.get("task:card:1",{}, {},plan);
 for(let i=0;i<64;i++)cache.get(`other:card:${i}`,{}, {},plan);
 expect(cache.get("task:card:1",{}, {},plan).id).not.toBe(first.id);
 expect(new DesignConfirmationCache().get("task:card:1",{}, {},plan).id).not.toBe(first.id);
});
test("最新现场证据变化使旧确认UUID失效，返回旧现场仍只复用旧请求",()=>{
 const cache=new DesignConfirmationCache();
 const first=cache.get("task:card:2",{}, {},{...plan,sceneEvidenceHash:"a".repeat(64)});
 const changed=cache.get("task:card:2",{}, {},{...plan,sceneEvidenceHash:"b".repeat(64)});
 expect(changed.id).not.toBe(first.id);
 expect(cache.get("task:card:2",{}, {},{...plan,sceneEvidenceHash:"a".repeat(64)})).toEqual(first);
});
test("Git授权并入确认运行：dirty须明确排除，失败重试复用授权UUID",()=>{
 const cache=new WorkspaceConfirmationCache();const workspacePlan={nodeIds:["a","integrate"],repository:"/repo",baseCommit:"a".repeat(40),dirtyPaths:["user.txt"],diagnostic:null};
 const drafts={a:{resources:"port:4173",workspaceId:crypto.randomUUID()},integrate:{resources:"",workspaceId:crypto.randomUUID(),sources:"a"}};
 expect(()=>cache.get("task",workspacePlan,drafts,false)).toThrow("dirty");
 const first=cache.get("task",workspacePlan,drafts,true),retry=cache.get("task",workspacePlan,drafts,true);expect(retry).toEqual(first);expect(first.bindings[1]?.integrationSources).toEqual({nodeIds:["a"]});expect(first.authorization.nodes[0]?.externalResources).toEqual(["port:4173"]);
 expect(first.version).toBe(2); expect(first.authorization.nodes[0]).not.toHaveProperty("paths");
 expect(cache.get("task",workspacePlan,{...drafts,a:{...drafts.a,resources:"port:9999"}},true).authorization.authorizationId).not.toBe(first.authorization.authorizationId);
});
test("独立工作区不预填文件，相同分组顺序复用允许且不生成第二worktree",()=>{
 const cache=new WorkspaceConfirmationCache(),workspacePlan={nodeIds:["a","b"],repository:"/repo",baseCommit:"a".repeat(40),dirtyPaths:[],diagnostic:null};
 const drafts={a:{resources:"",workspaceId:crypto.randomUUID()},b:{resources:"",workspaceId:crypto.randomUUID()}};
 expect(cache.get("task",workspacePlan,drafts,false).bindings[0]?.workspaceId).not.toBe(drafts.b.workspaceId);
 const value=cache.get("task",workspacePlan,{a:{...drafts.a,workspaceGroup:"chain"},b:{...drafts.b,workspaceGroup:"chain"}},false);
 expect(value.bindings[0]?.workspaceId).toBe(value.bindings[1]?.workspaceId);
});
test("修订写配置须明确继承保存现场，冻结原HEAD且独立新授权",()=>{
 const cache=new WorkspaceConfirmationCache(),workspaceId=crypto.randomUUID(),plan={nodeIds:["repair"],repository:"/repo",baseCommit:"a".repeat(40),dirtyPaths:[],diagnostic:null};
 const continuation={executionId:crypto.randomUUID(),baseCommit:plan.baseCommit,workspaces:[{workspaceId,commit:"b".repeat(40),nodeIds:["old"],ready:false}]};
 expect(()=>cache.get("task:2",plan,{},false,continuation)).toThrow("明确选择");
 const draft={repair:{resources:"",workspaceId}},first=cache.get("task:2",plan,draft,false,continuation);
 expect(first.continuation).toEqual({executionId:continuation.executionId,heads:[{workspaceId,commit:"b".repeat(40)}]});
 expect(first.bindings[0].nodeId).toBe("repair");expect(cache.get("task:2",plan,draft,false,continuation)).toEqual(first);
 expect(cache.get("task:2",plan,draft,false,{...continuation,workspaces:[{...continuation.workspaces[0],commit:"c".repeat(40)}]}).authorization.authorizationId).not.toBe(first.authorization.authorizationId);
});
test("顺序修订选择完整集成现场仍冻结全部历史分支，由宿主验证覆盖不复制旧节点",()=>{
 const cache=new WorkspaceConfirmationCache(),a=crypto.randomUUID(),integrated=crypto.randomUUID();
 const plan={nodeIds:["repair"],repository:"/repo",baseCommit:"a".repeat(40),dirtyPaths:[],diagnostic:null};
 const continuation={executionId:crypto.randomUUID(),baseCommit:plan.baseCommit,workspaces:[{workspaceId:a,commit:"b".repeat(40),nodeIds:["old-a"],ready:true},{workspaceId:integrated,commit:"c".repeat(40),nodeIds:["integrate"],ready:true}]};
 const result=cache.get("task:2",plan,{repair:{resources:"",workspaceId:integrated}},false,continuation);
 expect(result.bindings).toEqual([{nodeId:"repair",workspaceId:integrated}]);expect(result.continuation?.heads).toHaveLength(2);
});
