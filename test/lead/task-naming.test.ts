import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {LeadService} from "../../src/lead/service";
import {LeadJournal} from "../../src/lead/journal";
import {DeterministicLeadSession} from "../../src/lead/deterministic-session";
import {parseTaskNamingResult,type TaskNamingContext} from "../../src/lead/task-naming";
import {listWorkflowTemplates} from "../../src/lead/workflow-templates";
import {preflightLocalWorkflow} from "../../src/workflow/preflight-local";
import {DesktopExecutionEngine} from "../../src/desktop/desktop-execution-engine";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(tmpdir(),"wf-naming-"));roots.push(root);return root;}
async function until(check:()=>Promise<boolean>){for(let n=0;n<200;n++){if(await check())return;await Bun.sleep(5);}throw Error("timeout");}
test("最终命名必须严格JSON单字段，禁止解释/代码块/提问/超长",()=>{
  expect(parseTaskNamingResult('{"title":"三人接力写小说"}')).toBe("三人接力写小说");
  for(const value of ['请问叫什么？','```json\n{"title":"标题"}\n```','{"title":"标题","other":1}','[]','{"title":""}','{"title":"a\\nb"}',JSON.stringify({title:"长".repeat(31)})])expect(()=>parseTaskNamingResult(value)).toThrow();
});
test("三种创建来源独立命名一次，重试重开不派发，过程不进入主控Journal",async()=>{
  const root=await fixture(),state=join(root,"state"),contexts:TaskNamingContext[]=[];
  const service=new LeadService(state,async()=>new DeterministicLeadSession(),undefined,undefined,true);
  service.setNamingGenerator(async context=>{contexts.push(context);return JSON.stringify({title:`${context.source}任务`});});
  const request={projectId:"p",clientRequestId:crypto.randomUUID(),text:"用户首条问题"};
  const auto=await service.startTask(root,request);await until(async()=>(await service.snapshot(auto.leadRunId)).task?.title==="auto任务");
  await service.startTask(root,request);expect(contexts).toHaveLength(1);
  const template=listWorkflowTemplates()[0]!;
  const preset=await service.startTask(root,{projectId:"p",clientRequestId:crypto.randomUUID(),text:"预置用途",template:{id:template.id,version:template.version,sourceHash:template.sourceHash,input:template.meta.exampleArgs??{}}});
  await until(async()=>(await service.snapshot(preset.leadRunId)).task?.title==="preset任务");
  const path=join(root,"workflow.ts");await writeFile(path,'export const meta={name:"local-test",description:"自定义用途",phases:[{title:"阶段"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};export default async function run(args:unknown){return {}; }');
  const checked=await preflightLocalWorkflow(path,root);
  const local=await service.startLocalTask(root,{projectId:"p",clientRequestId:crypto.randomUUID(),path,sourceHash:checked.sourceHash,input:{}});
  await until(async()=>(await service.snapshot(local.leadRunId)).task?.title==="local任务");
  expect(contexts.map(c=>c.source)).toEqual(["auto","preset","local"]);expect(contexts[1]?.workflowName).toBe(template.meta.name);expect(contexts[2]?.workflowName).toBe("local-test");expect(JSON.stringify(contexts)).not.toContain("workflow.ts");
  const saved=await LeadJournal.open(auto.leadRunId,state);expect(saved.events.filter(e=>e.type==="lead.naming_attempted")).toHaveLength(1);expect(saved.events.filter(e=>e.type==="lead.title_generated")).toHaveLength(1);expect(saved.snapshot.messages.some(m=>m.text.includes('{"title"'))).toBe(false);
  const reopened=new LeadService(state,async()=>{throw Error("不得启动");});reopened.setNamingGenerator(async()=>{throw Error("不得重命名");});expect((await reopened.startTask(root,request)).task?.title).toBe("auto任务");service.close();reopened.close();
});
test("后台命名不阻塞，人工名称/归档/退出优先，容量满与非法输出保留兜底",async()=>{
  const root=await fixture(),service=new LeadService(join(root,"state"),async()=>new DeterministicLeadSession());
  let resolve!:(text:string)=>void,calls=0;
  service.setNamingGenerator(async()=>{calls++;return new Promise<string>(r=>resolve=r);});
  const request={projectId:"p",clientRequestId:crypto.randomUUID(),text:"兜底标题"};
  const first=await service.startTask(root,request);expect(calls).toBe(1);
  const second=await service.startTask(root,{...request,clientRequestId:crypto.randomUUID()});expect(calls).toBe(1);expect(second.task?.namingAttempted).toBe(true);
  await service.renameTitle(first.leadRunId,"人工标题");resolve('{"title":"迟到自动标题"}');await Bun.sleep(20);expect((await service.snapshot(first.leadRunId)).task?.title).toBe("人工标题");
  for(const mode of ["invalid","archive","exit"]){
    service.setNamingGenerator(async()=>new Promise<string>(r=>resolve=r));
    const task=await service.startTask(root,{...request,clientRequestId:crypto.randomUUID()});await until(async()=>(await service.snapshot(task.leadRunId)).status==="idle");
    if(mode==="archive")await service.complete(task.leadRunId);if(mode==="exit")service.close();
    resolve(mode==="invalid"?'请问你想叫什么？':'{"title":"迟到标题"}');await Bun.sleep(20);
    expect((await service.snapshot(task.leadRunId)).task?.title).toBe("兜底标题");
  }
});
test("Engine新建话题后台命名耐久发布title_changed并允许人工覆盖",async()=>{
  const root=await fixture(),frames:import("../../src/desktop/desktop-execution-engine").EngineEventFrame[]=[];
  const engine=new DesktopExecutionEngine({deterministicForTest:true,storeRoot:join(root,"runs"),leadRoot:join(root,"lead"),generateTaskTitle:async()=>'{"title":"三人接力写小说"}'});
  engine.subscribeEvents(frame=>frames.push(frame));
  try{
    const project=await engine.handleDesktopAction("projects.create",{cwd:root}) as {project:{projectId:string}};
    const created=await engine.handleDesktopAction("leads.startConversation",{projectId:project.project.projectId,clientRequestId:crypto.randomUUID(),text:"新建novel并派三个Agent写小说"}) as {lead:import("../../src/lead/types").LeadSnapshot};
    const id=created.lead.leadRunId;
    await until(async()=>((await engine.handleDesktopAction("leads.get",{leadRunId:id})) as {lead:import("../../src/lead/types").LeadSnapshot}).lead.task?.title==="三人接力写小说");
    expect(frames.some(frame=>frame.stream==="lead"&&frame.event.type==="title_changed")).toBe(true);
    await engine.handleDesktopAction("leads.renameTitle",{leadRunId:id,title:"用户改名"});
    expect((await LeadJournal.open(id,join(root,"lead"))).snapshot.task?.title).toBe("用户改名");
  }finally{engine.shutdown();}
});
