import {expect,test} from "bun:test";
import {designExecutionConfig,DesignConfirmationCache,WorkspaceConfirmationCache} from "../../src-tauri/web/src/workflow-design-config";
import type {ExecutionPlanResponse,RuntimeCli} from "../../src-tauri/web/src/types";
const runtime=(runtimeId:string,cli:RuntimeCli)=>({runtimeId,cli,status:"verified",verifiedAdapter:{adapterId:`${cli}-acp`,adapterVersion:"1",harnessTools:true}});
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
test("新增 CLI 种类（claude/dsh）作为 Worker 候选参与分配，不与 codex/kimi 混淆",()=>{
 const wide={workers:[{id:"writer"}],pool:[runtime("a","claude"),runtime("d","dsh"),runtime("c","codex")],harnessRuntime:runtime("c","codex")} as unknown as ExecutionPlanResponse;
 const config=designExecutionConfig(wide,{writer:"d"},"2026-10-20T00:00:00Z");
 expect(config.assignments[0]).toMatchObject({agentId:"writer",cli:"dsh",adapterId:"dsh-acp",runtimeId:"d",source:"user"});
 expect(config.defaultAssignment.cli).toBe("codex");
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
test("Git授权并入确认运行：dirty须明确排除，失败重试复用授权UUID与同一worktree",()=>{
 const cache=new WorkspaceConfirmationCache();const workspacePlan={nodeIds:["a","b"],repository:"/repo",baseCommit:"a".repeat(40),dirtyPaths:["user.txt"],diagnostic:null};
 expect(()=>cache.get("task",workspacePlan,false)).toThrow("dirty");
 const first=cache.get("task",workspacePlan,true),retry=cache.get("task",workspacePlan,true);
 expect(retry).toEqual(first);expect(first.version).toBe(3);
 expect(first.authorization.nodes).toEqual([{nodeId:"a"},{nodeId:"b"}]);
 expect(first.workspaceId).toMatch(/^[0-9a-f-]{36}$/);expect(first.continuation).toBeUndefined();
 expect(first.authorization.nodes[0]).not.toHaveProperty("paths");
});
test("续作自动复用原共享worktree并冻结原HEAD，新基准不串用授权",()=>{
 const cache=new WorkspaceConfirmationCache(),workspaceId=crypto.randomUUID();
 const plan={nodeIds:["repair"],repository:"/repo",baseCommit:"a".repeat(40),dirtyPaths:[],diagnostic:null};
 const continuation={executionId:crypto.randomUUID(),baseCommit:plan.baseCommit,workspaceId,head:"b".repeat(40)};
 const first=cache.get("task:2",plan,false,continuation);
 expect(first.workspaceId).toBe(workspaceId);
 expect(first.continuation).toEqual({executionId:continuation.executionId,workspaceId,head:"b".repeat(40)});
 expect(first.authorization.nodes).toEqual([{nodeId:"repair"}]);
 expect(cache.get("task:2",plan,false,continuation)).toEqual(first);
 const drifted=cache.get("task:2",plan,false,{...continuation,head:"c".repeat(40)});
 expect(drifted.authorization.authorizationId).not.toBe(first.authorization.authorizationId);
 expect(drifted.workspaceId).toBe(workspaceId);
});
