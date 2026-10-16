import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessService } from "../../src/harness/service";
import { HarnessJournal, HarnessProjection } from "../../src/harness/journal";
import { assertStartable } from "../../src/harness/task-contract";

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const source=`const meta={name:"single",description:"检查",phases:[{title:"检查"}]};async function run(args:unknown){phase("检查");return {};}`;
async function idle(service:HarnessService,id:string){for(let n=0;n<100;n++){if((await service.snapshot(id)).status!=="running")return;await Bun.sleep(5);}throw Error("回合未结束");}
test("验收Task冻结单链身份，执行后仍同卡修订，放弃不删除旧版",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-single-"));directories.push(root);
 const service=new HarnessService(root,async(_id,_cwd,_prior,actions)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async(text)=>{if(text.startsWith("请总结"))return "执行已取消，现场影响证据不足。";await actions.proposeWorkflowRevision(source,"当前目标","只读");return "草案";}}),undefined,async()=>({fingerprint:"injected-harness-session"}),true);
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
