import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {HarnessService} from "../../src/harness/service";
import {HarnessJournal} from "../../src/harness/journal";
import {assertImpactSummariesComplete,boundedEvidence} from "../../src/harness/impact-summary";
import type {HarnessSession} from "../../src/harness/session";
import {AcpHarnessSession} from "../../src/harness/acp-harness";
import type {AcpSessionClient} from "../../src/adapters/acp-session";
import type * as acp from "@agentclientprotocol/sdk";

const roots:string[]=[],services:HarnessService[]=[];
afterEach(async()=>{for(const service of services.splice(0))service.close();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const source=`const meta={name:"impact",description:"影响面",phases:[{title:"检查"}]};async function run(args:unknown){return {};}`;
async function settled(service:HarnessService,id:string){for(let n=0;n<200;n++){if((await service.snapshot(id)).status!=="running")return;await Bun.sleep(5);}throw Error("回合未结束");}
async function summaryStarted(service:HarnessService,id:string){for(let n=0;n<400;n++){if((await service.snapshot(id)).impactSummaries![0].status!=="pending")return;await Bun.sleep(5);}throw Error("总结未开始");}
async function fixture(prompt:()=>Promise<string>, singleWorkflow=true){
 const root=await mkdtemp(join(tmpdir(),"wave-flow-impact-"));roots.push(root);
 const factory=async():Promise<HarnessSession>=>({isRunning:true,prompt,subscribe:()=>()=>{},abort:()=>{},close:()=>{}});
 const service=new HarnessService(root,factory,undefined,async()=>({fingerprint:"injected-harness-session"}),true);services.push(service);
 const task=await service.create(root,"p",{clientRequestId:crypto.randomUUID(),payloadHash:"a".repeat(64),title:"总结",initialGoal:"目标",...(singleWorkflow?{workflowContract:"single-workflow-v1" as const}:{})});
 // 夹具仅建立原执行登记，不启动Worker。
 const journal=(await HarnessJournal.open(task.harnessRunId,root)).journal;
 const revision={revision:1,cardId:crypto.randomUUID(),parentRevision:null,goal:"目标",scope:"只读",abandonedAt:null,turnId:task.messages[0].id,source,sourceHash:(await import("node:crypto")).createHash("sha256").update(source).digest("hex"),createdAt:new Date().toISOString(),acceptedAt:null};
 // 通过独立Journal建立后重开服务，避免绕过服务投影。
 await journal.append({type:"workflow.revision_proposed",at:revision.createdAt,harnessRunId:task.harnessRunId,revision});
 await journal.append({type:"workflow.revision_accepted",at:revision.createdAt,harnessRunId:task.harnessRunId,revision:1});
 const executionId=crypto.randomUUID();
 await journal.append({type:"workflow.execution_created",at:revision.createdAt,harnessRunId:task.harnessRunId,execution:{executionId,revision:1,sourceHash:revision.sourceHash,runtimeVersion:9,policy:{maxNodes:20,maxGates:10,maxPhaseVisits:50},createdAt:revision.createdAt,status:"running",finishedAt:null,diagnostic:null,summary:null}});
 service.close();
 const reopened=new HarnessService(root,factory,undefined,async()=>({fingerprint:"injected-harness-session"}),true);services.push(reopened);
 reopened.setExecutionCapsuleReader(async(_task,ex,attempt)=>({executionId:ex,attempt,status:"cancelled",input:{token:"secret-value"},nodes:[],validation:"未覆盖"}));
 await reopened.recordExecutionFinished(task.harnessRunId,executionId,"cancelled","用户停止",null,1);
 return {service:reopened,id:task.harnessRunId,executionId,root};
}

test("终态同事件建立一义务，失败门禁、重试完整耐久且不伪造用户消息",async()=>{
 let fail=true,calls=0;
 const {service,id,executionId,root}=await fixture(async()=>{calls++;if(fail)throw Error("模型故障");return "执行已取消。没有已验证交付，文件及外部影响证据不足。下一步先检查现场。";});
 await summaryStarted(service,id);await settled(service,id);
 let snapshot=await service.snapshot(id),obligation=snapshot.impactSummaries![0];
 expect(obligation.status).toBe("interrupted");expect(()=>assertImpactSummariesComplete(snapshot)).toThrow("影响面");
 await expect(service.recordExecutionResumed(id,executionId)).rejects.toThrow("影响面");
 await service.recordExecutionFinished(id,executionId,"cancelled",null,null,1);
 expect((await service.snapshot(id)).impactSummaries).toHaveLength(1);
 fail=false;await service.retryImpactSummary(id,obligation.key);await settled(service,id);
 snapshot=await service.snapshot(id);obligation=snapshot.impactSummaries![0];
 expect(obligation.status).toBe("completed");expect(snapshot.messages.filter(item=>item.role==="user")).toHaveLength(1);expect(calls).toBe(2);
 expect(snapshot.messages.find(item=>item.id===obligation.messageId)?.summaryKey).toBe(obligation.key);
 expect(()=>assertImpactSummariesComplete(snapshot)).not.toThrow();
 const opened=await HarnessJournal.open(id,root);expect(opened.snapshot.impactSummaries).toEqual(snapshot.impactSummaries);
 await expect(service.retryImpactSummary(id,obligation.key)).rejects.toThrow("已完成");
 await service.recordExecutionResumed(id,executionId);expect((await service.snapshot(id)).executions[0].status).toBe("running");
});

test("running 总结重启收敛 interrupted，不自动重发、不解除执行门禁",async()=>{
 let calls=0;const {service,id,root}=await fixture(async()=>{calls++;return new Promise(()=>{});});
 await summaryStarted(service,id);expect((await service.snapshot(id)).impactSummaries![0].status).toBe("running");service.close();
 const next=new HarnessService(root,async()=>{calls++;throw Error("不能重发");});services.push(next);
 await next.convergeStaleTurns();const snapshot=await next.snapshot(id);
 expect(snapshot.impactSummaries![0].status).toBe("interrupted");expect(calls).toBe(1);expect(()=>assertImpactSummariesComplete(snapshot)).toThrow("影响面");
 next.scheduleImpactSummary(id);await Bun.sleep(10);expect(calls).toBe(1);
});

test("空end_turn不完成，用户停止保留义务，迟到答案不能完成",async()=>{
 let resolve!:(value:string)=>void;const {service,id}=await fixture(async()=>new Promise(done=>{resolve=done;}));
 await summaryStarted(service,id);await service.abort(id);resolve("迟到成功");await Bun.sleep(20);
 expect((await service.snapshot(id)).impactSummaries![0].status).toBe("interrupted");
 expect((await service.snapshot(id)).messages.filter(item=>item.role==="assistant")).toHaveLength(0);
});

test("证据整体限长且遮蔽凭据，多字节不损坏，截断明确",()=>{
 const evidence=boundedEvidence({token:"secret-token",apiKey:"private-key",text:"中".repeat(1000)},100);
 expect(evidence.text).not.toContain("secret-token");expect(evidence.text).not.toContain("private-key");expect(evidence.truncated).toBe(true);expect(evidence.text).not.toContain("\uFFFD");expect(Buffer.byteLength(evidence.text)).toBeLessThanOrEqual(100);
});

test("Capsule携带原批准与确认事实，不将草案阶段约束当永久执行禁令",async()=>{
 const {service,id,executionId}=await fixture(async()=>"完整总结");
 service.beginExit();
 const capsule=JSON.parse((await service.executionCapsule(id,executionId,1)).text);
 expect(capsule.authorization.revision).toBe(1);
 expect(capsule.authorization.acceptedAt).toBeString();
 expect(capsule.authorization.executionCreatedAt).toBeString();
 expect(capsule.authorization.confirmationRequestId).toBeNull();
 expect(capsule.authorization.limitation).toContain("不补造");
 expect(capsule.authorization.interpretation).toContain("草案阶段");
});

test("独立恢复主控只回idle，空回答不完成义务、不能绕过门禁",async()=>{
 let calls=0;const {service,id,executionId}=await fixture(async()=>{calls++;return "";});
 await summaryStarted(service,id);await settled(service,id);expect((await service.snapshot(id)).impactSummaries![0].status).toBe("interrupted");
 const restored=await service.recoverController(id);expect(restored.status).toBe("idle");expect(restored.impactSummaries![0].status).toBe("interrupted");expect(calls).toBe(1);
 await expect(service.recordExecutionResumed(id,executionId)).rejects.toThrow("影响面");
});

test("退出前关闭调度，pending留存且不发模型prompt",async()=>{
 let calls=0;const {service,id}=await fixture(async()=>{calls++;return "不能执行";});
 service.beginExit();await Bun.sleep(20);expect(calls).toBe(0);expect((await service.snapshot(id)).impactSummaries![0].status).toBe("pending");
});

test("放弃义务只能同时只读归档，重开不能启动/恢复/重试",async()=>{
 const {service,id,executionId,root}=await fixture(async()=>{throw Error("失败");});
 await summaryStarted(service,id);await settled(service,id);
 const key=(await service.snapshot(id)).impactSummaries![0].key;
 await expect(service.complete(id)).rejects.toThrow("影响面");
 const archived=await service.complete(id,true);expect(archived.status).toBe("completed");expect(archived.impactSummaries![0].status).toBe("cancelled");
 expect((await HarnessJournal.open(id,root)).snapshot.status).toBe("completed");
 await expect(service.retryImpactSummary(id,key)).rejects.toThrow("归档");
 await expect(service.recordExecutionResumed(id,executionId)).rejects.toThrow("归档");
 await expect(service.send(id,"继续")).rejects.toThrow("归档");
});

test("总结中断后新回合不被旧回合迟到finally清理",async()=>{
 let firstResolve!:(value:string)=>void,calls=0,secondStarted!:(value:void)=>void;
 const {service,id}=await fixture(async()=>{calls++;if(calls===1)return new Promise(done=>{firstResolve=done;});secondStarted();return new Promise(()=>{});});
 await summaryStarted(service,id);const key=(await service.snapshot(id)).impactSummaries![0].key;
 await service.abort(id);const begun=new Promise<void>(done=>{secondStarted=done;});void service.retryImpactSummary(id,key);await begun;
 firstResolve("迟到旧答案");await Bun.sleep(30);
 const snapshot=await service.snapshot(id);expect(snapshot.status).toBe("running");expect(snapshot.impactSummaries![0].status).toBe("running");expect(calls).toBe(2);
 await service.abort(id);
});

test("Capsule拒绝跨Task、非法attempt，超长回答不能完成义务",async()=>{
 const {service,id,executionId}=await fixture(async()=>"中".repeat(100000));
 await summaryStarted(service,id);await settled(service,id);
 expect((await service.snapshot(id)).impactSummaries![0].status).toBe("interrupted");
 expect((await service.snapshot(id)).impactSummaries![0].diagnostic).toContain("上限");
 await expect(service.executionCapsule(id,executionId,0)).rejects.toThrow("正整数");
 await expect(service.executionCapsule(id,crypto.randomUUID(),1)).rejects.toThrow("不属于");
});

test("总结准备期间用户先发消息，保留pending且用户回合结束后只调度一次总结",async()=>{
 let finishUser!:(value:string)=>void,calls=0;
 const {service,id}=await fixture(async()=>{calls++;if(calls===1)return new Promise(done=>{finishUser=done;});return "完整总结";});
 let releaseEvidence!:(value:unknown)=>void,readerStarted!:(value:void)=>void;
 const started=new Promise<void>(done=>{readerStarted=done;});
 let reads=0;
 service.setExecutionCapsuleReader(async()=>{reads++;if(reads===1){readerStarted();return new Promise(done=>{releaseEvidence=done;});}return {status:"cancelled"};});
 await started;await service.send(id,"用户优先反馈");releaseEvidence({status:"cancelled"});
 const pendingDeadline=Date.now()+1_000;
 while((await service.snapshot(id)).impactSummaries![0].status!=="pending"){if(Date.now()>pendingDeadline)throw new Error("总结准备竞态未收敛pending");await Bun.sleep(2);}
 expect((await service.snapshot(id)).impactSummaries![0].status).toBe("pending");expect(calls).toBe(1);
 finishUser("反馈已接收");await summaryStarted(service,id);await settled(service,id);
 expect((await service.snapshot(id)).impactSummaries![0].status).toBe("completed");expect(calls).toBe(2);
});

test("总结准备期间归档，迟到准备失败不追加到已归档Journal",async()=>{
 const {service,id,root}=await fixture(async()=>"不应调用");
 let release!:(value:unknown)=>void,entered!:(value:void)=>void;
 const started=new Promise<void>(done=>{entered=done;});
 service.setExecutionCapsuleReader(async()=>{entered();return new Promise(done=>{release=done;});});
 await started;await service.complete(id,true);release({status:"cancelled"});await Bun.sleep(40);
 const reopened=await HarnessJournal.open(id,root);expect(reopened.snapshot.status).toBe("completed");expect(reopened.events.at(-1)?.type).toBe("harness.completed");
});

test("目标态终态缺attempt拒绝且不污染Journal",async()=>{
 const {service,id,executionId,root}=await fixture(async()=>"完整总结");await summaryStarted(service,id);await settled(service,id);
 await service.recordExecutionResumed(id,executionId);
 await expect(service.recordExecutionFinished(id,executionId,"cancelled",null,null)).rejects.toThrow("原attempt");
 expect((await HarnessJournal.open(id,root)).snapshot.executions[0].finishedAt).toBeNull();
});

test("普通Task无单链字段也自动总结，失败门禁与重试不依赖验收开关",async()=>{
 let fail=true,calls=0;const {service,id,executionId,root}=await fixture(async()=>{calls++;if(fail)throw Error("总结失败");return "执行已取消，没有交付，影响证据不足。";},false);
 await summaryStarted(service,id);await settled(service,id);
 const before=await service.snapshot(id);expect(before.task?.workflowContract).toBeUndefined();expect(before.impactSummaries![0].status).toBe("interrupted");
 await expect(service.recordExecutionResumed(id,executionId)).rejects.toThrow("影响面总结");
 fail=false;await service.retryImpactSummary(id,before.impactSummaries![0].key);await settled(service,id);
 expect((await service.snapshot(id)).impactSummaries![0].status).toBe("completed");expect(calls).toBe(2);
 const opened=await HarnessJournal.open(id,root);expect(opened.events.find(event=>event.type==="workflow.execution_finished")).toMatchObject({impactSummaryRequired:true,attempt:1});
});

test("迟到停止总结按钮不能停止总结结束后新开始的用户回合",async()=>{
 let calls=0;const {service,id}=await fixture(async()=>{calls++;if(calls===1)return "完整总结";return new Promise(()=>{});});
 await summaryStarted(service,id);await settled(service,id);const {key,turnId}=(await service.snapshot(id)).impactSummaries![0];
 await service.send(id,"新的用户回合");
 await expect(service.stopImpactSummary(id,key,turnId!)).rejects.toThrow("未停止其他回合");
 expect((await service.snapshot(id)).status).toBe("running");await service.abort(id);
});

test("同义务重试后旧停止请求零写入，新回合身份才能停止且迟到回答不完成",async()=>{
 let calls=0;const resolves:Array<(value:string)=>void>=[];
 const {service,id,root}=await fixture(async()=>{calls++;return new Promise(done=>resolves.push(done));});
 await summaryStarted(service,id);const original=(await service.snapshot(id)).impactSummaries![0];
 await service.stopImpactSummary(id,original.key,original.turnId!);
 await service.retryImpactSummary(id,original.key);
 const running=await service.snapshot(id),retry=running.impactSummaries![0];
 expect(retry.turnId).not.toBe(original.turnId);expect(calls).toBe(2);
 await expect(service.stopImpactSummary(id,original.key,original.turnId!)).rejects.toThrow("未停止其他回合");
 // 未携带回合身份的旧客户端也不能回退为仅key停止。
 await expect(service.stopImpactSummary(id,retry.key,undefined as unknown as string)).rejects.toThrow("未停止其他回合");
 expect(await service.snapshot(id)).toEqual(running);
 expect((await HarnessJournal.open(id,root)).snapshot).toEqual(running);
 await service.stopImpactSummary(id,retry.key,retry.turnId!);
 resolves.forEach(resolve=>resolve("迟到回答"));await Bun.sleep(20);
 const stopped=await service.snapshot(id);
 expect(stopped.impactSummaries![0].status).toBe("interrupted");
 expect(stopped.messages.filter(message=>message.role==="assistant")).toHaveLength(0);
 expect(()=>assertImpactSummariesComplete(stopped)).toThrow("影响面");
});

for(const stopReason of ["max_tokens","max_turn_requests","refusal"]){
 test(`ACP ${stopReason} 部分总结保持门禁，重开仍中断，正常重试才完成`,async()=>{
  let reason=stopReason,listener:((event:{update:acp.SessionUpdate})=>void)|null=null,calls=0;
  const client={
   subscribe(value:typeof listener){listener=value;return ()=>{};},
   async initialize(){},async createSession(){},
   async prompt(){calls++;listener?.({update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:reason==="end_turn"?"完整总结：执行已取消，影响证据不足。":"已完成节点：A，其他影响尚未"}}});return {stopReason:reason};},
   close(){},
  } as unknown as AcpSessionClient;
  const {service,id,root,executionId}=await fixture(()=>new AcpHarnessSession({id:"codex-acp",command:"fake",args:[]},"/workspace","约束",[],{name:"test",command:"fake",args:[],env:[]},client).prompt("总结"));
  await summaryStarted(service,id);await settled(service,id);
  const interrupted=await service.snapshot(id);
  expect(interrupted.impactSummaries![0].status).toBe("interrupted");
  expect(interrupted.impactSummaries![0].diagnostic).toContain(stopReason);
  expect(interrupted.messages.filter(message=>message.role==="assistant")).toHaveLength(0);
  expect(()=>assertImpactSummariesComplete(interrupted)).toThrow("影响面");
  expect((await HarnessJournal.open(id,root)).snapshot.impactSummaries).toEqual(interrupted.impactSummaries);
  await expect(service.recordExecutionResumed(id,executionId)).rejects.toThrow("影响面");
  reason="end_turn";await service.retryImpactSummary(id,interrupted.impactSummaries![0].key);await settled(service,id);
  const completed=await service.snapshot(id);
  expect(completed.impactSummaries![0].status).toBe("completed");
  expect(()=>assertImpactSummariesComplete(completed)).not.toThrow();
  expect(completed.executions).toEqual(interrupted.executions);expect(calls).toBe(2);
 });
}
