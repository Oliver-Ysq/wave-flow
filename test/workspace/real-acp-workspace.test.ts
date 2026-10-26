import { expect, spyOn, test } from "bun:test";
import { AcpSessionClient } from "../../src/adapters/acp-session";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as acp from "@agentclientprotocol/sdk";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { ProductionWorkspaceExecutor } from "../../src/workspace/production-workspace-executor";
import { WorkspaceManager } from "../../src/workspace/workspace-manager";
import { RunRuntime } from "../../src/runtime/run-runtime";
import { WorkerControlPipe } from "../../src/runtime/worker-control-pipe";
import { GitRepository } from "../../src/workspace/git-repository";
import { agent, parallel, phase } from "../../src/workflow/author-api";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import type { JsonObject } from "../../src/shared/json";
import { DesktopExecutionEngine } from "../../src/desktop/desktop-execution-engine";
import { DesignConfirmationCache } from "../../src-tauri/web/src/workflow-design-config";
import { RunJournal } from "../../src/journal/run-journal";
import type { ExecutionWorkspaceConfig } from "../../src/workspace/execution-workspaces";

test.skipIf(process.env.WF_REAL_WORKSPACE_ACCEPTANCE !== "1")("真实写Worker完成后租约释放失败，显式恢复只补交接且零新会话", async () => {
  const root=await realpath(await mkdtemp(join(tmpdir(),"wave-flow-real-result-recovery-"))),cwd=join(root,"repo");await mkdir(cwd);
  const git=async(...args:string[])=>{const child=Bun.spawn(["/usr/bin/git","-c","user.name=Acceptance","-c","user.email=acceptance@example.invalid",...args],{cwd,stdout:"pipe",stderr:"pipe"});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw Error(err);return out.trim();};
  await git("init","-b","main");await writeFile(join(cwd,"a.txt"),"base\n");await git("add","a.txt");await git("commit","-m","acceptance base");
  const base=await git("rev-parse","HEAD"),workspaceId=crypto.randomUUID(),engineId=crypto.randomUUID();
  const cli=process.env.WF_REAL_WORKSPACE_CLI==="kimi"?"kimi":"codex",registry=new CliRuntimeRegistry();await registry.resolveWorker(cli);
  let runtime!:RunRuntime;const pipes:WorkerControlPipe[]=[];
  const executor=new ProductionWorkspaceExecutor({version:3,authorization:{authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:cwd,baseCommit:base,excludeExistingDirty:false,nodes:[{nodeId:"writer"}]},workspaceId},join(root,"workspaces"),engineId,registry,(identity,scratch)=>{
    const pipe=new WorkerControlPipe(runtime.createControlServer(),identity,undefined,scratch);pipes.push(pipe);
    return {name:"wave-flow-worker-control",command:process.execPath,args:[join(import.meta.dir,"../../src/desktop/engine-main.ts"),"__worker-mcp"],env:[{name:"WF_WORKER_MCP_REQUEST_FIFO",value:pipe.endpoints.requestFifo},{name:"WF_WORKER_MCP_RESPONSE_FIFO",value:pipe.endpoints.responseFifo}],close:()=>pipe.close()} as acp.McpServer;
  },null);
  const workflow:WorkflowModule<JsonObject,unknown>={meta:{name:"result-recovery",description:"成果交接恢复",phases:[{title:"write"}]},default:async()=>{phase("write");return agent('只将当前cwd的a.txt改成done加换行；不要commit/push、联网或安装。最终结果{ok:true}。',{id:"writer",cli,sandbox:"workspace-write",schema:{type:"object",properties:{ok:{type:"boolean",const:true}},required:["ok"],additionalProperties:false}});}};
  await writeFile(join(root,"workflow.ts"),"result-recovery");
  runtime=await RunRuntime.create({workflow,input:{},workflowSource:"result-recovery",workflowPath:join(root,"workflow.ts"),workflowProjectCwd:cwd,clientRequestId:crypto.randomUUID(),executor,storeRoot:join(root,"runs")});
  const control=runtime.createControlServer();runtime.createControlServer=()=>control;await executor.bindRuntime(runtime,control);
  console.log(JSON.stringify({root,runId:runtime.snapshot().id,cli}));
  const release=spyOn(WorkspaceManager.prototype,"release").mockRejectedValueOnce(new Error("injected lease release failure"));
  try{await expect(runtime.run(workflow)).rejects.toThrow("injected lease release failure");}finally{release.mockRestore();}
  try{
    expect(runtime.snapshot().status).toBe("interrupted");const node=runtime.snapshot().phases[0].agents[0];expect(node.status).toBe("completed");
    const manager=await WorkspaceManager.open(join(root,"workspaces"),engineId);expect((await manager.inspect(workspaceId)).leases).toHaveLength(1);
    let businessCalls=0;
    const resumed=await RunRuntime.resume(runtime.snapshot().id,{execute:async()=>{businessCalls++;throw Error("不得重跑业务");},finalizeCompleted:actual=>executor.finalizeCompleted(actual)},join(root,"runs"));
    expect(await resumed.run(workflow)).toEqual({ok:true});expect(businessCalls).toBe(0);
    const workspace=await manager.inspect(workspaceId);expect(workspace.leases).toHaveLength(0);
    expect(await Bun.file(join(workspace.cwd,"a.txt")).text()).toBe("done\n");
    expect(await Bun.file(join(cwd,"a.txt")).text()).toBe("base\n");
    expect((await GitRepository.open(workspace.cwd)).inspect()).resolves.toMatchObject({ head: base, changedPaths: ["a.txt"] });
    const events=(await RunJournal.open(runtime.snapshot().id,join(root,"runs"))).events;
    expect(events.filter(event=>event.type==="agent.session")).toHaveLength(1);expect(events.filter(event=>event.type==="agent.restarted")).toHaveLength(0);
    expect(events.filter(event=>event.type==="execution-attempt.started")).toHaveLength(1);
    console.log(JSON.stringify({status:resumed.snapshot().status,businessCalls,sessionCount:events.filter(event=>event.type==="agent.session").length}));
  }finally{pipes.forEach(pipe=>pipe.close());executor.close();}
},180_000);

// 真实模型/登录验收仅显式开启，普通bun test不访问模型；保留隔离现场用于审计，不自动删除成果。
test.skipIf(process.env.WF_REAL_WORKSPACE_ACCEPTANCE !== "1")("真实写现场stop后保留共享worktree改动，resume新attempt继续写", async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),"wave-flow-real-partial-resume-"))),cwd=join(root,"repo");await mkdir(cwd);
 const git=async(...args:string[])=>{const child=Bun.spawn(["/usr/bin/git","-c","user.name=Acceptance","-c","user.email=acceptance@example.invalid",...args],{cwd,stdout:"pipe",stderr:"pipe"});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw Error(err);return out.trim();};
 await git("init","-b","main");await writeFile(join(cwd,"a.txt"),"base\n");await git("add","a.txt");await git("commit","-m","acceptance base");
 const base=await git("rev-parse","HEAD"),workspaceId=crypto.randomUUID(),engineId=crypto.randomUUID(),registry=new CliRuntimeRegistry();
 const cli=process.env.WF_REAL_WORKSPACE_CLI==="kimi"?"kimi":"codex";await registry.resolveWorker(cli);
 const config={version:3 as const,authorization:{authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:cwd,baseCommit:base,excludeExistingDirty:false,nodes:[{nodeId:"writer"}]},workspaceId};
 const pipes:WorkerControlPipe[]=[];
 const makeExecutor=(getRuntime:()=>RunRuntime)=>new ProductionWorkspaceExecutor(config,join(root,"workspaces"),engineId,registry,(identity,scratch)=>{
   const pipe=new WorkerControlPipe(getRuntime().createControlServer(),identity,undefined,scratch);pipes.push(pipe);
   return {name:"wave-flow-worker-control",command:process.execPath,args:[join(import.meta.dir,"../../src/desktop/engine-main.ts"),"__worker-mcp"],env:[{name:"WF_WORKER_MCP_REQUEST_FIFO",value:pipe.endpoints.requestFifo},{name:"WF_WORKER_MCP_RESPONSE_FIFO",value:pipe.endpoints.responseFifo}],close:()=>pipe.close()} as acp.McpServer;
 },null);
 let runtime!:RunRuntime;const executor=makeExecutor(()=>runtime);
 const workflow:WorkflowModule<JsonObject,unknown>={meta:{name:"partial-resume",description:"停止现场恢复",phases:[{title:"write"}]},default:async()=>{phase("write");return agent('先检查当前cwd的a.txt；仅当内容不是partial加换行时将其改成partial加换行。保留已有partial，不重复写；验证内容后返回{ok:true}。不要commit/push、联网、安装或修改其他文件。',{id:"writer",cli,sandbox:"workspace-write",schema:{type:"object",properties:{ok:{type:"boolean",const:true}},required:["ok"],additionalProperties:false}});}};
 await writeFile(join(root,"workflow.ts"),"partial-resume");runtime=await RunRuntime.create({workflow,input:{},workflowSource:"partial-resume",workflowPath:join(root,"workflow.ts"),workflowProjectCwd:cwd,clientRequestId:crypto.randomUUID(),executor,storeRoot:join(root,"runs")});
 const control=runtime.createControlServer();runtime.createControlServer=()=>control;await executor.bindRuntime(runtime,control);
 console.log(JSON.stringify({root,runId:runtime.snapshot().id,cli}));
 let arrived!:()=>void,release!:()=>void;
 const reached=new Promise<void>(resolve=>{arrived=resolve;});const barrier=new Promise<void>(resolve=>{release=resolve;});
 const originalComplete=control.complete.bind(control);
 const held=spyOn(control,"complete").mockImplementation(async submission=>{arrived();await barrier;return originalComplete(submission);});
 const pending=runtime.run(workflow);void pending.catch(()=>{});
 try{
   await Promise.race([reached,pending.then(()=>{throw Error("未进入complete窗口");})]);
   await runtime.stop();release();held.mockRestore();await pending.catch(()=>{});
   expect(runtime.snapshot().status).toBe("cancelled");const node=runtime.snapshot().phases[0].agents[0];
   await executor.finalizePartial(node);
   const manager=await WorkspaceManager.open(join(root,"workspaces"),engineId);const partial=await manager.inspect(workspaceId);
   expect(partial.leases).toHaveLength(0);expect(await Bun.file(join(partial.cwd,"a.txt")).text()).toBe("partial\n");
   let resumed!:RunRuntime;const next=makeExecutor(()=>resumed);resumed=await RunRuntime.resume(runtime.snapshot().id,next,join(root,"runs"));const nextControl=resumed.createControlServer();resumed.createControlServer=()=>nextControl;await next.bindRuntime(resumed,nextControl);
   expect(await resumed.run(workflow)).toEqual({ok:true});
   const current=resumed.snapshot().phases[0].agents[0];expect(current.agentSessionId).not.toBe(node.agentSessionId);expect(current.executionAttemptId).toBe(2);
   const final=await manager.inspect(workspaceId);expect(final.leases).toHaveLength(0);expect(await Bun.file(join(final.cwd,"a.txt")).text()).toBe("partial\n");
   expect(await Bun.file(join(cwd,"a.txt")).text()).toBe("base\n");console.log(JSON.stringify({runId:resumed.snapshot().id,status:resumed.snapshot().status,attempt:2}));
 }finally{release();held.mockRestore();pipes.forEach(pipe=>pipe.close());executor.close();}
},240_000);

test.skipIf(process.env.WF_REAL_WORKSPACE_ACCEPTANCE !== "1")("真实ACP双写共享同一worktree，Execution收尾只封存", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-workspace-")));
  const cwd = join(root, "repo"); await mkdir(cwd);
  const git = async (...args: string[]) => { const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(err); return out.trim(); };
  await git("init", "-b", "main"); await writeFile(join(cwd, "a.txt"), "base\n"); await writeFile(join(cwd, "b.txt"), "base\n"); await git("add", "--", "a.txt", "b.txt"); await git("commit", "-m", "acceptance base");
  const base = (await (await GitRepository.open(cwd)).inspect()).head;
  const engine = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const registry = new CliRuntimeRegistry();
  const cli = process.env.WF_REAL_WORKSPACE_CLI === "kimi" ? "kimi" : "codex";
  await registry.resolveWorker(cli);
  const pipes: WorkerControlPipe[] = [];
  let runtime!: RunRuntime;
  const executor = new ProductionWorkspaceExecutor({ version: 3, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: cwd, baseCommit: base, excludeExistingDirty: false, nodes: [{ nodeId: "a" }, { nodeId: "b" }] }, workspaceId }, join(root, "workspaces"), engine, registry, (identity, scratch) => {
    const pipe = new WorkerControlPipe(runtime.createControlServer(), identity, undefined, scratch); pipes.push(pipe);
    return { name: "wave-flow-worker-control", command: process.execPath, args: [join(import.meta.dir, "../../src/desktop/engine-main.ts"), "__worker-mcp"], env: [{ name: "WF_WORKER_MCP_REQUEST_FIFO", value: pipe.endpoints.requestFifo }, { name: "WF_WORKER_MCP_RESPONSE_FIFO", value: pipe.endpoints.responseFifo }], close: () => pipe.close() } as acp.McpServer;
  }, null);
  const schema = { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"], additionalProperties: false };
  const workflow: WorkflowModule<JsonObject, unknown> = { meta: { name: "workspace-acceptance", description: "真实双写验收", phases: [{ title: "write" }] }, default: async () => {
    phase("write"); const outputs = await parallel([() => agent('只修改当前cwd的a.txt为"worker-a\\n"，不要碰b.txt。不要执行git commit/push，不联网，不安装依赖。最终结果为{ok:true}。', { id: "a", cli, sandbox: "workspace-write", schema }), () => agent('只修改当前cwd的b.txt为"worker-b\\n"，不要碰a.txt。不要执行git commit/push，不联网，不安装依赖。最终结果为{ok:true}。', { id: "b", cli, sandbox: "workspace-write", schema })]);
    if (outputs.some(value => value === null)) throw new Error("Worker未交付");
    return { ok: true };
  } };
  const sourcePath = join(root, "workflow.ts"); await writeFile(sourcePath, "acceptance");
  runtime = await RunRuntime.create({ workflow, input: {}, workflowSource: "acceptance", workflowPath: sourcePath, workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), executor, storeRoot: join(root, "runs") });
  const control = runtime.createControlServer();
  // 同一个Control必须复用，不能每个MCP重建独立会话Registry。
  runtime.createControlServer = () => control;
  console.log(`真实Workspace验收现场: ${root}; run=${runtime.snapshot().id}; cli=${cli}`);
  const originalCreate = AcpSessionClient.prototype.createSession;
  const diagnosticSpy = spyOn(AcpSessionClient.prototype, "createSession").mockImplementation(async function(this: AcpSessionClient, ...args: Parameters<typeof originalCreate>) {
    try { return await originalCreate.apply(this, args); }
    catch (error) { const data = (error as { data?: unknown }).data; if (data !== undefined) console.log("ACP session/new error data:", JSON.stringify(data)); throw error; }
  });
  try {
    await executor.bindRuntime(runtime, control);
    let output: unknown;
    try { output = await runtime.run(workflow); }
    catch (error) { console.log(JSON.stringify(runtime.snapshot().phases.flatMap(phase => phase.agents).map(node => ({ id: node.id, status: node.status, diagnostic: node.diagnostic })))); throw error; }
    expect(output).toEqual({ ok: true });
    const manager = await WorkspaceManager.open(join(root, "workspaces"), engine);
    const workspace = await manager.inspect(workspaceId);
    expect(workspace.leases).toHaveLength(0);
    expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("worker-a\n");
    expect(await Bun.file(join(workspace.cwd, "b.txt")).text()).toBe("worker-b\n");
    expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n"); expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("base\n"); expect(await git("rev-parse", "HEAD")).toBe(base);
    expect(executor.config.version).toBe(3);
    const delivery = await manager.finalizeSource(runtime.snapshot().id, executor.config, ["a", "b"]);
    expect(delivery.paths).toEqual(["a.txt", "b.txt"]);
    // 零 commit：快照是不可变 tree + 证据 ref；worktree HEAD 与受管分支不前进，宿主不新增 commit。
    expect(await git("show", `${delivery.tree}:a.txt`)).toBe("worker-a"); expect(await git("show", `${delivery.tree}:b.txt`)).toBe("worker-b");
    expect(await git("rev-parse", `${delivery.evidenceRef}^{tree}`)).toBe(delivery.tree);
    expect(await git("-C", workspace.cwd, "rev-parse", "HEAD")).toBe(base); expect(await git("rev-parse", `refs/heads/codex/wf-${workspaceId}`)).toBe(base);
    expect(await manager.finalizeSource(runtime.snapshot().id, executor.config)).toEqual(delivery);
    expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n"); expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("base\n");
    expect(await git("rev-parse", "HEAD")).toBe(base);expect(await git("diff", "--cached", "--name-only")).toBe("");
    console.log(JSON.stringify({ deliveryTree: delivery.tree, evidenceRef: delivery.evidenceRef, paths: delivery.paths }));
  } finally { diagnosticSpy.mockRestore(); pipes.forEach(pipe => pipe.close()); executor.close(); }
}, 240_000);

test.skipIf(process.env.WF_REAL_WORKSPACE_ACCEPTANCE !== "1")("真实ACP新Execution接续共享worktree，新节点修正并重新验证，不跨执行Replay",async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"wave-flow-real-revision-"))),cwd=join(root,"repo");await mkdir(cwd);
 const git=async(...args:string[])=>{const p=Bun.spawn(["/usr/bin/git","-c","user.name=Acceptance","-c","user.email=acceptance@example.invalid",...args],{cwd,stdout:"pipe",stderr:"pipe"});const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code)throw Error(err);return out.trim();};
 await git("init","-b","main");await writeFile(join(cwd,"a.txt"),"base\n");await git("add","a.txt");await git("commit","-m","acceptance base");
 const base=await git("rev-parse","HEAD"),workspaceId=crypto.randomUUID(),engineId=crypto.randomUUID(),registry=new CliRuntimeRegistry(),cli=process.env.WF_REAL_WORKSPACE_CLI==="kimi"?"kimi":"codex";
 await registry.resolveWorker(cli);const pipes:WorkerControlPipe[]=[],executors:ProductionWorkspaceExecutor[]=[];
 const manager=await WorkspaceManager.open(join(root,"workspaces"),engineId),schema={type:"object",properties:{ok:{type:"boolean",const:true}},required:["ok"],additionalProperties:false};
 const original={authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:cwd,baseCommit:base,excludeExistingDirty:false,nodes:[{nodeId:"write"}]};
 const run=async(config:ExecutionWorkspaceConfig,id:string,prompt:string)=>{
  let runtime!:RunRuntime;
  const executor=new ProductionWorkspaceExecutor(config,join(root,"workspaces"),engineId,registry,(identity,scratch)=>{
   const pipe=new WorkerControlPipe(runtime.createControlServer(),identity,undefined,scratch);pipes.push(pipe);
   return {name:"wave-flow-worker-control",command:process.execPath,args:[join(import.meta.dir,"../../src/desktop/engine-main.ts"),"__worker-mcp"],env:[{name:"WF_WORKER_MCP_REQUEST_FIFO",value:pipe.endpoints.requestFifo},{name:"WF_WORKER_MCP_RESPONSE_FIFO",value:pipe.endpoints.responseFifo}],close:()=>pipe.close()} as acp.McpServer;
  },null);executors.push(executor);
  const workflow:WorkflowModule<JsonObject,unknown>={meta:{name:"revision-check",description:"现场修订",phases:[{title:"write"}]},default:async()=>{phase("write");return agent(prompt,{id,cli,sandbox:"workspace-write",schema});}};
  const path=join(root,`${id}.ts`);await writeFile(path,id);
  runtime=await RunRuntime.create({workflow,input:{},workflowSource:id,workflowPath:path,workflowProjectCwd:cwd,clientRequestId:crypto.randomUUID(),executor,storeRoot:join(root,"runs")});
  const control=runtime.createControlServer();runtime.createControlServer=()=>control;await executor.bindRuntime(runtime,control);
  expect(await runtime.run(workflow)).toEqual({ok:true});return runtime;
 };
 try{
  const firstConfig:ExecutionWorkspaceConfig={version:3,authorization:original,workspaceId};
  const first=await run(firstConfig,"write",'仅把当前cwd a.txt改为done加换行并读取验证。不commit/push、联网或安装。结果{ok:true}。');
  const firstSource=await manager.finalizeSource(first.snapshot().id,firstConfig,["write"]);
  const renewed={...original,authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),nodes:[{nodeId:"repair"}]};
  // continuation.head 必须是 worktree 当前 HEAD，不是旧快照 tree；零 commit 下 HEAD 仍为 base。
  const firstHead=await git("-C",(await manager.inspect(workspaceId)).cwd,"rev-parse","HEAD");
  const config:ExecutionWorkspaceConfig={version:3,authorization:renewed,workspaceId,continuation:{executionId:first.snapshot().id,workspaceId,head:firstHead}};
  const second=await run(config,"repair",'先读取当前cwd a.txt，必须是done加换行；若不是请如实报告，不重建旧基准。把已有内容改为repaired加换行，再读取验证。不commit/push、联网或安装。结果{ok:true}。');
  const workspace=await manager.inspect(workspaceId),source=await manager.finalizeSource(second.snapshot().id,config,["repair"]);
  expect(workspace.authorization).toEqual(original);expect(workspace.executionAuthorizations).toHaveLength(2);expect(workspace.executionAuthorizations?.[1].authorization).toEqual(renewed);
  expect(source.paths).toEqual(["a.txt"]);expect(await git("show",`${source.tree}:a.txt`)).toBe("repaired");expect(await git("rev-parse",`${source.evidenceRef}^{tree}`)).toBe(source.tree);
  expect(await git("-C",workspace.cwd,"rev-parse","HEAD")).toBe(base);expect(await git("rev-parse",`refs/heads/codex/wf-${workspaceId}`)).toBe(base);
  expect(await Bun.file(join(workspace.cwd,"a.txt")).text()).toBe("repaired\n");expect(await Bun.file(join(cwd,"a.txt")).text()).toBe("base\n");
  const oldEvents=(await RunJournal.open(first.snapshot().id,join(root,"runs"))).events,newEvents=(await RunJournal.open(second.snapshot().id,join(root,"runs"))).events;
  expect(newEvents.filter(item=>item.type==="agent.session")).toHaveLength(1);expect(newEvents.filter(item=>item.type==="agent.restarted")).toHaveLength(0);expect(second.snapshot().currentExecutionAttemptId).toBe(1);
  expect(newEvents.find(item=>item.type==="agent.session")!.agentSessionId).not.toBe(oldEvents.find(item=>item.type==="agent.session")!.agentSessionId);
  console.log(JSON.stringify({root,firstExecution:first.snapshot().id,secondExecution:second.snapshot().id,firstTree:firstSource.tree,secondTree:source.tree,cli}));
 }finally{pipes.forEach(pipe=>pipe.close());executors.forEach(executor=>executor.close());}
},240_000);

test.skipIf(process.env.WF_REAL_WORKSPACE_ACCEPTANCE !== "1")("真实Engine保存来源、读取diff，结果只保留在worktree", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-real-auto-delivery-"))), cwd = join(root, "repo"); await mkdir(cwd);
  const git = async (...args: string[]) => { const p = Bun.spawn(["/usr/bin/git", "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code) throw Error(err); return out.trim(); };
  await git("init", "-b", "main"); await writeFile(join(cwd, "a.txt"), "base\n"); await git("add", "a.txt"); await git("commit", "-m", "acceptance base");
  const base = await git("rev-parse", "HEAD"), cli = process.env.WF_REAL_WORKSPACE_CLI === "kimi" ? "kimi" : "codex";
  const selected = await new CliRuntimeRegistry().resolveWorker(cli), registry = new CliRuntimeRegistry(root);
  const saved = await registry.saveVerified(selected); await registry.select(saved.runtimeId);
  const source = `const meta={name:"auto-delivery",description:"自动单条交付",phases:[{title:"write"}]};async function run(args){phase("write");return agent('只修改当前cwd的a.txt为done加换行。不要git commit、push、联网、安装。最终结果{ok:true}。',{id:"writer",cli:"${cli}",sandbox:"workspace-write",schema:{type:"object",properties:{ok:{type:"boolean",const:true}},required:["ok"],additionalProperties:false}});}`;
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), createHarnessSession: async (_id, _cwd, _prior, actions) => ({ isRunning: false, subscribe: () => () => {}, abort: () => {}, close: () => {}, prompt: async text => { if (text.startsWith("请总结")) return "业务已完成；Git交付请以真实证据为准，不代表业务验收。"; await actions.proposeWorkflowRevision(source, "自动交付验收", "只写a.txt"); return "方案已提出"; } }) });
  try {
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as import("../../src/desktop/types").HarnessProjectResponse;
    const started = await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, clientRequestId: crypto.randomUUID(), text: "生成自动交付验收方案" }) as import("../../src/desktop/types").HarnessRunResponse;
    const taskId = started.harness.harnessRunId;
    for (let n = 0; n < 1000; n++) { const value = await engine.handleDesktopAction("harnesses.get", { harnessRunId: taskId }) as import("../../src/desktop/types").HarnessRunResponse; if (value.harness.status === "idle" && value.harness.workflowRevisions.length) break; await Bun.sleep(10); }
    const plan = await engine.handleDesktopAction("executions.plan", { harnessRunId: taskId, revision: 1 }) as import("../../src-tauri/web/src/types").ExecutionPlanResponse;
    const workspaces = { version: 3 as const, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: cwd, baseCommit: base, excludeExistingDirty: false, nodes: [{ nodeId: "writer" }] }, workspaceId: crypto.randomUUID() };
    const request = new DesignConfirmationCache().get(`${taskId}:1`, {}, {}, plan, workspaces);
    const created = await engine.handleDesktopAction("executions.confirm", { harnessRunId: taskId, revision: 1, config: request.config, clientRequestId: request.id, input: {} }) as import("../../src/desktop/types").ExecutionResponse;
    console.log(JSON.stringify({ root, taskId, executionId: created.execution.executionId, cli }));
    let detail = created;
    const deadline = Date.now() + 150_000;
    while (detail.execution.finishedAt === null && Date.now() < deadline) { await Bun.sleep(100); detail = await engine.handleDesktopAction("executions.get", { harnessRunId: taskId, executionId: created.execution.executionId }) as import("../../src/desktop/types").ExecutionResponse; }
    expect(detail.execution.status, detail.execution.diagnostic ?? "").toBe("completed");
    expect(detail.sourceDiagnostic).toBeUndefined(); expect(detail.sourceEvidence).toBeDefined();
    const delivery = detail.sourceEvidence!;
    // 零 commit：快照是不可变 tree + 证据 ref，内容可达但宿主不新增 commit，HEAD 不前进。
    expect(await git("show", `${delivery.tree}:a.txt`)).toBe("done");
    expect(await git("rev-parse", `${delivery.evidenceRef}^{tree}`)).toBe(delivery.tree);
    expect(await git("rev-parse", `refs/heads/codex/wf-${workspaces.workspaceId}`)).toBe(base);
    expect(await git("rev-parse", "HEAD")).toBe(base); expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
    expect(await git("diff", "--cached", "--name-only")).toBe("");
    const identity={harnessRunId:taskId,executionId:detail.execution.executionId};
    const review=await engine.handleDesktopAction("executions.review",identity) as import("../../src/workspace/git-repository").GitReview;
    expect(review.paths).toEqual(["a.txt"]); expect(review.sourceTree).toBe(delivery.tree);
    console.log(JSON.stringify({ root, taskId, executionId: detail.execution.executionId, delivery }));
  } finally { engine.shutdown(); }
}, 180_000);
