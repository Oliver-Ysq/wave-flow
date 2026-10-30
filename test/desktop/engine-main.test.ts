import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { DesktopExecutionEngine } from "../../src/desktop/desktop-execution-engine";
import { serveEngineRequests } from "../../src/desktop/engine-dispatch";
import { CliRuntimeRegistry } from "../../src/runtimes/registry";
import { verifyExecutable } from "../../src/runtimes/identity";
import type { CliRuntimeRecord } from "../../src/runtimes/types";
import type { HarnessSession } from "../../src/harness/session";
import { listWorkflowTemplates } from "../../src/harness/workflow-templates";
import { WorkspaceManager } from "../../src/workspace/workspace-manager";
import { HarnessService } from "../../src/harness/service";
import { HarnessExecutionService } from "../../src/harness/executions";
import { mkdir, realpath } from "node:fs/promises";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

test("Engine重启不补成果快照、不重跑业务；completed resume 只读返回原终态", async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),"wave-flow-no-source-")));roots.push(root);
 const cwd=join(root,"repo");await mkdir(cwd);
 const git=async(...args:string[])=>{const p=Bun.spawn(["/usr/bin/git","-c","user.name=Test","-c","user.email=test@example.invalid",...args],{cwd,stdout:"pipe",stderr:"pipe"});const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code)throw Error(err);return out.trim();};
 await git("init","-b","main");await writeFile(join(cwd,"a.txt"),"base\n");await git("add","a.txt");await git("commit","-m","fixture");
 const base=await git("rev-parse","HEAD"),workspaceId=crypto.randomUUID(),harnessRoot=join(root,"harness-runs");
 const manager=await WorkspaceManager.open(join(root,"workspaces"),crypto.randomUUID());
 const authorization={authorizationId:crypto.randomUUID(),approvedAt:new Date().toISOString(),repository:cwd,baseCommit:base,excludeExistingDirty:false,nodes:[{nodeId:"writer"}]};
 const workspace=await manager.create(workspaceId,authorization);
 const harness=new HarnessService(harnessRoot,async()=>{throw Error("不会运行主控");});const task=await harness.create(cwd);
 const source='import { agent, phase } from "wave-flow";\nexport const meta={name:"no-source",description:"无快照",phases:[{title:"write"}],inputSchema:{type:"object",properties:{},additionalProperties:false}};\nexport default async function run(args){phase("write");return agent("写文件",{id:"writer",cli:"codex",sandbox:"workspace-write"});}';
 await harness.proposeWorkflowRevision(task.harnessRunId,source);await harness.acceptWorkflowRevision(task.harnessRunId,1);
 // 模块 Workflow 只接受脚本模式配置；CLI 由源码字面量决定，这里只冻结 Git 成果授权。
 const config={version:1 as const,assignmentMode:"script" as const,createdAt:new Date().toISOString(),workspaces:{version:3 as const,authorization,workspaceId}};
 let calls=0,runId="";
 const executions=new HarnessExecutionService(harness,()=>({executor:{execute:async node=>{calls++;const lease=await manager.bindWriter(await manager.acquire(workspaceId,{runId:runId,nodeId:node.id,attempt:node.executionAttemptId}),"test-writer",{pgid:54321,startedAt:"test-fingerprint"});await writeFile(join(workspace.cwd,"a.txt"),"final\n");await manager.release(lease,async()=>true);return {ok:true};}}}),{wireControl:runtime=>{runId=runtime.snapshot().id;}},harnessRoot,join(root,"runs"),join(root,"workspaces"));
 const {execution}=await executions.createExecution(task.harnessRunId,1,{},config);
 for(let n=0;n<1000;n++){if((await executions.listExecutions(task.harnessRunId))[0].finishedAt!==null)break;await Bun.sleep(10);}
 expect((await executions.listExecutions(task.harnessRunId))[0].status).toBe("completed");expect(calls).toBe(1);harness.close();
 const engine=new DesktopExecutionEngine({storeRoot:join(root,"runs"),harnessRoot,deterministicForTest:true});
 try {
  await engine.convergeStaleAcpWorkers();
  const detail=await engine.handleDesktopAction("executions.get",{harnessRunId:task.harnessRunId,executionId:execution.executionId}) as import("../../src/desktop/types").ExecutionResponse;
  expect(detail.workspaceEvidence?.cwd).toBe(workspace.cwd);
  // 宿主不创建任何成果 ref；结果就是 worktree 里的未提交文件。
  expect(await git("for-each-ref","--format=%(refname)","refs/wave-flow")).toBe("");
  expect(await Bun.file(join(workspace.cwd,"a.txt")).text()).toBe("final\n");
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
  // completed 的 resume 不再补收尾，也不重跑业务。
  await engine.handleDesktopAction("executions.resume",{harnessRunId:task.harnessRunId,executionId:execution.executionId});
  expect(calls).toBe(1);
  expect(await git("-C",workspace.cwd,"rev-parse","HEAD")).toBe(base);
  expect(await git("rev-parse",`refs/heads/codex/wf-${workspaceId}`)).toBe(base);
  // 主工作区不动。
  expect(await git("rev-parse","HEAD")).toBe(base);expect(await Bun.file(join(cwd,"a.txt")).text()).toBe("base\n");
  expect(await git("diff","--cached","--name-only")).toBe("");expect(await git("status","--porcelain")).toBe("");
 }finally{engine.shutdown();}
},30_000);
afterEach(async () => { for (const child of children.splice(0)) child.kill(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });


test("Engine 停止总结必须携带本次turnId，缺失或非法身份在读档前拒绝",async()=>{
 const root=await mkdtemp(join(tmpdir(),"wave-flow-stop-summary-"));roots.push(root);
 const engine=new DesktopExecutionEngine({storeRoot:join(root,"runs"),harnessRoot:join(root,"harness-runs"),deterministicForTest:true});
 try{
  for(const turnId of [undefined,null,""," ",42]){
   await expect(engine.handleDesktopAction("harnesses.stopImpactSummary",{harnessRunId:crypto.randomUUID(),key:"a".repeat(64),turnId})).rejects.toThrow("turnId");
  }
  expect(await engine.handleDesktopAction("harnesses.list",{})).toMatchObject({harnesses:[]});
  expect(await engine.handleDesktopAction("status",{})).toMatchObject({activeRuns:0,activeHarnesses:0});
 }finally{engine.shutdown();}
});

test("Engine 参数编辑 IPC 缺失或非法基础版本在读取任务前拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-template-version-")); roots.push(root);
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true });
  const template = listWorkflowTemplates()[0]!;
  const args = { harnessRunId: crypto.randomUUID(), cardId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), template: { id: template.id, version: template.version, sourceHash: template.sourceHash, input: {} } };
  try {
    for (const baseRevision of [undefined, 0, -1, 1.5, "1", null]) {
      await expect(engine.handleDesktopAction("templates.save", { ...args, baseRevision })).rejects.toThrow("编辑参数必须绑定基础版本");
    }
    expect(await engine.handleDesktopAction("harnesses.list", {})).toMatchObject({ harnesses: [] });
    expect(await engine.handleDesktopAction("status", {})).toMatchObject({ activeRuns: 0, activeHarnesses: 0 });
  } finally { engine.shutdown(); }
});

/** 私有 Engine 进程必须无需 HTTP/端口完成 ready、状态与受控退出。 */
test("Desktop Engine 通过 stdin/stdout JSONL 提供状态并在 shutdown 后退出", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-")); roots.push(root);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<unknown> => {
    while (true) {
      const index = buffered.indexOf("\n");
      if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); }
      const value = await reader.read(); if (value.done) throw new Error("Engine 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true });
    }
  };
  expect(await next()).toEqual({ type: "ready", protocolVersion: 1 });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "status", method: "engine.status" })}\n`));
  expect(await next()).toMatchObject({ requestId: "status", ok: true, result: { activeRuns: 0, activeHarnesses: 0 } });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "actions-status", method: "engine.action", action: "status", args: {} })}\n`));
  expect(await next()).toMatchObject({ requestId: "actions-status", ok: true, result: { activeRuns: 0, activeHarnesses: 0 } });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "legacy", method: `engine.${"http"}` })}\n`));
  expect(await next()).toMatchObject({ requestId: "legacy", ok: false, error: "Engine 请求方法无效。 " });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "close", method: "engine.shutdown" })}\n`));
  expect(await next()).toEqual({ requestId: "close", ok: true, result: { accepted: true } });
  expect(await child.exited).toBe(0);
}, 15_000);

/** 实际 Harness 快照可能远大于 pipe 单个读取块；Engine 必须逐行输出完整 JSON。 */
test("Desktop Engine 对大 Harness 列表响应保持完整 JSONL 帧", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-large-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-large-project-")); roots.push(cwd);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const next = async (): Promise<unknown> => { while (true) { const index = buffer.indexOf("\n"); if (index >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); const frame=JSON.parse(line);if(frame.type==="event")continue;return frame; } const value = await reader.read(); if (value.done) throw new Error("Engine 在响应前关闭。 "); buffer += decoder.decode(value.value, { stream: true }); } };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  expect(await next()).toEqual({ type: "ready", protocolVersion: 1 });
  // 构造远超单个 pipe 读取块（通常 64KB）的真实大响应：项目 + 多条接近上限的大消息。
  send({ requestId: "project", method: "engine.action", action: "projects.create", args: { cwd } });
  const project = await next() as { result: { project: { projectId: string } } };
  const projectId = project.result.project.projectId;
  send({ requestId: "start", method: "engine.action", action: "harnesses.startConversation", args: { projectId, clientRequestId:crypto.randomUUID(), text: "大帧测试".repeat(4_500) } });
  expect(await next()).toMatchObject({ ok: true });
  send({ requestId: "list-0", method: "engine.action", action: "harnesses.list", args: {} });
  const created = await next() as { result: { harnesses: { harnessRunId: string }[] } };
  const harnessRunId = created.result.harnesses[0].harnessRunId;
  const waitIdle = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      send({ requestId: `idle-${attempt}`, method: "engine.action", action: "harnesses.get", args: { harnessRunId } });
      // 事件帧与响应共用通道：等待响应时必须跳过无 requestId 的事件帧。
      let current = await next() as { type?: string; result?: { harness: { status: string } } };
      while (current.type === "event") current = await next() as typeof current;
      if (current.result!.harness.status !== "running") return;
      await Bun.sleep(10);
    }
    throw new Error("Harness 回合未在时限内结束。 ");
  };
  await waitIdle();
  for (let index = 0; index < 5; index += 1) {
    send({ requestId: `message-${index}`, method: "engine.action", action: "harnesses.send", args: { harnessRunId, text: "后续消息".repeat(4_500) } });
    expect(await next()).toMatchObject({ ok: true });
    await waitIdle();
  }
  send({ requestId: "harnesses", method: "engine.action", action: "harnesses.list", args: {} });
  const response = await next() as { requestId: string; ok: boolean; result: { harnesses: unknown[] } };
  expect(response.requestId).toBe("harnesses");
  expect(response.ok).toBe(true);
  // 响应体必须真实大于一个读取块，且 JSON 解析后的消息完整无截断。
  expect(JSON.stringify(response).length).toBeGreaterThan(64 * 1024);
  expect(Array.isArray(response.result.harnesses)).toBe(true);
  expect((response.result.harnesses as { messages: unknown[] }[])[0].messages.length).toBeGreaterThanOrEqual(12);
  send({ requestId: "close", method: "engine.shutdown" });
  await next(); expect(await child.exited).toBe(0);
}, 15_000);

/** 新 Engine 的 ready 只能在遗留 ACP 会话被耐久收敛后发出，避免短暂假活跃。 */
test("Desktop Engine 启动时将上次未结束的 ACP Worker 收敛为 interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-reconcile-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-project-")); roots.push(cwd);
  const runId = crypto.randomUUID();
  const manifest: RunManifest = { runId, clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "reconcile", description: "reconcile", phases: [{ title: "run" }] }, workflowHash: "a".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  await writeFile(manifest.workflowPath, "export default async function run() {}\n");
  const journal = await RunJournal.create(manifest, runsRoot(root));
  const events: JournalEvent[] = [
    { type: "execution-attempt.started", at: new Date().toISOString(), runId, nodeId: null, agentSessionId: null, diagnostic: null, executionAttemptId: 1 },
    { type: "phase.entered", at: new Date().toISOString(), runId, nodeId: null, agentSessionId: null, diagnostic: null, title: "run", phaseVisitId: 1, occurrence: 1, executionAttemptId: 1 },
    { type: "agent.created", at: new Date().toISOString(), runId, nodeId: "worker", agentSessionId: null, diagnostic: null, sequence: 1, logicalSequence: 1, phase: "run", phaseVisitId: 1, executionAttemptId: 1, executionBatch: { sequence: 1, mode: "serial" }, request: { id: "worker", cli: "codex", sandbox: "workspace-write", cwd, prompt: "work", phase: "run" } },
    { type: "agent.status", at: new Date().toISOString(), runId, nodeId: "worker", agentSessionId: "old-session", diagnostic: null, status: "running" },
    { type: "agent.session", at: new Date().toISOString(), runId, nodeId: "worker", agentSessionId: "old-session", diagnostic: null, delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "native-old", capabilities: {} } },
  ];
  for (const event of events) await journal.append(event);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const first = await reader.read();
  expect(JSON.parse(new TextDecoder().decode(first.value).trim())).toEqual({ type: "ready", protocolVersion: 1 });
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "status", method: "engine.status" })}\n`));
  const response = await reader.read();
  expect(JSON.parse(new TextDecoder().decode(response.value).trim())).toMatchObject({ requestId: "status", ok: true, result: { acpWorkersNeedingResume: 1 } });
  const reopened = await RunJournal.open(runId, runsRoot(root));
  expect(reopened.events).toContainEqual(expect.objectContaining({ type: "agent.status", nodeId: "worker", status: "interrupted" }));
  expect(reopened.events).toContainEqual(expect.objectContaining({ type: "run.status", status: "interrupted" }));
  child.stdin.write(new TextEncoder().encode(`${JSON.stringify({ requestId: "close", method: "engine.shutdown" })}\n`));
  await reader.read(); await child.exited;
}, 15_000);

/** 暂停控制在进程崩溃时同样不能留下 paused 节点与 interrupted Run 的矛盾投影。 */
test("Desktop Engine 启动时收敛 paused 节点，再将 Run 标为 interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-paused-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-paused-project-")); roots.push(cwd);
  const runId = crypto.randomUUID();
  const manifest: RunManifest = { runId, clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "paused", description: "paused", phases: [{ title: "run" }] }, workflowHash: "b".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  await writeFile(manifest.workflowPath, "export default async function run() {}\n");
  const journal = await RunJournal.create(manifest, runsRoot(root));
  const at = new Date().toISOString();
  const events: JournalEvent[] = [
    { type: "execution-attempt.started", at, runId, nodeId: null, agentSessionId: null, diagnostic: null, executionAttemptId: 1 },
    { type: "phase.entered", at, runId, nodeId: null, agentSessionId: null, diagnostic: null, title: "run", phaseVisitId: 1, occurrence: 1, executionAttemptId: 1 },
    { type: "agent.created", at, runId, nodeId: "paused-worker", agentSessionId: null, diagnostic: null, sequence: 1, logicalSequence: 1, phase: "run", phaseVisitId: 1, executionAttemptId: 1, executionBatch: { sequence: 1, mode: "serial" }, request: { id: "paused-worker", cli: "codex", sandbox: "workspace-write", cwd, prompt: "work", phase: "run" } },
    { type: "agent.status", at, runId, nodeId: "paused-worker", agentSessionId: "old-paused-session", diagnostic: null, status: "running" },
    { type: "agent.session", at, runId, nodeId: "paused-worker", agentSessionId: "old-paused-session", diagnostic: null, delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "native-old-paused", capabilities: {} } },
    { type: "run.status", at, runId, nodeId: null, agentSessionId: null, diagnostic: "pause", status: "pausing" },
    { type: "agent.status", at, runId, nodeId: "paused-worker", agentSessionId: "old-paused-session", diagnostic: "pause", status: "pausing" },
    { type: "agent.status", at, runId, nodeId: "paused-worker", agentSessionId: "old-paused-session", diagnostic: "paused", status: "paused" },
    { type: "run.status", at, runId, nodeId: null, agentSessionId: null, diagnostic: "paused", status: "paused" },
  ];
  for (const event of events) await journal.append(event);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); await reader.read();
  const reopened = await RunJournal.open(runId, runsRoot(root));
  const statusEvents = reopened.events.filter((event): event is Extract<JournalEvent, { type: "agent.status" }> => event.type === "agent.status" && event.nodeId === "paused-worker");
  expect(statusEvents.at(-1)?.status).toBe("interrupted");
  expect(reopened.events.filter((event): event is Extract<JournalEvent, { type: "run.status" }> => event.type === "run.status").at(-1)?.status).toBe("interrupted");
  child.kill(); await child.exited;
}, 15_000);

/** 事件帧与请求响应共用同一 JSONL 通道：事件帧带协议版本/会话 ID/单调序号，响应关联不受影响。 */
test("Desktop Engine 事件帧携带协议版本与单调序号，与请求响应同通道分流", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-events-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-events-project-")); roots.push(cwd);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => {
    while (true) {
      const index = buffered.indexOf("\n");
      if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line) as Record<string, unknown>; }
      const value = await reader.read(); if (value.done) throw new Error("Engine 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true });
    }
  };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  expect(await next()).toEqual({ type: "ready", protocolVersion: 1 });
  send({ requestId: "project", method: "engine.action", action: "projects.create", args: { cwd } });
  const project = await next() as { result: { project: { projectId: string } } };
  const frames: { seq: number; event: { type: string }; harnessRunId: string }[] = [];
  let harnessRunId = "";
  // 等待响应的同时收集事件帧：中文正文跨 pipe 读取块时帧也必须完整可解析。
  send({ requestId: "start", method: "engine.action", action: "harnesses.startConversation", args: { projectId: project.result.project.projectId, clientRequestId:crypto.randomUUID(), text: "观察事件帧".repeat(2_000) } });
  let sawTurnFinished = false;
  for (let attempt = 0; attempt < 400 && !sawTurnFinished; attempt += 1) {
    const frame = await next();
    if (frame.type === "event") {
      expect(frame.protocolVersion).toBe(1);
      expect(frame.stream).toBe("harness");
      const eventFrame = frame as unknown as { harnessRunId: string; seq: number; event: { type: string } };
      if (harnessRunId) expect(eventFrame.harnessRunId).toBe(harnessRunId);
      harnessRunId = eventFrame.harnessRunId;
      frames.push(eventFrame);
      if (eventFrame.event.type === "turn_finished") sawTurnFinished = true;
    }
  }
  expect(sawTurnFinished).toBe(true);
  // 序号从 1 开始严格递增；帧内只允许耐久派生事件，瞬时 delta 不上帧。
  expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
  expect(frames.some((frame) => frame.event.type === "entry_started")).toBe(true);
  expect(frames.some((frame) => frame.event.type === "entry_finished")).toBe(true);
  expect(frames.every((frame) => !["reasoning_delta", "assistant_delta", "acp_tool_call", "acp_tool_update"].includes(frame.event.type))).toBe(true);
  // 事件流之后请求响应通道仍然正常工作。
  send({ requestId: "after", method: "engine.action", action: "harnesses.list", args: {} });
  const listed = await next() as { requestId: string; ok: boolean };
  expect(listed).toMatchObject({ requestId: "after", ok: true });
  send({ requestId: "close", method: "engine.shutdown" });
  await next(); expect(await child.exited).toBe(0);
}, 15_000);

/** Runtime action 契约：已移除的 setWorkerEnabled 一律拒绝，validate 必须显式携带 cli。 */test("Engine runtime action 校验 validate 请求并拒绝已移除的 setWorkerEnabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-runtimes-")); roots.push(root);
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = "";
  const next = async (): Promise<{ ok?: boolean; error?: string; type?: string; protocolVersion?: number }> => {
    while (true) {
      const index = buffered.indexOf("\n");
      if (index >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); return JSON.parse(line); }
      const value = await reader.read(); if (value.done) throw new Error("Engine 在响应前关闭。 "); buffered += decoder.decode(value.value, { stream: true });
    }
  };
  const send = (value: unknown) => child.stdin.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  expect(await next()).toEqual({ type: "ready", protocolVersion: 1 });
  // Worker 启用池已移除：旧 action 不再注册，一律按未知 action 拒绝
  send({ requestId: "toggle-removed", method: "engine.action", action: "runtimes.setWorkerEnabled", args: { runtimeId: crypto.randomUUID(), enabled: true } });
  expect((await next()).error).toContain("未知 Desktop action");
  send({ requestId: "validate-no-cli", method: "engine.action", action: "runtimes.validate", args: { executablePath: "/bin/sh" } });
  expect((await next()).error).toContain("验证请求无效");
  send({ requestId: "validate-bad-cli", method: "engine.action", action: "runtimes.validate", args: { executablePath: "/bin/sh", cli: "traex" } });
  expect((await next()).error).toContain("验证请求无效");
  send({ requestId: "close", method: "engine.shutdown" });
  await next(); expect(await child.exited).toBe(0);
}, 15_000);

/** 崩溃可发生在首个 Agent session 建立前；没有节点也不能把丢失调用栈伪装成 running。 */
test("Desktop Engine 启动时将无 Agent 的 live Run 收敛为 interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-empty-live-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-empty-live-project-")); roots.push(cwd);
  const runId = crypto.randomUUID();
  const manifest: RunManifest = { runId, clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION, workflow: { name: "empty-live", description: "empty-live", phases: [{ title: "run" }] }, workflowHash: "c".repeat(64), workflowPath: join(cwd, "workflow.ts"), workflowProjectCwd: cwd, input: {}, createdAt: new Date().toISOString() };
  await writeFile(manifest.workflowPath, "export default async function run() {}\n");
  const journal = await RunJournal.create(manifest, runsRoot(root));
  await journal.append({ type: "execution-attempt.started", at: new Date().toISOString(), runId, nodeId: null, agentSessionId: null, diagnostic: null, executionAttemptId: 1 });
  const entry = new URL("../../src/desktop/engine-main.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, WAVE_FLOW_HOME: root, WF_ENGINE_DETERMINISTIC: "1" } }); children.push(child);
  const reader = child.stdout.getReader(); await reader.read();
  const reopened = await RunJournal.open(runId, runsRoot(root));
  expect(reopened.events.filter((event): event is Extract<JournalEvent, { type: "run.status" }> => event.type === "run.status").at(-1)?.status).toBe("interrupted");
  child.kill(); await child.exited;
}, 15_000);

/** 主控切换的空闲语义在 Engine 层：运行中回合拒绝（409），空闲后允许并耐久 harnessRuntimeId。 */
test("Engine 有运行中主控回合时拒绝切换主控，空闲后允许", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-harness-switch-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-switch-project-")); roots.push(cwd);
  const registry = new CliRuntimeRegistry(root);
  const runtimeRecord = async (name: string, cli: "codex" | "claude", harnessTools: boolean): Promise<CliRuntimeRecord> => {
    const executablePath = join(root, name); await writeFile(executablePath, "#!/bin/sh\necho cli\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
    const executable = await verifyExecutable(executablePath);
    return { runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity, version: `${cli} 1.0`, discoveredFrom: "manual", discoveredShell: null, verifiedAdapter: { adapterId: cli === "claude" ? "claude-acp" : "codex-acp", adapterVersion: "1.0", acpProtocolVersion: 1, harnessTools }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
  };
  const first = await registry.saveVerified(await runtimeRecord("codex-a", "codex", true));
  const second = await registry.saveVerified(await runtimeRecord("kimi-b", "claude", true));
  const workerOnly = await registry.saveVerified(await runtimeRecord("kimi-c", "claude", false));
  let release: (() => void) | null = null;
  const session: HarnessSession = {
    isRunning: true,
    subscribe: () => () => {},
    abort: () => {},
    prompt: () => new Promise<string>((resolve) => { release = () => resolve("回合完成"); }),
  };
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), createHarnessSession: async () => session });
  try {
    await engine.handleDesktopAction("runtimes.select", { runtimeId: first.runtimeId });
    // 无 harnessTools 的 runtime 即使空闲也不能设为主控。
    await expect(engine.handleDesktopAction("runtimes.select", { runtimeId: workerOnly.runtimeId })).rejects.toMatchObject({ status: 400 });
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as { project: { projectId: string } };
    await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, clientRequestId:crypto.randomUUID(), text: "进行中的回合" });
    await expect(engine.handleDesktopAction("runtimes.select", { runtimeId: second.runtimeId })).rejects.toMatchObject({ status: 409 });
    release!();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const listed = await engine.handleDesktopAction("harnesses.list", {}) as { harnesses: { status: string }[] };
      if (listed.harnesses.every((harness) => harness.status !== "running")) break;
      await Bun.sleep(10);
    }
    await engine.handleDesktopAction("runtimes.select", { runtimeId: second.runtimeId });
    const listed = await engine.handleDesktopAction("runtimes.list", {}) as { harnessRuntimeId: string | null };
    expect(listed.harnessRuntimeId).toBe(second.runtimeId);
  } finally { engine.shutdown(); }
});

/** validate action 统一走 Catalog 驱动的单验证器，测试缝签名为 (cli, input)。 */
test("Engine runtimes.validate 走统一验证器入口", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-validate-")); roots.push(root);
  const seen: { cli: string; executablePath: string }[] = [];
  const executablePath = join(root, "claude"); await writeFile(executablePath, "#!/bin/sh\necho kimi\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true,
    validateCliRuntime: async (cli, input) => {
      seen.push({ cli, executablePath: input.executablePath });
      return { runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity, version: "kimi 2.1.1", discoveredFrom: input.discoveredFrom, discoveredShell: input.discoveredShell, verifiedAdapter: { adapterId: "claude-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
    },
  });
  try {
    const response = await engine.handleDesktopAction("runtimes.validate", { executablePath, cli: "claude" }) as { runtime: { cli: string } };
    expect(response.runtime.cli).toBe("claude");
    expect(seen).toEqual([{ cli: "claude", executablePath }]);
    const listed = await engine.handleDesktopAction("runtimes.list", {}) as { runtimes: { cli: string }[] };
    expect(listed.runtimes).toHaveLength(1);
  } finally { engine.shutdown(); }
});
/** 回归：用户把 Kimi 路径留在“Codex CLI”种类上时，按可执行文件名识别真实种类验证，
 * 不再把上游适配器的英文进程退出错误（unknown command 'app-server'）暴露给用户。 */
test("Engine runtimes.validate 按文件名识别真实 CLI 种类", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-detect-")); roots.push(root);
  const seen: string[] = [];
  const executablePath = join(root, "claude"); await writeFile(executablePath, "#!/bin/sh\necho kimi\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true,
    validateCliRuntime: async (cli, input) => {
      seen.push(cli);
      return { runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity, version: "kimi 2.1.1", discoveredFrom: input.discoveredFrom, discoveredShell: input.discoveredShell, verifiedAdapter: { adapterId: "claude-acp", adapterVersion: "2.1.1", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
    },
  });
  try {
    const response = await engine.handleDesktopAction("runtimes.validate", { executablePath, cli: "codex" }) as { runtime: { cli: string } };
    expect(response.runtime.cli).toBe("claude");
    expect(seen).toEqual(["claude"]);
  } finally { engine.shutdown(); }
});

/** 识别不出种类且两种都失败时，仍要把上游进程退出错误翻译成可操作中文，不原样回显。 */
test("Engine runtimes.validate 翻译上游进程退出错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-translate-")); roots.push(root);
  const executablePath = join(root, "custom-cli"); await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true,
    validateCliRuntime: async () => { throw new Error("Codex process has exited with code 1: unknown command 'app-server'. See 'kimi --help'."); },
  });
  try {
    await expect(engine.handleDesktopAction("runtimes.validate", { executablePath, cli: "codex" })).rejects.toThrow("这个程序不提供 Codex 的 ACP 入口");
  } finally { engine.shutdown(); }
});

/** dsh 在旧 Node 下静默退出零输出：版本读取失败必须翻译成可操作的 Node ≥ 24 提示。 */
test("Engine runtimes.validate 把 dsh 旧 Node 静默退出翻译为 Node 版本提示", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-dsh-translate-")); roots.push(root);
  const executablePath = join(root, "dsh"); await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true,
    validateCliRuntime: async () => { throw new Error("无法读取 DeepSeek Harness 版本。 "); },
  });
  try {
    await expect(engine.handleDesktopAction("runtimes.validate", { executablePath, cli: "dsh" })).rejects.toThrow("DeepSeek Harness（dsh）需要 Node ≥ 24 运行时");
  } finally { engine.shutdown(); }
});

/** 识别不到种类的自定义文件名按 Catalog 全种类回退尝试，不再只有二元。 */
test("Engine runtimes.validate 未识别种类时按 Catalog 全部种类回退", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-fallback-")); roots.push(root);
  const seen: string[] = [];
  const executablePath = join(root, "custom-cli"); await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true,
    validateCliRuntime: async (cli, input) => {
      seen.push(cli);
      if (cli !== "dsh") throw new Error("fixture 失败。 ");
      return { runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity, version: "0.2.1-rc.2", discoveredFrom: input.discoveredFrom, discoveredShell: input.discoveredShell, verifiedAdapter: { adapterId: "dsh-acp", adapterVersion: "0.0.1", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
    },
  });
  try {
    const response = await engine.handleDesktopAction("runtimes.validate", { executablePath, cli: "codex" }) as { runtime: { cli: string } };
    expect(response.runtime.cli).toBe("dsh");
    expect(seen).toEqual(["codex", "claude", "dsh"]);
  } finally { engine.shutdown(); }
});

/** 用户把 Claude 路径留在其他种类上时，按可执行文件名识别为 claude。 */
test("Engine runtimes.validate 按文件名识别 claude 种类", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-detect-claude-")); roots.push(root);
  const seen: string[] = [];
  const executablePath = join(root, "claude"); await writeFile(executablePath, "#!/bin/sh\necho claude\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true,
    validateCliRuntime: async (cli, input) => {
      seen.push(cli);
      return { runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity, version: "2.0.0 (Claude Code)", discoveredFrom: input.discoveredFrom, discoveredShell: input.discoveredShell, verifiedAdapter: { adapterId: "claude-acp", adapterVersion: "0.94.0", acpProtocolVersion: 1, harnessTools: false }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null };
    },
  });
  try {
    const response = await engine.handleDesktopAction("runtimes.validate", { executablePath, cli: "codex" }) as { runtime: { cli: string } };
    expect(response.runtime.cli).toBe("claude");
    expect(seen).toEqual(["claude"]);
  } finally { engine.shutdown(); }
});

/** 探测只是排序与诊断：`--version` 失败（例如 node 入口需要 Engine 解析 node）仍要对
 * 首个候选做完整验证，不能把探测结论当成“未安装”。 */
test("扫描在探测无结论时仍完整验证首个候选，并清掉失败结论", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-scan-probe-")); roots.push(root);
  const executablePath = join(root, "codex");
  await writeFile(executablePath, "#!/bin/sh\nexit 1\n", { mode: 0o700 }); await chmod(executablePath, 0o700);
  const executable = await verifyExecutable(executablePath);
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true,
    discoverCliRuntimes: async () => [{ cli: "codex", executablePath: executable.executablePath, discoveredFrom: "shell-path", discoveredShell: "/bin/zsh", aliases: [executablePath] }],
    validateCliRuntime: async (cli, input) => ({ runtimeId: crypto.randomUUID(), cli, executablePath: executable.executablePath, executableIdentity: executable.identity, version: "codex-cli 1.0", discoveredFrom: input.discoveredFrom, discoveredShell: input.discoveredShell, verifiedAdapter: { adapterId: "codex-acp", adapterVersion: "2.2.2", acpProtocolVersion: 1, harnessTools: true }, verifiedAt: new Date().toISOString(), status: "verified", diagnostic: null }),
  });
  try {
    const result = await engine.handleDesktopAction("runtimes.scan", {}) as { verified: number; failures: Record<string, string> };
    expect(result.verified).toBe(1);
    expect(result.failures.codex).toBeUndefined();
    // 暂时下线的 CLI 不进入扫描，也不伪装成“未安装”。
    expect(result.failures.kimi).toBeUndefined();
  } finally { engine.shutdown(); }
});

test("显式partial保存缺授权或跨任务时拒绝，不创建Git工作区", async () => {
  const engine = new DesktopExecutionEngine({ deterministicForTest: true });
  await expect(engine.handleDesktopAction("executions.savePartial", { harnessRunId: crypto.randomUUID(), executionId: crypto.randomUUID() })).rejects.toThrow("明确授权");
  engine.shutdown();
});

test("已取消的文件批准动作拒绝且不创建权限Store", async () => {
 const root=await mkdtemp(join(tmpdir(),"wave-flow-no-file-approval-"));roots.push(root);
 const engine=new DesktopExecutionEngine({storeRoot:join(root,"runs"),harnessRoot:join(root,"harness-runs"),deterministicForTest:true});
 try{
  await expect(engine.handleDesktopAction("executions.decideFilePermission",{approved:true})).rejects.toThrow();
  expect(await Bun.file(join(root,"file-permissions")).exists()).toBe(false);
 }finally{engine.shutdown();}
});

test("Desktop 退出逐 Run 隔离失败，不让单个 Journal 错误跳过其他收敛", async () => {
  const source = await Bun.file("src/desktop/desktop-execution-engine.ts").text();
  expect(source).toContain('for(const runtime of this.#runs.values()) {');
  expect(source).toContain('catch (error) { failure ??= error; }');
  expect(source).toContain('try { await this.#executions.cancelForDesktopExit(this.instanceId); }');
  expect(source).toContain('try { await this.#harness.interruptForDesktopExit(); }');
  expect(source).toContain('if (failure !== undefined) throw failure;');
});

/** 回归：串行派发曾让亚秒级的方案检查排在分钟级 CLI 扫描之后无限等待（队头阻塞）。
 * 并发派发下响应按完成顺序写回；shutdown 响应前排空在途请求。 */
test("Engine 请求并发派发：慢 action 不再阻塞后续请求，shutdown 排空在途", async () => {
  let releaseSlow: (() => void) | null = null;
  const slowBarrier = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const engine = {
    status: async () => ({ activeRuns: 0 }),
    cancelForDesktopExit: async () => {},
    handleDesktopAction: async (action: string) => { if (action === "slow") await slowBarrier; return { action }; },
  } as unknown as DesktopExecutionEngine;
  const written: string[] = [];
  let fastSeen: () => void = () => {};
  const fastWritten = new Promise<void>((resolve) => { fastSeen = resolve; });
  const write = (value: unknown) => { const id = (value as { requestId: string }).requestId; written.push(id); if (id === "fast") fastSeen(); };
  async function* lines(): AsyncGenerator<string> {
    yield `${JSON.stringify({ requestId: "slow", method: "engine.action", action: "slow", args: {} })}\n`;
    yield `${JSON.stringify({ requestId: "fast", method: "engine.action", action: "fast", args: {} })}\n`;
    // slow 尚未放行时 fast 必须先完成；旧串行实现会让这里永远等不到。
    await fastWritten;
    releaseSlow!();
    yield `${JSON.stringify({ requestId: "close", method: "engine.shutdown" })}\n`;
  }
  await serveEngineRequests(engine, lines(), write);
  expect(written[0]).toBe("fast");
  expect(new Set(written)).toEqual(new Set(["fast", "slow", "close"]));
});

/** 对抗复现 18.5 分钟挂死档案：主控 prompt 永不返回时，方案检查仍必须立即得到
 * 回答（不能再被挂死回合拖住），且用户停止必须耐久中断并关闭会话，无需杀 App。 */
test("主控 prompt 永久挂起时方案检查仍立即响应，用户停止可耐久中断", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-wedged-prompt-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-wedged-project-")); roots.push(cwd);
  let closed = false;
  const session: HarnessSession = {
    isRunning: true,
    subscribe: () => () => {},
    abort: () => {},
    close: () => { closed = true; },
    // 模型/CLI 无应答：promise 永不 settle，等同于档案中零事件的回合。
    prompt: () => new Promise<string>(() => {}),
  };
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), createHarnessSession: async () => session });
  try {
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as { project: { projectId: string } };
    const started = await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, clientRequestId: crypto.randomUUID(), text: "写一篇小说" }) as { harness: { harnessRunId: string; status: string } };
    expect(started.harness.status).toBe("running");
    // 回合挂死期间：方案检查必须快速给出回答（此处为“主控必须空闲”的确定性拒绝），
    // 而不是排队等待一个永不结束的 prompt。
    const planStartedAt = Date.now();
    await expect(engine.handleDesktopAction("executions.plan", { harnessRunId: started.harness.harnessRunId, revision: 1 })).rejects.toThrow("主控必须空闲");
    expect(Date.now() - planStartedAt).toBeLessThan(2_000);
    // 用户显式停止：耐久事实先落盘，再关闭会话；不依赖 provider 响应 AbortSignal。
    const aborted = await engine.handleDesktopAction("harnesses.abort", { harnessRunId: started.harness.harnessRunId }) as { harness: { status: string } };
    expect(aborted.harness.status).toBe("interrupted");
    expect(closed).toBe(true);
    // 中断后可继续发送新消息（Engine 未被挂死回合占用）。
    await expect(engine.handleDesktopAction("harnesses.send", { harnessRunId: started.harness.harnessRunId, text: "继续" })).resolves.toBeDefined();
  } finally { engine.shutdown(); }
});

/** 回归：父进程消失后 Engine 必须自退；EOF 排空不能被楔死 action 无限拖住。 */
test("EOF 排空有界：在途 action 不返回时 serve 仍按时结束", async () => {
  process.env.WF_ENGINE_DRAIN_BUDGET_MS = "20";
  try {
    const engine = {
      status: async () => ({ activeRuns: 0 }),
      cancelForDesktopExit: async () => {},
      handleDesktopAction: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 200)),
    } as unknown as DesktopExecutionEngine;
    async function* lines(): AsyncGenerator<string> {
      yield `${JSON.stringify({ requestId: "slow", method: "engine.action", action: "slow", args: {} })}\n`;
    }
    const started = Date.now();
    await serveEngineRequests(engine, lines(), () => {});
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally { delete process.env.WF_ENGINE_DRAIN_BUDGET_MS; }
});

/** 设置 action 是 Engine 唯一设置入口：默认感知开启、非法值拒绝，更新成功后关闭空闲主控会话。 */
test("Engine settings action 读写感知模式并在更新后关闭空闲主控会话", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-engine-settings-"))); roots.push(root);
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-engine-settings-project-"))); roots.push(cwd);
  let closed = 0, running = false;
  const session: HarnessSession = {
    get isRunning() { return running; },
    subscribe: () => () => {},
    abort: () => {},
    close: () => { closed += 1; },
    prompt: async () => "回合完成",
  };
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), settingsRoot: root, createHarnessSession: async () => session });
  try {
    // 设置文件缺失时默认感知模式开启；settingsRoot 显式注入，不读写真实用户目录。
    expect(await engine.handleDesktopAction("settings.get", {})).toEqual({ perceptionMode: true });
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as { project: { projectId: string } };
    await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, clientRequestId: crypto.randomUUID(), text: "设置变更前的会话" });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const listed = await engine.handleDesktopAction("harnesses.list", {}) as { harnesses: { status: string }[] };
      if (listed.harnesses.every((harness) => harness.status !== "running")) break;
      await Bun.sleep(10);
    }
    // 会话自报仍有进行中回合时不能关闭，保证进行中的回合保持原模式。
    running = true;
    expect(await engine.handleDesktopAction("settings.update", { perceptionMode: false })).toEqual({ perceptionMode: false });
    expect(closed).toBe(0);
    // 空闲后更新成功即关闭会话，下一回合由 ensureSession 按新设置重建。
    running = false;
    expect(await engine.handleDesktopAction("settings.update", { perceptionMode: true })).toEqual({ perceptionMode: true });
    expect(closed).toBe(1);
    expect(JSON.parse(await Bun.file(join(root, "settings.json")).text())).toEqual({ perceptionMode: true });
    // 非法更新在任何写盘或会话关闭前拒绝。
    await expect(engine.handleDesktopAction("settings.update", { perceptionMode: "off" })).rejects.toMatchObject({ status: 400 });
    await expect(engine.handleDesktopAction("settings.update", { unknown: true })).rejects.toMatchObject({ status: 400 });
    expect(closed).toBe(1);
    expect(await engine.handleDesktopAction("settings.get", {})).toEqual({ perceptionMode: true });
  } finally { engine.shutdown(); }
});

test("Engine action 保存并接管写入项目文件、追加本地来源版本，并支持幂等重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-adopt-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-adopt-project-")); roots.push(cwd);
  const source = `import { phase } from "wave-flow";\nexport const meta = { name: "engine-adopt", description: "Engine 接管", phases: [{ title: "检查" }], inputSchema: { type: "object", properties: {}, additionalProperties: false } };\nexport default async function run(args) { phase("检查"); return {}; }`;
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"),
    harnessRoot: join(root, "harness-runs"),
    createHarnessSession: async (_id, _cwd, _prior, actions) => ({
      isRunning: false,
      subscribe: () => () => {},
      abort: () => {},
      prompt: async () => { await actions.proposeWorkflowRevision(source, "接管目标", "只读检查", undefined, 0); return "草案已提交"; },
    }),
  });
  try {
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as { project: { projectId: string } };
    const started = await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, clientRequestId: crypto.randomUUID(), text: "准备接管" }) as { harness: { harnessRunId: string } };
    const id = started.harness.harnessRunId;
    for (let n = 0; n < 200; n++) {
      const current = await engine.handleDesktopAction("harnesses.get", { harnessRunId: id }) as { harness: { status: string } };
      if (current.harness.status === "idle") break;
      await Bun.sleep(10);
    }
    await engine.handleDesktopAction("harnesses.acceptRevision", { harnessRunId: id, revision: 1 });
    const target = join(cwd, ".wave-flow", "workflows", "engine-adopt.ts");
    const requestId = crypto.randomUUID();
    const saved = await engine.handleDesktopAction("workflows.saveAndAdoptRevision", { harnessRunId: id, revision: 1, path: target, clientRequestId: requestId }) as { harness: { workflowRevisions: Array<{ localOrigin?: { path: string }; sourceFormat?: string }> } };
    expect(saved.harness.workflowRevisions).toHaveLength(2);
    expect(saved.harness.workflowRevisions[1]).toMatchObject({ sourceFormat: "module", localOrigin: { path: await realpath(target) } });
    expect(await Bun.file(target).text()).toBe(source);
    const retry = await engine.handleDesktopAction("workflows.saveAndAdoptRevision", { harnessRunId: id, revision: 1, path: target, clientRequestId: requestId }) as { harness: { workflowRevisions: unknown[] } };
    expect(retry.harness.workflowRevisions).toHaveLength(2);
  } finally { engine.shutdown(); }
}, 30_000);

test("Engine 确认生成模块时接受用户输入并按冻结 inputSchema 校验", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-input-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-input-project-")); roots.push(cwd);
  const source = `import { phase } from "wave-flow";\nexport const meta = { name: "engine-input", description: "输入验证", phases: [{ title: "检查" }], inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false } };\nexport default async function run(args) { phase("检查"); return { note: args.note }; }`;
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"),
    harnessRoot: join(root, "harness-runs"),
    deterministicForTest: true,
    createHarnessSession: async (_id, _cwd, _prior, actions) => ({
      isRunning: false,
      subscribe: () => () => {},
      abort: () => {},
      prompt: async () => { await actions.proposeWorkflowRevision(source, "输入目标", "只读检查", undefined, 0); return "草案已提交"; },
    }),
  });
  try {
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as { project: { projectId: string } };
    const started = await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, clientRequestId: crypto.randomUUID(), text: "准备输入" }) as { harness: { harnessRunId: string } };
    const id = started.harness.harnessRunId;
    for (let n = 0; n < 200; n++) {
      const current = await engine.handleDesktopAction("harnesses.get", { harnessRunId: id }) as { harness: { status: string } };
      if (current.harness.status === "idle") break;
      await Bun.sleep(10);
    }
    await engine.handleDesktopAction("harnesses.acceptRevision", { harnessRunId: id, revision: 1 });
    // 缺少必填 note 时拒绝，不创建 Execution。
    await expect(engine.handleDesktopAction("executions.confirm", { harnessRunId: id, revision: 1, input: {}, clientRequestId: crypto.randomUUID() })).rejects.toThrow("参数无效");
    const confirmed = await engine.handleDesktopAction("executions.confirm", { harnessRunId: id, revision: 1, input: { note: "来自用户" }, clientRequestId: crypto.randomUUID() }) as { execution: { executionId: string } };
    let detail: { status: string; summary: Record<string, unknown> | null } = { status: "running", summary: null };
    for (let n = 0; n < 200; n++) {
      const response = await engine.handleDesktopAction("executions.get", { harnessRunId: id, executionId: confirmed.execution.executionId }) as { execution: { status: string; summary: Record<string, unknown> | null } };
      detail = response.execution;
      if (detail.status !== "running") break;
      await Bun.sleep(10);
    }
    expect(detail).toMatchObject({ status: "completed", summary: { note: "来自用户" } });
  } finally { engine.shutdown(); }
}, 30_000);

test("Engine 接受脚本模式写类配置，只把 workspaces 交给执行器", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-script-write-")); roots.push(root);
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-engine-script-write-project-"))); roots.push(cwd);
  const source = `import { agent, phase } from "wave-flow";\nexport const meta = { name: "engine-script-write", description: "脚本写", phases: [{ title: "写" }], inputSchema: { type: "object", properties: {}, additionalProperties: false } };\nexport default async function run(args) { phase("写"); return agent("写文件", { id: "writer", cli: "codex", sandbox: "workspace-write" }); }`;
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"),
    harnessRoot: join(root, "harness-runs"),
    deterministicForTest: true,
    createHarnessSession: async (_id, _cwd, _prior, actions) => ({
      isRunning: false,
      subscribe: () => () => {},
      abort: () => {},
      prompt: async () => { await actions.proposeWorkflowRevision(source, "写目标", "只写", undefined, 0); return "草案已提交"; },
    }),
  });
  try {
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as { project: { projectId: string } };
    const started = await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, clientRequestId: crypto.randomUUID(), text: "准备写" }) as { harness: { harnessRunId: string } };
    const id = started.harness.harnessRunId;
    for (let n = 0; n < 200; n++) {
      const current = await engine.handleDesktopAction("harnesses.get", { harnessRunId: id }) as { harness: { status: string } };
      if (current.harness.status === "idle") break;
      await Bun.sleep(10);
    }
    await engine.handleDesktopAction("harnesses.acceptRevision", { harnessRunId: id, revision: 1 });
    const workspaces = { version: 3 as const, authorization: { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: cwd, baseCommit: "a".repeat(40), excludeExistingDirty: false, nodes: [{ nodeId: "writer" }] }, workspaceId: crypto.randomUUID() };
    const config = { version: 1 as const, assignmentMode: "script" as const, createdAt: new Date().toISOString(), workspaces };
    const confirmed = await engine.handleDesktopAction("executions.confirm", { harnessRunId: id, revision: 1, config, input: {}, clientRequestId: crypto.randomUUID() }) as { execution: { executionId: string; config?: { assignmentMode?: string } } };
    expect(confirmed.execution.config).toMatchObject({ assignmentMode: "script", workspaces });
    let detail: { status: string } = { status: "running" };
    for (let n = 0; n < 200; n++) {
      const response = await engine.handleDesktopAction("executions.get", { harnessRunId: id, executionId: confirmed.execution.executionId }) as { execution: { status: string } };
      detail = response.execution;
      if (detail.status !== "running") break;
      await Bun.sleep(10);
    }
    expect(detail.status).toBe("completed");
  } finally { engine.shutdown(); }
}, 30_000);

test("Engine 保存接管仅在系统面板确认替换时覆盖已有文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-replace-")); roots.push(root);
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-engine-replace-project-")); roots.push(cwd);
  const source = `import { phase } from "wave-flow";\nexport const meta = { name: "engine-replace", description: "替换接管", phases: [{ title: "检查" }], inputSchema: { type: "object", properties: {}, additionalProperties: false } };\nexport default async function run(args) { phase("检查"); return {}; }`;
  const engine = new DesktopExecutionEngine({
    storeRoot: join(root, "runs"),
    harnessRoot: join(root, "harness-runs"),
    createHarnessSession: async (_id, _cwd, _prior, actions) => ({
      isRunning: false,
      subscribe: () => () => {},
      abort: () => {},
      prompt: async () => { await actions.proposeWorkflowRevision(source, "替换目标", "只读检查", undefined, 0); return "草案已提交"; },
    }),
  });
  try {
    const project = await engine.handleDesktopAction("projects.create", { cwd }) as { project: { projectId: string } };
    const started = await engine.handleDesktopAction("harnesses.startConversation", { projectId: project.project.projectId, clientRequestId: crypto.randomUUID(), text: "准备替换接管" }) as { harness: { harnessRunId: string } };
    const id = started.harness.harnessRunId;
    for (let n = 0; n < 200; n++) {
      const current = await engine.handleDesktopAction("harnesses.get", { harnessRunId: id }) as { harness: { status: string } };
      if (current.harness.status === "idle") break;
      await Bun.sleep(10);
    }
    await engine.handleDesktopAction("harnesses.acceptRevision", { harnessRunId: id, revision: 1 });
    const target = join(cwd, ".wave-flow", "workflows", "engine-replace.ts");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "旧内容", "utf8");
    await expect(engine.handleDesktopAction("workflows.saveAndAdoptRevision", { harnessRunId: id, revision: 1, path: target, clientRequestId: crypto.randomUUID() })).rejects.toThrow("已存在");
    await expect(engine.handleDesktopAction("workflows.saveAndAdoptRevision", { harnessRunId: id, revision: 1, path: target, clientRequestId: crypto.randomUUID(), replace: "yes" })).rejects.toThrow("布尔");
    const saved = await engine.handleDesktopAction("workflows.saveAndAdoptRevision", { harnessRunId: id, revision: 1, path: target, clientRequestId: crypto.randomUUID(), replace: true }) as { harness: { workflowRevisions: Array<{ localOrigin?: { path: string; sourceHash: string } }> } };
    expect(saved.harness.workflowRevisions).toHaveLength(2);
    expect(saved.harness.workflowRevisions[1]?.localOrigin?.path).toBe(await realpath(target));
    expect(await Bun.file(target).text()).toBe(source);
    // UI 在保存成功后立即用同一文件预检：action 序列必须可用并标记为保存本地来源。
    const adopted = saved.harness.workflowRevisions[1]!;
    await expect(engine.handleDesktopAction("workflows.reviseLocalTask", { harnessRunId: id, baseRevision: 2, sourceHash: adopted.localOrigin!.sourceHash, input: {}, clientRequestId: crypto.randomUUID(), updateReason: "bogus" })).rejects.toThrow("更新原因");
    const prepared = await engine.handleDesktopAction("workflows.reviseLocalTask", { harnessRunId: id, baseRevision: 2, sourceHash: adopted.localOrigin!.sourceHash, input: {}, clientRequestId: crypto.randomUUID(), updateReason: "save-local" }) as { harness: { workflowRevisions: Array<{ revision: number; parentRevision: number | null; updateReason?: string; acceptedAt: string | null }> } };
    expect(prepared.harness.workflowRevisions).toHaveLength(3);
    expect(prepared.harness.workflowRevisions[2]).toMatchObject({ revision: 3, parentRevision: 2, updateReason: "save-local", acceptedAt: null });
  } finally { engine.shutdown(); }
}, 30_000);
