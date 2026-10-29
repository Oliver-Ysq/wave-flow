import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessService } from "../../src/harness/service";
import { HarnessJournal } from "../../src/harness/journal";
import { DeterministicHarnessSession } from "../../src/harness/deterministic-session";
import { assertStartable,normalizeTaskCreation } from "../../src/harness/task-contract";
import { TaskLifecycle } from "../../src/harness/task-lifecycle";
import { taskIdForRequest } from "../../src/harness/task-contract";
import { writeFile } from "node:fs/promises";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const source = `import { phase } from "wave-flow";\nexport const meta = { name: 'task-test', description: '检查', phases: [{ title: '检查' }], inputSchema: { type: 'object', properties: {}, additionalProperties: false } };\nexport default async function run(args) { phase('检查'); return {}; }`;
async function fixture() { const root = await mkdtemp(join(tmpdir(), "wf-task-")); roots.push(root); return root; }
async function idle(service: HarnessService, id: string) { for (let n=0;n<100;n++) { if ((await service.snapshot(id)).status !== "running") return; await Bun.sleep(2); } throw new Error("timeout"); }
test("创建请求规范化、标题unicode边界和非法来源不产生档案",async()=>{
 const request={clientRequestId:crypto.randomUUID(),projectId:"project",text:"  初始目标\n约束  "};
 const a=normalizeTaskCreation(request),b=normalizeTaskCreation({...request,text:"初始目标\n约束",title:"初始目标"});expect(a.payloadHash).toBe(b.payloadHash);expect(a.title).toBe("初始目标");
 expect(Array.from(normalizeTaskCreation({...request,text:"😀".repeat(130)}).title)).toHaveLength(120);
 for(const title of ["","x\ny","😀".repeat(121)])expect(()=>normalizeTaskCreation({...request,title})).toThrow("标题");
 expect(()=>normalizeTaskCreation({...request,source:"local"} as never)).toThrow("字段");
 const root=await fixture(),state=join(root,"state"),service=new HarnessService(state,async()=>new DeterministicHarnessSession());
 expect(()=>service.startTask(root,{...request,title:"\n"})).toThrow();
 expect(await service.list()).toHaveLength(0);
});
test("任务并发创建、重开、异载荷冲突及初始化失败恢复不重复消息", async () => {
  const root = await fixture(); let fail = true;
  const service = new HarnessService(join(root,"state"), async () => { if (fail) throw new Error("unavailable"); return new DeterministicHarnessSession(); });
  const input = { clientRequestId: crypto.randomUUID(), projectId: "project", text: "初始目标", title: "固定标题" };
  const [a,b] = await Promise.all([service.startTask(root,input), service.startTask(root,input)]);
  expect(a.harnessRunId).toBe(b.harnessRunId); expect(a.messages).toHaveLength(1); expect(a.diagnostic).toContain("任务已创建"); expect(a.task?.title).toBe("固定标题");
  await expect(service.startTask(root,{...input,text:"冲突"})).rejects.toThrow("冲突");
  fail = false; await service.retryInitialization(a.harnessRunId); await idle(service,a.harnessRunId);
  expect((await service.snapshot(a.harnessRunId)).messages.filter(item=>item.role === "user")).toHaveLength(1);
  const reopened = new HarnessService(join(root,"state"), async () => { throw new Error("must not resend"); });
  expect((await reopened.startTask(root,input)).harnessRunId).toBe(a.harnessRunId);
  expect((await reopened.snapshot(a.harnessRunId)).messages).toHaveLength(2);
});
test("主控身份解析失败仍先保存Task，恢复后同身份只发初始回合一次",async()=>{
 const root=await fixture();let fail=true,calls=0;
 const service=new HarnessService(join(root,"state"),async()=>{calls++;return new DeterministicHarnessSession();},undefined,async()=>{if(fail)throw Error("CLI不可用");return {fingerprint:"injected-harness-session"};});
 const request={clientRequestId:crypto.randomUUID(),projectId:"project",text:"保留目标"};
 const created=await service.startTask(root,request);expect(created.messages).toHaveLength(1);expect(created.diagnostic).toContain("CLI不可用");expect(calls).toBe(0);
 fail=false;await service.retryInitialization(created.harnessRunId);await idle(service,created.harnessRunId);
 expect((await service.snapshot(created.harnessRunId)).messages.filter(message=>message.role==="user")).toHaveLength(1);expect(calls).toBe(1);
});
test("主控来源绑定耐久，初始化失败重开不换到新的默认CLI",async()=>{
 const root=await fixture(),state=join(root,"state");
 const runtime:import("../../src/runtimes/types").RuntimeProvenance={runtimeId:crypto.randomUUID(),cli:"codex",executablePath:"/tmp/test-codex",version:"test",adapterId:"codex-acp",adapterVersion:"test",verifiedAt:new Date().toISOString()};
 const service=new HarnessService(state,async()=>{throw Error("初始化失败");},undefined,async()=>({fingerprint:"a".repeat(64),runtime}));
 const request={clientRequestId:crypto.randomUUID(),projectId:"project",text:"保留原来源"};
 const created=await service.startTask(root,request);expect(created.runtime?.runtimeId).toBe(runtime.runtimeId);
 const reopened=new HarnessService(state,async(_id,_cwd,prior,_actions,frozen)=>{expect(prior).toHaveLength(0);expect(frozen?.runtimeId).toBe(runtime.runtimeId);return new DeterministicHarnessSession();},undefined,async()=>{throw Error("不得重新选择默认CLI");});
 await reopened.startTask(root,request);await idle(reopened,created.harnessRunId);
 const saved=await HarnessJournal.open(created.harnessRunId,state);expect(saved.events.filter(event=>event.type==="harness.runtime_initialized")).toHaveLength(1);expect(saved.snapshot.messages.filter(message=>message.role==="user")).toHaveLength(1);
});
test("非法主控决定Schema不落盘请求，不留下无法回答的等待者",async()=>{
 const root=await fixture(),state=join(root,"state");
 const service=new HarnessService(state,async(_id,_cwd,_prior,actions)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{await actions.requestUserDecision("问题",{type:"nonsense"});return "不应完成";}}));
 const task=await service.startTask(root,{clientRequestId:crypto.randomUUID(),projectId:"project",text:"目标"});await idle(service,task.harnessRunId);
 const saved=await HarnessJournal.open(task.harnessRunId,state);expect(saved.snapshot.status).toBe("interrupted");expect(saved.snapshot.decisions).toHaveLength(0);expect(saved.events.some(event=>event.type==="harness.decision_requested")).toBe(false);
});
test("接受后修改同卡保留批准，旧版本拒绝启动；放弃保留证据", async () => {
  const root = await fixture();
  const service = new HarnessService(join(root,"state"), async (_id,_cwd,_prior,actions) => ({ isRunning:false, subscribe:()=>()=>{}, abort:()=>{}, prompt:async()=> { await actions.proposeWorkflowRevision(source,"本轮目标","只读检查"); return "方案已提出"; } }));
  const a=await service.startTask(root,{clientRequestId:crypto.randomUUID(),projectId:"project",text:"创建"}); await idle(service,a.harnessRunId);
  await service.acceptWorkflowRevision(a.harnessRunId,1);
  await service.send(a.harnessRunId,"修改"); await idle(service,a.harnessRunId);
  const modified=await service.snapshot(a.harnessRunId);
  expect(modified.workflowRevisions[0].acceptedAt).not.toBeNull();
  expect(modified.workflowRevisions[1].cardId).toBe(modified.workflowRevisions[0].cardId);
  expect(modified.workflowRevisions[1].parentRevision).toBe(1);
  expect(()=>assertStartable(modified,1)).toThrow("取代");
  await service.acceptWorkflowRevision(a.harnessRunId,2);
  await service.abandonWorkflowCard(a.harnessRunId,modified.workflowRevisions[1].cardId!);
  const saved=(await HarnessJournal.open(a.harnessRunId,join(root,"state"))).snapshot;
  expect(()=>assertStartable(saved,2)).toThrow();
  expect(saved.workflowRevisions.every(item=>item.abandonedAt)).toBe(true);
  expect(saved.workflowRevisions[1].acceptedAt).not.toBeNull();
  await service.complete(a.harnessRunId);
});
test("创建 Journal 缺失可修复同一任务，初始回合不重复",async()=>{
  const root=await fixture(), request=crypto.randomUUID(), id=taskIdForRequest(request);
  const state=join(root,"state"), goal="恢复创建";
  await HarnessJournal.create({harnessRunId:id,projectId:"project",cwd:root,version:9,modelFingerprint:"injected-harness-session",createdAt:new Date().toISOString(),task:{clientRequestId:request,payloadHash:(await import("../../src/harness/task-contract")).normalizeTaskCreation({clientRequestId:request,projectId:"project",text:goal}).payloadHash,title:goal,initialGoal:goal}},state);
  await writeFile(join(state,id,"journal.jsonl"),"");
  // 模拟创建尚未提交，而不是把已经运行的 Journal 丢失伪装为可重试。
  await unlink(join(state,id,"creation-ready"));
  const service=new HarnessService(state,async()=>new DeterministicHarnessSession());
  const snapshot=await service.startTask(root,{clientRequestId:request,projectId:"project",text:goal});await idle(service,id);
  expect(snapshot.harnessRunId).toBe(id);
  expect((await service.snapshot(id)).messages.filter(item=>item.role==="user")).toHaveLength(1);
});
test("已提交创建 Journal 丢失拒绝重建，不重复主控回合", async () => {
  const root = await fixture(), state = join(root, "state");
  const service = new HarnessService(state, async () => new DeterministicHarnessSession());
  const request = { clientRequestId: crypto.randomUUID(), projectId: "project", text: "防止重发" };
  const task = await service.startTask(root, request); await idle(service, task.harnessRunId);
  await unlink(join(state, task.harnessRunId, "journal.jsonl"));
  const reopened = new HarnessService(state, async () => { throw Error("不得初始化"); });
  await expect(reopened.startTask(root, request)).rejects.toThrow("Journal 缺失");
});
test("短事务可重入，后台任务必须重新仲裁，失败不毒化队列",async()=>{
  const lifecycle=new TaskLifecycle(), order:string[]=[];
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>release=resolve);
  const first=lifecycle.run("task",async()=>{order.push("first");await lifecycle.run("task",async()=>{order.push("nested");});await waiting;});
  const second=lifecycle.run("task",async()=>{order.push("second");});
  await Bun.sleep(1);expect(order).toEqual(["first","nested"]);release();await Promise.all([first,second]);
  expect(order).toEqual(["first","nested","second"]);
  await expect(lifecycle.run("task",async()=>{throw Error("failed");})).rejects.toThrow("failed");
  expect(await lifecycle.run("task",async()=>"ok")).toBe("ok");
});

test("候选接受/放弃与封存并发，非法操作不污染Journal",async()=>{
  const root=await fixture(),state=join(root,"state");
  const service=new HarnessService(state,async(_id,_cwd,_prior,actions)=>({isRunning:false,subscribe:()=>()=>{},abort:()=>{},prompt:async()=>{await actions.proposeWorkflowRevision(source,"目标","范围");return "方案";}}));
  const task=await service.startTask(root,{clientRequestId:crypto.randomUUID(),projectId:"project",text:"目标"});await idle(service,task.harnessRunId);
  const id=task.harnessRunId,card=(await service.snapshot(id)).workflowRevisions[0].cardId!;
  await expect(service.complete(id)).rejects.toThrow("放弃");
  const results=await Promise.allSettled([service.acceptWorkflowRevision(id,1),service.abandonWorkflowCard(id,card)]);
  expect(results.filter(result=>result.status==="fulfilled").length).toBeGreaterThan(0);
  const snapshot=(await HarnessJournal.open(id,state)).snapshot;
  expect(snapshot.workflowRevisions[0].abandonedAt).not.toBeNull();
  await expect(service.acceptWorkflowRevision(id,1)).rejects.toThrow("放弃");
  await service.complete(id);
  await expect(service.send(id,"不能复活")).rejects.toThrow("归档");
  expect((await HarnessJournal.open(id,state)).snapshot.status).toBe("completed");
});
