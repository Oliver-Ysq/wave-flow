import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LeadService } from "../../src/lead/service";
import { LeadJournal } from "../../src/lead/journal";
import { normalizeTaskTitle } from "../../src/shared/task-title";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
test("手动名称Unicode长度、空白、换行与类型校验",()=>{
  expect(normalizeTaskTitle("  名称  ")).toBe("名称");
  expect(Array.from(normalizeTaskTitle("😀".repeat(120)))).toHaveLength(120);
  for(const value of ["", "  ","x\ny","x\ry","😀".repeat(121),null,{}])expect(()=>normalizeTaskTitle(value)).toThrow();
});
test("运行中改名耐久，重复保存幂等，不变更创建指纹或重新派发模型",async()=>{
  const root=await mkdtemp(join(tmpdir(),"wf-title-"));roots.push(root);
  let finish!:(value:string)=>void,calls=0;
  const service=new LeadService(root,async()=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:()=>{calls++;return new Promise<string>(resolve=>{finish=resolve;});}}));
  const request={projectId:"project",clientRequestId:crypto.randomUUID(),text:"原始问题"};
  const created=await service.startTask(root,request),id=created.leadRunId;
  for(let n=0;n<100&&!finish;n++)await Bun.sleep(2);
  const manifest=await readFile(join(root,id,"manifest.json"),"utf8");
  const named=await service.renameTitle(id,"  人工名称  ");
  expect(named.status).toBe("running");expect(named.task?.title).toBe("人工名称");expect(named.task?.titleSource).toBe("manual");
  await service.renameTitle(id,"人工名称");
  await expect(service.renameTitle(id,"\n")).rejects.toThrow();
  finish("正常回答");for(let n=0;n<100&&(await service.snapshot(id)).status==="running";n++)await Bun.sleep(2);
  expect(calls).toBe(1);expect(await readFile(join(root,id,"manifest.json"),"utf8")).toBe(manifest);
  const saved=await LeadJournal.open(id,root);
  expect(saved.events.filter(event=>event.type==="lead.title_renamed")).toHaveLength(1);
  expect(saved.snapshot.task?.payloadHash).toBe(created.task?.payloadHash);
  const reopened=new LeadService(root,async()=>{throw Error("不得启动模型");});
  expect((await reopened.startTask(root,request)).task?.title).toBe("人工名称");
  await service.complete(id);
  await expect(service.renameTitle(id,"归档后")).rejects.toThrow("归档");
  expect((await LeadJournal.open(id,root)).snapshot.task?.title).toBe("人工名称");
});
test("v8/v9 Task可以追加改名；无Task旧会话拒绝且不产生标题事件",async()=>{
  const root=await mkdtemp(join(tmpdir(),"wf-title-compat-"));roots.push(root);
  const service=new LeadService(root,async()=>{throw Error("不得启动模型");});
  for(const version of [8,9]){
    const id=crypto.randomUUID();
    await LeadJournal.create({leadRunId:id,cwd:root,version,modelFingerprint:"test",createdAt:new Date().toISOString(),task:{title:"原名",initialGoal:"目标",clientRequestId:crypto.randomUUID(),payloadHash:"a".repeat(64)}},root);
    await service.renameTitle(id,"新版名称");expect((await LeadJournal.open(id,root)).snapshot.task?.title).toBe("新版名称");
  }
  const id=crypto.randomUUID();await LeadJournal.create({leadRunId:id,cwd:root,version:9,modelFingerprint:"test",createdAt:new Date().toISOString()},root);
  await expect(service.renameTitle(id,"拒绝")).rejects.toThrow("元数据");
  expect((await LeadJournal.open(id,root)).events).toHaveLength(1);
});
test("初始化失败后手动改名不破坏原创建请求重试",async()=>{
  const root=await mkdtemp(join(tmpdir(),"wf-title-retry-"));roots.push(root);let fail=true,calls=0;
  const service=new LeadService(root,async()=>{if(fail)throw Error("初始化失败");return {isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{calls++;return "完成";}};});
  const created=await service.startTask(root,{projectId:"project",clientRequestId:crypto.randomUUID(),text:"原问题"});
  await service.renameTitle(created.leadRunId,"手动标题");fail=false;
  await service.retryInitialization(created.leadRunId);
  for(let n=0;n<100&&(await service.snapshot(created.leadRunId)).status==="running";n++)await Bun.sleep(2);
  const snapshot=await service.snapshot(created.leadRunId);expect(snapshot.task?.title).toBe("手动标题");expect(calls).toBe(1);expect(snapshot.messages.filter(item=>item.role==="user")).toHaveLength(1);
});
