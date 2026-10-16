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

test("普通构建拒绝本地预检IPC，不依赖前端隐藏入口",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-preflight-disabled-"));roots.push(root);
 const engine=new DesktopExecutionEngine({harnessRoot:join(root,"harness-runs"),storeRoot:join(root,"runs"),deterministicForTest:true});
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
