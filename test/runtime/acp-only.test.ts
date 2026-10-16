import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer } from "../../src/control/control-server";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { AcpWorkerExecutor, type AcpWorkerSession } from "../../src/runtime/acp-worker-executor";
import type * as acp from "@agentclientprotocol/sdk";
import { RunStateMachine } from "../../src/runtime/run-state-machine";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-acp-only-")); directories.push(cwd);
  const manifest: RunManifest = { runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "acp", description: "ACP.", phases: [{ title: "run" }] }, workflowHash: "a".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  const journal = await RunJournal.create(manifest, runsRoot(cwd));
  const state = new RunStateMachine(manifest);
  state.apply({ type: "run.created", at: manifest.createdAt, runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
  const request = { id: "node", cli: "codex" as const, sandbox: "workspace-write" as const, cwd, prompt: "complete", phase: "run" };
  const created: JournalEvent = { type: "agent.created", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request };
  await journal.append(created); state.apply(created);
  const sessionId = "worker-session";
  const running: JournalEvent = { type: "agent.status", at: new Date().toISOString(), runId: manifest.runId, nodeId: "node", agentSessionId: sessionId, diagnostic: null, status: "running" };
  await journal.append(running); state.apply(running);
  return { cwd, manifest, journal, state, control: new ControlServer(journal, state), node: state.agent("node"), sessionId };
}

for (const stage of ["initialize", "createSession"] as const) test(`停止发生在${stage}等待时仍清理，迟到启动不投递任务`, async () => {
 const value = await fixture(); let entered!: () => void, release!: () => void;
 const started = new Promise<void>(resolve => { entered = resolve; });
 const gate = new Promise<void>(resolve => { release = resolve; });
 let prompts = 0, closed = 0, pipeClosed = 0;
 const session: AcpWorkerSession = {
  binding:null,
  async initialize(){ if(stage==="initialize"){entered();await gate;} },
  async createSession(){ if(stage==="createSession"){entered();await gate;} return {launcherId:"test",sessionId:"native",capabilities:{}}; },
  async prompt(){prompts++;return {stopReason:"end_turn"};},
  async cancel(){throw new Error("尚未建立可取消会话");}, close(){closed++;}
 };
 const executor = new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[],close(){pipeClosed++;}} as acp.McpServer));
 executor.bindControl(value.control);
 const running = executor.execute(value.node).then(()=>"unexpected",error=>String(error));
 await started;
 await expect(executor.stop(value.node)).rejects.toThrow("尚未建立");
 expect(await Promise.race([running,Bun.sleep(500).then(()=>"pending")])).toContain("停止未确认");
 release(); await Bun.sleep(1);
 expect(prompts).toBe(0); expect(closed).toBe(1);
 expect(pipeClosed).toBe(stage==="createSession"?1:0);
 expect((await RunJournal.open(value.manifest.runId,runsRoot(value.cwd))).events.some(e=>e.type==="agent.session")).toBe(false);
});

test("ACP Worker 只在 durable binding 与 capability complete 后完成", async () => {
  const value = await fixture();
  let capability = "";
  let managed = "";
  const session: AcpWorkerSession = {
    binding: null,
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt(text) { managed = text; await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "done", result: { ok: true } }); return { stopReason: "end_turn" }; },
    async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "/mcp", args: [], env: [] }; });
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(managed).toContain("高优先级、不可省略");
  expect(managed).toContain("即使业务任务要求“只回复”“只输出 JSON”");
  expect(managed).toContain("wave_flow_complete");
  expect(managed).toContain("延迟加载");
  expect(managed).toContain("工具搜索/发现");
  const opened = await RunJournal.open(value.manifest.runId, runsRoot(value.cwd));
  expect(opened.events).toContainEqual(expect.objectContaining({ type: "agent.session", delivery: "acp", acp: expect.objectContaining({ sessionId: "native-session" }) }));
});

for(const answered of [false,true])test(`收尾从Control补回原block，answered=${answered}，不新建请求或代替continue`,async()=>{
 const value=await fixture();let identity:any;const blockRequestId=crypto.randomUUID();const prompts:string[]=[];
 const needHelp="请选择数字",answerSchema={type:"object",properties:{x:{type:"integer"}},required:["x"],additionalProperties:false};
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(text){
  prompts.push(text);
  if(prompts.length===1){void value.control.block({...identity,blockRequestId,needHelp,answerSchema}).catch(()=>{});while(value.state.agent("node").status!=="blocked")await Bun.sleep(1);if(answered)await value.control.answer({blockRequestId,answer:{x:41}});return {stopReason:"end_turn"};}
  expect(text).toContain(blockRequestId);expect(text).toContain(needHelp);expect(text).toContain(JSON.stringify(answerSchema));
  expect(text).toContain(answered?"原block已有耐久答案":"用户尚未回答");
  if(!answered)expect(text).toContain("不是永久禁令");
  expect(value.state.agent("node").status).toBe("blocked");
  if(!answered)await value.control.answer({blockRequestId,answer:{x:41}});
  const reordered={additionalProperties:false,required:["x"],properties:{x:{type:"integer"}},type:"object"};
  const original=await value.control.block({...identity,blockRequestId,needHelp,answerSchema:reordered});expect(original.answer).toEqual({x:41});
  await value.control.continue({...identity,blockRequestId});
  await value.control.complete({...identity,summary:"done",result:{value:42}});return {stopReason:"end_turn"};
 },async cancel(){},close(){}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,i=>{identity=i;return {name:"private",command:"fake",args:[],env:[]};});executor.bindControl(value.control);
 expect(await executor.execute(value.node)).toEqual({value:42});expect(prompts).toHaveLength(2);
 const events=(await RunJournal.open(value.manifest.runId,runsRoot(value.cwd))).events;
 expect(events.filter(e=>e.type==="block.created")).toHaveLength(1);expect(events.filter(e=>e.type==="agent.continued")).toHaveLength(1);
});

test("停止发生在收尾事实读取期间，不创建迟到收尾回合",async()=>{
 const value=await fixture();let release!:()=>void,reading!:()=>void,prompts=0;
 const entered=new Promise<void>(done=>reading=done),hold=new Promise<void>(done=>release=done);
 const original=value.control.workerTurnContext.bind(value.control);
 value.control.workerTurnContext=async identity=>{reading();await hold;return original(identity);};
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(){prompts++;return {stopReason:"end_turn"};},async cancel(){},close(){}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[]}));executor.bindControl(value.control);
 const running=executor.execute(value.node);void running.catch(()=>{});await entered;await executor.stop(value.node);release();
 await expect(running).rejects.toThrow("用户停止");expect(prompts).toBe(1);
});

test("stop的cancel忽略signal时仍在宿主预算内拒绝并清理会话", async () => {
 const value = await fixture(); let started!: () => void; let closed = 0;
 const entered = new Promise<void>(resolve => { started = resolve; });
 const session: AcpWorkerSession = { binding:null, async initialize(){}, async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};}, async prompt(){started();return new Promise(()=>{});}, async cancel(){return new Promise(()=>{});}, close(){closed++;} };
 const executor = new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session);
 executor.bindControl(value.control);
 const running = executor.execute(value.node).then(()=>"unexpected", error=>String(error));
 await entered;
 const before = Date.now();
 await expect(executor.stop(value.node)).rejects.toThrow("控制等待已取消");
 expect(Date.now()-before).toBeLessThan(18_000);
 expect(await running).toContain("停止未确认");
 expect(closed).toBe(1);
}, 20_000);

for(const lateTurn of [false,true])test(`cancel抛错也收敛执行并释放会话/MCP，迟到end_turn=${lateTurn}`,async()=>{
 const value=await fixture();let finish!:(turn:{stopReason:string})=>void,prompts=0,closed=0,pipeClosed=0;
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(){prompts++;return new Promise(done=>finish=done);},async cancel(){throw new Error("cancel transport failed");},close(){closed++;}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[],close(){pipeClosed++;}} as acp.McpServer));executor.bindControl(value.control);
 const running=executor.execute(value.node);
 const outcome=running.then(()=>"unexpected success",error=>String(error));
 while(!finish)await Bun.sleep(1);
 await expect(executor.stop(value.node)).rejects.toThrow("cancel transport failed");
 if(lateTurn)finish({stopReason:"end_turn"});
 const result=await Promise.race([outcome,Bun.sleep(200).then(()=>"pending")]);
 expect(result).toContain("停止未确认：cancel transport failed");
 expect(closed).toBe(1);expect(pipeClosed).toBe(1);expect(prompts).toBe(1);
 await expect(executor.stop(value.node)).rejects.toThrow("没有可控制");
 const events=(await RunJournal.open(value.manifest.runId,runsRoot(value.cwd))).events;
 expect(events.filter(event=>event.type==="agent.completed")).toHaveLength(0);
});

test("超大协议事实拒绝收尾而非截断身份或无限重试",async()=>{
 const value=await fixture();let prompts=0;
 value.control.workerTurnContext=async()=>({status:"running",block:null,resultSchema:{type:"object",description:"中".repeat(18000)}});
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(){prompts++;return {stopReason:"end_turn"};},async cancel(){},close(){}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[]}));executor.bindControl(value.control);
 await expect(executor.execute(value.node)).rejects.toThrow("超过48KiB");expect(prompts).toBe(1);
});

test("ACP Worker cancel 确认后仅在同一 session recover", async () => {
  const value = await fixture();
  let capability = "";
  let releaseFirst!: (result: { readonly stopReason: string }) => void;
  const prompts: string[] = [];
  const session: AcpWorkerSession = {
    get binding() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async initialize() {},
    async createSession() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt(text) {
      prompts.push(text);
      if (prompts.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "recovered", result: { ok: true } });
      return { stopReason: "end_turn" };
    },
    async cancel() { releaseFirst({ stopReason: "cancelled" }); }, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "/mcp", args: [], env: [] }; });
  executor.bindControl(value.control);
  const running = executor.execute(value.node);
  while (prompts.length === 0) await Bun.sleep(1);
  await executor.pause(value.node);
  await executor.recover(value.node);
  await expect(running).resolves.toEqual({ ok: true });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("检查当前工作目录");
  expect(prompts[1]).toContain("工具搜索/发现");
});

for(const failure of ["end_turn","transport","abort","cancel_error","pending_cancel_transport"] as const)test(`暂停确认失败${failure}不悬挂、不续发且释放原会话`,async()=>{
 const value=await fixture();let finish!:(turn:{stopReason:string})=>void,reject!:(error:Error)=>void,prompts=0,closed=0;
 const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:"codex-acp",sessionId:"native",capabilities:{}};},async prompt(){prompts++;return new Promise((done,fail)=>{finish=done;reject=fail;});},async cancel(){if(failure==="cancel_error")throw new Error("cancel failed");if(failure==="pending_cancel_transport")await new Promise<void>(()=>{});},close(){closed++;}};
 const executor=new AcpWorkerExecutor({id:"codex-acp",command:"fake",args:[]},()=>session,undefined,()=>({name:"private",command:"fake",args:[],env:[]}));executor.bindControl(value.control);
 const running=executor.execute(value.node);const outcome=running.then(()=>"unexpected",error=>String(error));
 while(!finish)await Bun.sleep(1);
 const controller=new AbortController();const pausing=executor.pause(value.node,controller.signal);
 const paused=pausing.then(()=>"unexpected",error=>String(error));
 await Bun.sleep(1);
 if(failure==="end_turn")finish({stopReason:"end_turn"});
 if(failure==="transport"||failure==="pending_cancel_transport")reject(new Error("transport failed"));
 if(failure==="abort")controller.abort();
 expect(await Promise.race([paused,Bun.sleep(200).then(()=>"pending")])).not.toBe("pending");
 expect(await Promise.race([outcome,Bun.sleep(200).then(()=>"pending")])).not.toBe("pending");
 finish({stopReason:"end_turn"});await Bun.sleep(1);
 expect(closed).toBe(1);expect(prompts).toBe(1);
 await expect(executor.recover(value.node)).rejects.toThrow("没有可控制");
});

test("两个CLI使用相同通用完成协议，第二次end_turn仍漏报只拒绝、不重跑或代报",async()=>{
 const guides:string[]=[];
 for(const cli of ["codex","kimi"] as const){
  const value=await fixture(),prompts:string[]=[];
  const session:AcpWorkerSession={binding:null,async initialize(){},async createSession(){return {launcherId:`${cli}-acp`,sessionId:"native",capabilities:{}};},async prompt(text){prompts.push(text);return {stopReason:"end_turn"};},async cancel(){},close(){}};
  const executor=new AcpWorkerExecutor({id:`${cli}-acp`,command:"fake",args:[]},()=>session,undefined,()=>({name:"wave-flow-worker-control",command:"fake",args:[],env:[]}));
  executor.bindControl(value.control);
  await expect(executor.execute({...value.node,cli,request:{...value.node.request,cli}})).rejects.toThrow("未收到 wave-flow complete");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("不要重做业务任务");
  for(const text of prompts){
   expect(text).toContain("server：wave-flow-worker-control");
   expect(text).toContain("summary: string, result: object");
   expect(text).toContain("属于其他server");
   expect(text).not.toMatch(/Codex|Kimi|ALL_TOOLS|mcp__|tools\.|exec\/代码/);
  }
  guides.push(prompts[0]);
  const opened=await RunJournal.open(value.manifest.runId,runsRoot(value.cwd));
  expect(opened.events.filter(event=>event.type==="agent.completed")).toHaveLength(0);
  expect(opened.events.filter(event=>event.type==="agent.session")).toHaveLength(1);
 }
 expect(guides[0]).toBe(guides[1]);
});

test("首个 end_turn 遗漏 complete 时仅补发同 session 的完成提醒", async () => {
  const value = await fixture(); let capability = ""; const prompts: string[] = [];
  const session: AcpWorkerSession = {
    binding: null, async initialize() {}, async createSession() { return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt(text) { prompts.push(text); if (prompts.length === 1) return { stopReason: "end_turn" }; await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "recovered-report", result: { ok: true } }); return { stopReason: "end_turn" }; }, async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor({ id: "codex-acp", command: "fake", args: [] }, () => session, undefined, identity => { capability = identity.capability; return { name: "private", command: "/mcp", args: [], env: [] }; }); executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(prompts).toHaveLength(2); expect(prompts[1]).toContain("不要重做业务任务");
  expect(prompts[1]).toContain("工具搜索/发现");
});

test("真实 Worker session 仅注入节点私有的 Control MCP", async () => {
  const value = await fixture(); let capability = ""; let servers: readonly acp.McpServer[] = [];
  const session: AcpWorkerSession = {
    binding: null, async initialize() {}, async createSession(_cwd, _signal, mcpServers = []) { servers = mcpServers; return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt() { await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "mcp", result: { ok: true } }); return { stopReason: "end_turn" }; }, async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor(
    { id: "codex-acp", command: "fake", args: [] },
    () => session,
    undefined,
    identity => { capability = identity.capability; return { name: "wave-flow-worker-control", command: "/wave-flow-desktop-engine", args: ["__worker-mcp"], env: [{ name: "WF_WORKER_MCP_REQUEST_FIFO", value: "/private/request" }, { name: "WF_WORKER_MCP_RESPONSE_FIFO", value: "/private/response" }] }; },
  );
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(servers).toEqual([expect.objectContaining({ name: "wave-flow-worker-control", command: "/wave-flow-desktop-engine", args: ["__worker-mcp"] })]);
});

test("真实 Worker 创建带私有 MCP 的 session 时等待其启动完成", async () => {
  const value = await fixture(); let capability = ""; let startupWait: number | undefined;
  const session: AcpWorkerSession = {
    binding: null, async initialize() {}, async createSession(_cwd, _signal, _servers = [], wait) { startupWait = wait; return { launcherId: "codex-acp", sessionId: "native-session", capabilities: {} }; },
    async prompt() { await value.control.complete({ runId: value.manifest.runId, nodeId: "node", agentSessionId: value.sessionId, capability, summary: "mcp-ready", result: { ok: true } }); return { stopReason: "end_turn" }; }, async cancel() {}, close() {},
  };
  const executor = new AcpWorkerExecutor(
    { id: "codex-acp", command: "fake", args: [] },
    () => session,
    undefined,
    identity => { capability = identity.capability; return { name: "wave-flow-worker-control", command: "/wave-flow-desktop-engine", args: ["__worker-mcp"], env: [] }; },
  );
  executor.bindControl(value.control);
  await expect(executor.execute(value.node)).resolves.toEqual({ ok: true });
  expect(startupWait).toBe(10_000);
});
