import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopExecutionEngine } from "../../src/desktop/desktop-execution-engine";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test("本地预检IPC只读取Project指定文件，不创建Task/Run或返回源码",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-preflight-ipc-"));roots.push(root);
 const engine=new DesktopExecutionEngine({harnessRoot:join(root,"state","harness-runs"),storeRoot:join(root,"state","runs"),deterministicForTest:true,singleWorkflowForAcceptance:true});
 try{
   const result=await engine.handleDesktopAction("projects.create",{cwd:root}) as {project:{projectId:string}};
   const file=join(root,"workflow.ts");
   await writeFile(file,`export const meta={name:"ipc",description:"检查",phases:[{title:"检查"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};export default async function run(args:unknown){throw Error("不允许预检执行");}`);
   const preview=await engine.handleDesktopAction("workflows.preflightLocal",{projectId:result.project.projectId,path:file});
   expect(preview).toMatchObject({meta:{name:"ipc"},inputSchema:{type:"object"}});expect(preview).not.toHaveProperty("source");
   expect(await engine.handleDesktopAction("harnesses.list",{})).toMatchObject({harnesses:[]});
   expect(await engine.handleDesktopAction("runs.list",{})).toEqual([]);
   await expect(engine.handleDesktopAction("workflows.preflightLocal",{projectId:"不存在",path:file})).rejects.toThrow("未知项目");
 }finally{engine.shutdown();}
});

test("显式关闭新Task契约的兼容实例拒绝本地预检IPC",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-preflight-disabled-"));roots.push(root);
 const engine=new DesktopExecutionEngine({harnessRoot:join(root,"harness-runs"),storeRoot:join(root,"runs"),deterministicForTest:true,singleWorkflowForAcceptance:false});
 try{await expect(engine.handleDesktopAction("workflows.preflightLocal",{projectId:"p",path:"a.ts"})).rejects.toThrow("专用验收");}
 finally{engine.shutdown();}
});

test("本地确认不需要分配快照，相同UUID不重复执行，配置覆盖零执行",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-local-confirm-"));roots.push(root);
 const engine=new DesktopExecutionEngine({harnessRoot:join(root,"state","harness-runs"),storeRoot:join(root,"state","runs"),deterministicForTest:true,singleWorkflowForAcceptance:true});
 try{
  const {project}=await engine.handleDesktopAction("projects.create",{cwd:root}) as {project:{projectId:string}};
  const path=join(root,"a.ts");await writeFile(path,`export const meta={name:"local",description:"确认",phases:[{title:"检查"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};export default async function run(args:unknown){return {ok:true};}`);
  const preview=await engine.handleDesktopAction("workflows.preflightLocal",{projectId:project.projectId,path}) as {sourceHash:string};
  const {harness}=await engine.handleDesktopAction("workflows.createLocalTask",{projectId:project.projectId,path,sourceHash:preview.sourceHash,input:{},clientRequestId:crypto.randomUUID()}) as {harness:{harnessRunId:string}};
  const request={harnessRunId:harness.harnessRunId,revision:1,clientRequestId:crypto.randomUUID()};
  await expect(engine.handleDesktopAction("executions.confirm",{...request,config:{}})).rejects.toThrow("不接受");
  const created=await engine.handleDesktopAction("executions.confirm",request) as {execution:{executionId:string;kind:string;config?:unknown}};
  expect(created.execution.kind).toBe("local-run");expect(created.execution.config).toBeUndefined();
  const retry=await engine.handleDesktopAction("executions.confirm",request) as typeof created;
  expect(retry.execution.executionId).toBe(created.execution.executionId);
 }finally{engine.shutdown();}
});
test("本地同链修订绑定现场确认，新Execution保留旧结果；重复UUID零重派发",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-local-revision-"));roots.push(root);
 const engine=new DesktopExecutionEngine({harnessRoot:join(root,"state","harness-runs"),storeRoot:join(root,"state","runs"),deterministicForTest:true,singleWorkflowForAcceptance:true});
 const source=(value:number)=>`export const meta={name:"local",description:"核验",phases:[{title:"检查"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};export default async function run(args:unknown){return {value:${value}};}`;
 const wait=async(id:string,executionId:string)=>{for(let n=0;n<200;n++){const {harness}=await engine.handleDesktopAction("harnesses.get",{harnessRunId:id}) as {harness:import("../../src/harness/types").HarnessSnapshot};if(harness.impactSummaries?.some(item=>item.executionId===executionId&&item.status==="completed"))return harness;await Bun.sleep(5);}throw Error("总结未完成");};
 try{
  const {project}=await engine.handleDesktopAction("projects.create",{cwd:root}) as {project:{projectId:string}},path=join(root,"a.ts");await writeFile(path,source(1));
  let preview=await engine.handleDesktopAction("workflows.preflightLocal",{projectId:project.projectId,path}) as {sourceHash:string};
  const {harness}=await engine.handleDesktopAction("workflows.createLocalTask",{projectId:project.projectId,path,sourceHash:preview.sourceHash,input:{},clientRequestId:crypto.randomUUID()}) as {harness:{harnessRunId:string}},id=harness.harnessRunId;
  const first=await engine.handleDesktopAction("executions.confirm",{harnessRunId:id,revision:1,clientRequestId:crypto.randomUUID()}) as import("../../src/desktop/types").ExecutionResponse;
  const old=await wait(id,first.execution.executionId);
  await writeFile(path,source(2));preview=await engine.handleDesktopAction("workflows.preflightLocal",{projectId:project.projectId,path}) as {sourceHash:string};
  await engine.handleDesktopAction("workflows.reviseLocalTask",{harnessRunId:id,baseRevision:1,sourceHash:preview.sourceHash,input:{},clientRequestId:crypto.randomUUID()});
  const plan=await engine.handleDesktopAction("executions.plan",{harnessRunId:id,revision:2}) as import("../../src/desktop/types").ExecutionPlanResponse;
  const request={harnessRunId:id,revision:2,clientRequestId:crypto.randomUUID(),sceneEvidenceHash:plan.sceneEvidenceHash};
  await expect(engine.handleDesktopAction("executions.confirm",{...request,sceneEvidenceHash:"a".repeat(64)})).rejects.toThrow("现场证据已变化");
  const second=await engine.handleDesktopAction("executions.confirm",request) as typeof first;
  expect((await engine.handleDesktopAction("executions.confirm",request) as typeof first).execution.executionId).toBe(second.execution.executionId);
  const next=await wait(id,second.execution.executionId);expect(next.executions).toHaveLength(2);expect(next.executions[0]).toEqual(old.executions[0]);expect(next.executions[1].summary).toEqual({value:2});
  await expect(engine.handleDesktopAction("executions.resume",{harnessRunId:id,executionId:first.execution.executionId})).rejects.toThrow("旧执行只能查看历史");
  await expect(engine.handleDesktopAction("executions.confirm",{...request,sceneEvidenceHash:"b".repeat(64)})).rejects.toThrow("相同确认请求");
 }finally{engine.shutdown();}
});
