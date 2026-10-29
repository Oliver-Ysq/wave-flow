import {expect,test} from "bun:test";
import {DesignConfirmationCache,WorkspaceConfirmationCache} from "../../src-tauri/web/src/workflow-design-config";
import type {ExecutionPlanResponse,RuntimeCli} from "../../src-tauri/web/src/types";
const runtime=(runtimeId:string,cli:RuntimeCli)=>({runtimeId,cli,status:"verified",verifiedAdapter:{adapterId:`${cli}-acp`,adapterVersion:"1",harnessTools:true}});
const plan={workers:[{id:"reviewer"},{id:"verifier"}],pool:[runtime("c","codex"),runtime("k","kimi")],harnessRuntime:runtime("c","codex")} as unknown as ExecutionPlanResponse;

test("脚本模式只读确认不产生执行配置，相同载荷复用 UUID",()=>{
 const cache=new DesignConfirmationCache();
 const first=cache.script("task:card:1",{target:"a.ts"},plan);
 expect(first.config).toBeUndefined();
 expect(cache.script("task:card:1",{target:"a.ts"},plan)).toEqual(first);
 expect(cache.script("task:card:1",{target:"b.ts"},plan).id).not.toBe(first.id);
 expect(cache.script("other:card:1",{target:"a.ts"},plan).id).not.toBe(first.id);
});
test("脚本模式写类确认只承载 workspaces，现场证据变化产生新 UUID",()=>{
 const cache=new DesignConfirmationCache();
 const workspaces={version:3 as const,authorization:{authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:"/repo",baseCommit:"a".repeat(40),excludeExistingDirty:false,nodes:[{nodeId:"reviewer"}]},workspaceId:crypto.randomUUID()};
 const first=cache.script("task:card:2",{},plan,workspaces);
 expect(first.config).toMatchObject({version:1,assignmentMode:"script",workspaces});
 const cloned=structuredClone(first);(cloned.config!.workspaces as {workspaceId:string}).workspaceId="mutated";
 expect(cache.script("task:card:2",{},plan,workspaces)).toEqual(first);
 const changed=cache.script("task:card:2",{}, {...plan,sceneEvidenceHash:"b".repeat(64)},workspaces);
 expect(changed.id).not.toBe(first.id);
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
test("循环写节点前缀随确认载荷冻结并在重试中复用",()=>{
 const cache=new WorkspaceConfirmationCache();
 const loopPlan={nodeIds:["reviewer"],dynamicNodePrefixes:["repair-"],repository:"/repo",baseCommit:"a".repeat(40),dirtyPaths:[],diagnostic:null};
 const first=cache.get("task:loop",loopPlan,false);
 expect(first.authorization.nodes).toEqual([{nodeId:"reviewer"}]);
 expect(first.authorization.dynamicNodes).toEqual([{nodeIdPrefix:"repair-"}]);
 expect(cache.get("task:loop",loopPlan,false)).toEqual(first);
 const fixed={nodeIds:["reviewer"],repository:"/repo",baseCommit:"a".repeat(40),dirtyPaths:[],diagnostic:null};
 expect(cache.get("task:fixed",fixed,false).authorization).not.toHaveProperty("dynamicNodes");
});
