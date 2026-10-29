import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessService } from "../../src/harness/service";
import { HarnessJournal, HarnessProjection } from "../../src/harness/journal";
import { assertStartable } from "../../src/harness/task-contract";
import { listWorkflowTemplates } from "../../src/harness/workflow-templates";

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const source=`import { phase } from "wave-flow";\nexport const meta={name:"single",description:"检查",phases:[{title:"检查"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};\nexport default async function run(args:unknown){phase("检查");return {};}`;
async function idle(service:HarnessService,id:string){for(let n=0;n<100;n++){if((await service.snapshot(id)).status!=="running")return;await Bun.sleep(5);}throw Error("回合未结束");}
test("验收Task冻结单链身份，执行后仍同卡修订，放弃不删除旧版",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-single-"));directories.push(root);
 let proposed=0;
 const service=new HarnessService(root,async(_id,_cwd,_prior,actions)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async(text)=>{if(text.startsWith("请总结"))return "执行已取消，现场影响证据不足。";await actions.proposeWorkflowRevision(source,"当前目标","只读",undefined,proposed);proposed++;return "草案";}}),undefined,async()=>({fingerprint:"injected-harness-session"}),true);
 service.setExecutionCapsuleReader(async()=>({status:"cancelled",limitations:"无Git基线"}));
 const task=await service.startTask(root,{clientRequestId:crypto.randomUUID(),projectId:"p",text:"初稿"});await idle(service,task.harnessRunId);
 const first=(await service.snapshot(task.harnessRunId)).workflowRevisions[0]!;
 expect(task.task?.workflowContract).toBe("single-workflow-v1");
 await service.acceptWorkflowRevision(task.harnessRunId,1);
 await service.recordExecutionCreated(task.harnessRunId,{executionId:crypto.randomUUID(),revision:1,sourceHash:first.sourceHash,runtimeVersion:9,policy:{maxNodes:20,maxGates:10,maxPhaseVisits:50},createdAt:new Date().toISOString(),status:"running",finishedAt:null,diagnostic:null,summary:null});
 const execution=(await service.snapshot(task.harnessRunId)).executions[0]!;
 await service.recordExecutionFinished(task.harnessRunId,execution.executionId,"cancelled","用户停止",null,1);
 await service.send(task.harnessRunId,"修改");await idle(service,task.harnessRunId);
 const next=await service.snapshot(task.harnessRunId);
 expect(next.workflowRevisions[1]!.cardId).toBe(first.cardId);expect(next.workflowRevisions[1]!.parentRevision).toBe(1);
 expect(()=>assertStartable(next,2)).toThrow();
 await service.abandonWorkflowCard(task.harnessRunId,first.cardId!);
 const saved=await HarnessJournal.open(task.harnessRunId,root);
 expect(saved.snapshot.workflowRevisions[0]!.abandonedAt).toBeNull();expect(saved.snapshot.workflowRevisions[1]!.abandonedAt).not.toBeNull();
 const obligation=(await service.snapshot(task.harnessRunId)).impactSummaries![0];
 if(obligation.status!=="completed"){await service.retryImpactSummary(task.harnessRunId,obligation.key).catch(()=>{});await idle(service,task.harnessRunId);}
 await service.recordExecutionResumed(task.harnessRunId,execution.executionId);
 expect((await service.snapshot(task.harnessRunId)).executions[0]!.status).toBe("running");
 const projection=new HarnessProjection(saved.journal.manifest);for(const event of saved.events)projection.apply(event);
 expect(()=>projection.apply({type:"workflow.revision_proposed",at:new Date().toISOString(),harnessRunId:task.harnessRunId,revision:{...first,revision:3,cardId:crypto.randomUUID(),parentRevision:2}})).toThrow("单链");
});
test("同链源码提案必须绑定读取版本；缺失、迟到与非法版本零写入",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-revision-fence-"));directories.push(root);
 let callbacks!:import("../../src/harness/action-tools").HarnessActionCallbacks;
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const service=new HarnessService(root,async(_id,_cwd,_prior,actions)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{
   callbacks=actions;entered();await gate;return "草案仅供确认";
 }}),undefined,async()=>({fingerprint:"injected-harness-session"}),true);
 const task=await service.startTask(root,{clientRequestId:crypto.randomUUID(),projectId:"p",text:"准备修订"});
 await started;
 try {
  await callbacks.proposeWorkflowRevision(source,"目标","只读",undefined,0);
  for(const basis of [undefined,0,-1,1.5,2])await expect(callbacks.proposeWorkflowRevision(source,"目标","只读",undefined,basis)).rejects.toThrow();
  expect((await service.snapshot(task.harnessRunId)).workflowRevisions).toHaveLength(1);
  await callbacks.proposeWorkflowRevision(source,"目标","只读",undefined,1);
  await expect(callbacks.proposeWorkflowRevision(source,"迟到","只读",undefined,1)).rejects.toThrow("基础版本已变化");
  const snapshot=await service.snapshot(task.harnessRunId);expect(snapshot.workflowRevisions).toHaveLength(2);expect(snapshot.workflowRevisions[1]!.parentRevision).toBe(1);
 } finally {release();await idle(service,task.harnessRunId);service.close();}
 const reopened=await HarnessJournal.open(task.harnessRunId,root);expect(reopened.snapshot.workflowRevisions).toHaveLength(2);
});
test("已执行模板参数修订沿用冻结来源同卡，迟到基础版本拒绝且不执行",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-template-revision-"));directories.push(root);
 const service=new HarnessService(root,async()=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>"完整影响说明"}),undefined,async()=>({fingerprint:"injected-harness-session"}),true);
 service.setExecutionCapsuleReader(async()=>({status:"completed"}));
 const template=listWorkflowTemplates()[0],selection={id:template.id,version:template.version,sourceHash:template.sourceHash,input:{target:"src/",focus:["正确性"],maxFindings:2,context:""}};
 try{
  const task=await service.startTask(root,{clientRequestId:crypto.randomUUID(),projectId:"p",text:"审查",template:selection}),id=task.harnessRunId;
  await service.acceptWorkflowRevision(id,1);const executionId=crypto.randomUUID();
  await service.recordExecutionCreated(id,{executionId,revision:1,sourceHash:template.sourceHash,runtimeVersion:9,policy:{maxNodes:20,maxGates:10,maxPhaseVisits:50},createdAt:new Date().toISOString(),status:"running",finishedAt:null,summary:null,diagnostic:null});
  await service.recordExecutionFinished(id,executionId,"completed",null,{},1);
  for(let n=0;n<100;n++){if((await service.snapshot(id)).impactSummaries?.[0]?.status==="completed")break;await Bun.sleep(5);}
  const original=(await service.snapshot(id)).workflowRevisions[0];
  expect(original.updateReason).toBe('save-template');
  const revised=await service.saveTemplate(id,crypto.randomUUID(),{...selection,input:{...selection.input,target:"test/"}},original.cardId,undefined,1);
  expect(revised.workflowRevisions[1].cardId).toBe(original.cardId);expect(revised.workflowRevisions[1].parentRevision).toBe(1);expect(revised.workflowRevisions[1].sourceHash).toBe(original.sourceHash);expect(revised.workflowRevisions[1].acceptedAt).toBeNull();expect(revised.executions).toHaveLength(1);
  expect(revised.workflowRevisions[1].updateReason).toBe('modify-parameters');
  expect((await HarnessJournal.open(id,root)).snapshot.workflowRevisions[1].updateReason).toBe('modify-parameters');
  await expect(service.saveTemplate(id,crypto.randomUUID(),selection,original.cardId,undefined,1)).rejects.toThrow("参数版本已更新");
  expect((await HarnessJournal.open(id,root)).snapshot.workflowRevisions[0]).toEqual(original);
 }finally{service.close();}
});