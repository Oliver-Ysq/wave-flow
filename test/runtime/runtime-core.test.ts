import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RunRuntime } from "../../src/runtime/run-runtime";
import { AcpWorkerExecutor, type AcpWorkerSession } from "../../src/runtime/acp-worker-executor";
import type { AgentNodeExecutor } from "../../src/runtime/run-types";
import type { JsonObject } from "../../src/shared/json";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import { agent, phase } from "../../src/workflow/author-api";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const workflow: WorkflowModule<JsonObject, unknown> = { meta: { name: "runtime-core", description: "Runtime core.", phases: [{ title: "run" }] }, default: async () => { phase("run"); return agent("work", { id: "worker", cli: "codex" }); } };
async function create(executor: AgentNodeExecutor): Promise<RunRuntime> { const cwd = await mkdtemp(join(tmpdir(), "wave-flow-runtime-core-")); directories.push(cwd); const workflowPath = join(cwd, "workflow.ts"); await writeFile(workflowPath, "workflow", "utf8"); return RunRuntime.create({ workflow, input: {}, workflowSource: "workflow", clientRequestId: crypto.randomUUID(), workflowProjectCwd: cwd, workflowPath, storeRoot: runsRoot(join(cwd, "store")), executor }); }

describe("RunRuntime ACP-neutral core", () => {
  test("并行resume在首个重跑调用处立即关闭旧结果前缀，不复用后续completed节点", async () => {
    const concurrent: WorkflowModule<JsonObject, unknown> = { meta: workflow.meta, default: async () => { phase("run"); return Promise.all([agent("a", { id: "a", cli: "codex" }), agent("b", { id: "b", cli: "kimi" })]); } };
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
    const initial = await create({ execute: async node => { if (node.id === "a") { await firstPending; return null; } return { version: "old", id: node.id }; } });
    const apply = initial.state.apply.bind(initial.state);
    const applied = spyOn(initial.state, "apply").mockImplementation(event => { apply(event); if (event.type === "agent.completed" && event.nodeId === "b") releaseFirst(); });
    try { await initial.run(concurrent).catch(() => undefined); } finally { applied.mockRestore(); }
    expect(initial.snapshot().phases[0].agents.map(node => node.status)).toEqual(["interrupted", "completed"]);
    const executed: string[] = [];
    const resumed = await RunRuntime.resume(initial.snapshot().id, { execute: async node => { executed.push(node.id); return { version: "new", id: node.id }; } }, join(initial.journal.directory, ".."));
    await expect(resumed.run(concurrent)).resolves.toEqual([{ version: "new", id: "a" }, { version: "new", id: "b" }]);
    expect(executed.sort()).toEqual(["a", "b"]);
    const { events } = await RunJournal.open(initial.snapshot().id, join(initial.journal.directory, ".."));
    const restarted = events.filter(event => event.type === "agent.restarted");
    expect(restarted.map(event => [event.nodeId, event.invalidatedByPriorRestart])).toEqual([["a", false], ["b", true]]);
    expect(events.filter(event => event.type === "execution-attempt.started" && event.executionAttemptId === 2)).toHaveLength(1);
    const previous = resumed.state.listPhaseVisits(1).items.flatMap(visit=>visit.batches.flatMap(batch=>batch.agents));
    expect(previous.map(node=>[node.id,node.status,node.result])).toEqual([["a","interrupted",null],["b","completed",{version:"old",id:"b"}]]);
    expect(resumed.state.listPhaseVisits(2).items.flatMap(visit=>visit.batches.flatMap(batch=>batch.agents)).map(node=>node.result)).toEqual([{version:"new",id:"a"},{version:"new",id:"b"}]);
  });
  test("并行resume只初始化一个attempt，两个分支均启动而不丢下游", async () => {
    const concurrent: WorkflowModule<JsonObject, unknown> = { meta: workflow.meta, default: async () => { phase("run"); return Promise.all([agent("a",{id:"a",cli:"codex"}),agent("b",{id:"b",cli:"kimi"})]); } };
    let settled!: () => void; let count = 0;
    const initialNodes = new Promise<void>(resolve => { settled = resolve; });
    const initial = await create({execute:async()=>{if(++count===2)settled();return null;}});
    await initial.run(concurrent).catch(()=>undefined); await initialNodes;
    // 等两个失败节点都完成耐久收敛，避免把活跃旧节点当可resume。
    const deadline = Date.now()+2_000;
    while(initial.snapshot().phases[0].agents.some(node=>node.status!=="interrupted")){if(Date.now()>deadline)throw new Error("初始节点未收敛");await Bun.sleep(1);}
    const executed: string[] = [];
    const resumed = await RunRuntime.resume(initial.snapshot().id,{execute:async node=>{executed.push(node.id);return {id:node.id};}},join(initial.journal.directory,".."));
    // 先await以保留Runtime原始诊断，避免resolves matcher掩盖并行恢复错误。
    expect(await resumed.run(concurrent)).toEqual([{id:"a"},{id:"b"}]);
    expect(executed.sort()).toEqual(["a","b"]);
    const {events} = await RunJournal.open(initial.snapshot().id,join(initial.journal.directory,".."));
    expect(events.filter(event=>event.type==="execution-attempt.started"&&event.executionAttemptId===2)).toHaveLength(1);
    expect(events.filter(event=>event.type==="phase.entered"&&event.executionAttemptId===2)).toHaveLength(1);
  });
  for (const action of ["pause", "recover"] as const) for (const cleanupPending of [false, true]) test(`多Worker${action}部分成功后失败不残留非终态会话，cleanupPending=${cleanupPending}`, async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const failures = new Map<string, (error: Error) => void>();
    const controlled: string[] = [], stopped: string[] = [];
    const concurrent: WorkflowModule<JsonObject, unknown> = { meta: workflow.meta, default: async () => { phase("run"); return Promise.all([agent("只读a", {id:"a",cli:"codex"}),agent("只读b", {id:"b",cli:"codex"})]); } };
    const runtime = await create({
      execute: async node => { const executing = new Promise<JsonObject>((_,reject)=>failures.set(node.id,reject)); if(failures.size===2)entered(); return executing; },
      pause: async node => { if(action==="pause"){controlled.push(node.id);if(controlled.length===2)throw new Error("第二个暂停失败");} },
      recover: async node => { controlled.push(node.id);if(controlled.length===2)throw new Error("第二个恢复失败");return {}; },
      stop: async node => { stopped.push(node.id);if(cleanupPending)await new Promise<void>(()=>{});else failures.get(node.id)!(new Error("清理失败控制会话")); },
    });
    const running=runtime.run(concurrent).catch(()=>undefined);await started;
    if(action==="recover")await runtime.pause();
    const outcome = runtime[action]().then(()=>"unexpected",error=>String(error));
    expect(await Promise.race([outcome,Bun.sleep(1_000).then(()=>"pending")])).toContain("第二个");
    expect(runtime.snapshot().status).toBe("interrupted");
    expect(runtime.snapshot().phases.flatMap(phase=>phase.agents).every(node=>node.status==="interrupted")).toBe(true);
    expect(stopped).toHaveLength(2);
    await RunJournal.open(runtime.snapshot().id,join(runtime.journal.directory,".."));
    if(cleanupPending)for(const fail of failures.values())fail(new Error("测试释放原执行"));
    await running;
  });
  test("首个Worker停止失败仍停止后续Worker，所有节点终态先于Run封存", async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const failures = new Map<string, (error: Error) => void>();
    const stopped: string[] = [];
    const concurrent: WorkflowModule<JsonObject, unknown> = {
      meta: workflow.meta,
      default: async () => {
        phase("run");
        return Promise.all([agent("只读a", { id: "a", cli: "codex" }), agent("只读b", { id: "b", cli: "codex" })]);
      },
    };
    const runtime = await create({
      execute: async node => {
        const executing = new Promise<JsonObject>((_, reject) => { failures.set(node.id, reject); });
        if (failures.size === 2) entered();
        return executing;
      },
      stop: async node => {
        stopped.push(node.id);
        setTimeout(() => failures.get(node.id)!(new Error("执行已结束")), 0);
        if (node.id === stopped[0]) throw new Error("首个取消失败");
      },
    });
    const running = runtime.run(concurrent).catch(() => undefined);
    await started;
    await expect(runtime.stop()).rejects.toThrow("首个取消失败");
    await running;
    expect(stopped).toHaveLength(2);
    const nodes = runtime.snapshot().phases.flatMap(phase => phase.agents);
    expect(nodes.find(node => node.id === stopped[0])?.status).toBe("interrupted");
    expect(nodes.find(node => node.id === stopped[1])?.status).toBe("cancelled");
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    const terminal = reopened.events.findIndex(event => event.type === "run.status" && event.status === "interrupted");
    expect(reopened.events.slice(0, terminal).filter(event => event.type === "agent.status" && (event.status === "cancelled" || event.status === "interrupted"))).toHaveLength(2);
  });
  test("执行器停止失败仍先收敛节点，Run不留下running残留", async () => {
    let entered!: () => void, fail!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const executing = new Promise<JsonObject>((_, reject) => { fail = reject; });
    const runtime = await create({ execute: async () => { entered(); return executing; }, stop: async () => { setTimeout(() => fail(new Error("取消传输失败")), 0); throw new Error("取消传输失败"); } });
    const running = runtime.run(workflow).catch(() => undefined);
    await started;
    await expect(runtime.stop()).rejects.toThrow("取消传输失败");
    await running;
    expect(runtime.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ status: "interrupted" }] }] });
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    const node = reopened.events.findIndex((event) => event.type === "agent.status" && event.status === "interrupted");
    const run = reopened.events.findIndex((event) => event.type === "run.status" && event.status === "interrupted");
    expect(node).toBeGreaterThanOrEqual(0); expect(run).toBeGreaterThan(node);
  });
  for (const failure of ["end_turn", "transport"] as const) test(`暂停期间原turn${failure}且cancel不返回时不悬挂或伪造paused`, async () => {
    let entered!: () => void, cancelling!: () => void;
    let finish!: (turn: { stopReason: string }) => void, fail!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const cancelStarted = new Promise<void>((resolve) => { cancelling = resolve; });
    let prompts = 0, closed = 0;
    const session: AcpWorkerSession = {
      binding: null, async initialize() {},
      async createSession() { return { launcherId: "test-acp", sessionId: "native", capabilities: {} }; },
      async prompt() { prompts++; const turn = new Promise<{ stopReason: string }>((resolve, reject) => { finish = resolve; fail = reject; }); entered(); return turn; },
      async cancel() { cancelling(); await new Promise<void>(() => {}); },
      close() { closed++; },
    };
    const executor = new AcpWorkerExecutor({ id: "test-acp", command: "fake", args: [] }, () => session);
    const runtime = await create(executor);
    executor.bindControl(runtime.createControlServer());
    const running = runtime.run(workflow).then(() => "unexpected", () => "rejected");
    await started;
    const pausing = runtime.pause().then(() => "unexpected", () => "rejected");
    await cancelStarted;
    if (failure === "end_turn") finish({ stopReason: "end_turn" });
    else fail(new Error("transport failed"));
    expect(await Promise.race([Promise.all([running, pausing]), Bun.sleep(2_000).then(() => "pending")])).toEqual(["rejected", "rejected"]);
    expect(runtime.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ status: "interrupted" }] }] });
    expect(prompts).toBe(1); expect(closed).toBe(1);
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    expect(reopened.events.some((event) => (event.type === "agent.status" || event.type === "run.status") && event.status === "paused")).toBe(false);
    expect([...reopened.events].reverse().find((event) => event.type === "run.status")).toMatchObject({ status: "interrupted" });
  });
  for (const action of ["stop", "exit"] as const) test(`真实Executor暂停未获确认时${action}可收敛且Journal可重开`, async () => {
    let entered!: () => void;
    let cancelling!: () => void;
    let finish!: (turn: { stopReason: string }) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const cancelStarted = new Promise<void>((resolve) => { cancelling = resolve; });
    let prompts = 0, cancels = 0, closed = 0;
    const session: AcpWorkerSession = {
      binding: null,
      async initialize() {},
      async createSession() { return { launcherId: "test-acp", sessionId: "native", capabilities: {} }; },
      async prompt() { prompts++; const turn = new Promise<{ stopReason: string }>((resolve) => { finish = resolve; }); entered(); return turn; },
      async cancel() { cancels++; cancelling(); /* 请求成功但原turn尚未确认cancelled。 */ },
      close() { closed++; },
    };
    const executor = new AcpWorkerExecutor({ id: "test-acp", command: "fake", args: [] }, () => session);
    const runtime = await create(executor);
    executor.bindControl(runtime.createControlServer());
    const running = runtime.run(workflow).catch(() => undefined);
    await started;
    const pausing = runtime.pause().then(() => "unexpected", () => "rejected");
    await cancelStarted;
    const stopping = action === "stop" ? runtime.stop() : runtime.cancelForDesktopExit("test-engine");
    const deadline = Bun.sleep(2_000).then(() => "pending" as const);
    const outcome = await Promise.race([Promise.all([pausing, stopping, running]), deadline]);
    expect(outcome).not.toBe("pending");
    expect(runtime.snapshot()).toMatchObject({ status: "cancelled", phases: [{ agents: [{ status: "cancelled" }] }] });
    finish({ stopReason: "end_turn" });
    await Bun.sleep(1);
    expect(prompts).toBe(1);
    expect(closed).toBe(1);
    expect(cancels).toBeGreaterThanOrEqual(1);
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    const cancelled = reopened.events.findIndex((event) => event.type === "agent.status" && event.status === "cancelled");
    expect(cancelled).toBeGreaterThanOrEqual(0);
    expect(reopened.events.slice(cancelled).some((event) => event.type === "agent.status" && event.status !== "cancelled")).toBe(false);
    expect([...reopened.events].reverse().find((event) => event.type === "run.status")).toMatchObject({ status: "cancelled" });
  });
  test("确定性结果只在节点完成后封存 Run", async () => {
    const runtime = await create({ execute: async () => ({ ok: true }) });
    await expect(runtime.run(workflow)).resolves.toEqual({ ok: true });
    expect(runtime.snapshot()).toMatchObject({ status: "completed", phases: [{ agents: [{ id: "worker", status: "completed", result: { ok: true } }] }] });
  });
  test("不可验证执行结果收敛为 interrupted 而不是完成", async () => {
    const runtime = await create({ execute: async () => null });
    await expect(runtime.run(workflow)).rejects.toThrow("无法验证节点已完成");
    expect(runtime.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ status: "interrupted" }] }] });
  });
  test("Desktop 退出先耐久 cancelled，不等待执行器停止确认", async () => {
    let started!: () => void;
    let entered!: () => void;
    const enteredExecution = new Promise<void>((resolve) => { entered = resolve; });
    const executing = new Promise<JsonObject>((resolve) => { started = () => resolve({ late: true }); });
    const runtime = await create({ execute: async () => { entered(); return executing; }, stop: async () => new Promise<void>(() => {}) });
    const running = runtime.run(workflow).catch(() => undefined);
    await enteredExecution;
    const snapshot = await runtime.cancelForDesktopExit("test-engine");
    expect(snapshot).toMatchObject({ status: "cancelled", phases: [{ agents: [{ id: "worker", status: "cancelled" }] }] });
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    expect(reopened.events).toContainEqual(expect.objectContaining({ type: "agent.status", status: "cancelled", diagnostic: "退出 Wave Flow 时停止。 " }));
    expect(reopened.events).toContainEqual(expect.objectContaining({ type: "run.status", status: "cancelled", diagnostic: "退出 Wave Flow 时停止。 " }));
    started(); await running;
  });
  test("desktop.exit_requested 先于所有 cancelled 事实耐久", async () => {
    let entered!: () => void;
    const enteredExecution = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = await create({ execute: async () => { entered(); return new Promise<JsonObject>(() => {}); }, stop: async () => {} });
    void runtime.run(workflow).catch(() => undefined);
    await enteredExecution;
    await runtime.cancelForDesktopExit("exit-engine-id");
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    const exitIndex = reopened.events.findIndex((event) => event.type === "desktop.exit_requested");
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(reopened.events[exitIndex]).toMatchObject({ engineInstanceId: "exit-engine-id", nodeId: null, agentSessionId: null });
    const firstCancelled = reopened.events.findIndex((event) => (event.type === "agent.status" || event.type === "run.status") && event.status === "cancelled");
    expect(exitIndex).toBeLessThan(firstCancelled);
  });
  test("blocked 节点在 Desktop 退出时收敛为 cancelled，且 Journal 可重开", async () => {
    let entered!: () => void;
    const enteredExecution = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = await create({ execute: async () => { entered(); return new Promise<JsonObject>(() => {}); }, stop: async () => {} });
    void runtime.run(workflow).catch(() => undefined);
    await enteredExecution;
    const agentSessionId = runtime.snapshot().phases[0].agents[0].agentSessionId!;
    const control = runtime.createControlServer();
    control.register({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, capability: "cap-1" });
    await control.recordSession({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, delivery: "acp", acp: { launcherId: "test", sessionId: "s", capabilities: {} } });
    // 等待真正的 durable blocked 投影；固定 10ms 在全量测试的文件系统负载下不可靠。
    let notifyBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { notifyBlocked = resolve; });
    const apply = runtime.state.apply.bind(runtime.state);
    const applied = spyOn(runtime.state, "apply").mockImplementation((event) => {
      apply(event);
      if (event.type === "block.created") notifyBlocked();
    });
    const blockFailure = control.block({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, capability: "cap-1", blockRequestId: crypto.randomUUID(), needHelp: "需要确认" }).then(() => null, (error: unknown) => error);
    try { await blocked; } finally { applied.mockRestore(); }
    expect(await Promise.race([blockFailure, Promise.resolve("pending")])).toBe("pending");
    expect(runtime.snapshot().phases[0].agents[0].status).toBe("blocked");
    const snapshot = await runtime.cancelForDesktopExit("test-engine");
    expect(snapshot).toMatchObject({ status: "cancelled", phases: [{ agents: [{ id: "worker", status: "cancelled" }] }] });
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    expect(reopened.events).toContainEqual(expect.objectContaining({ type: "agent.status", status: "cancelled", diagnostic: "退出 Wave Flow 时停止。 " }));
  });
  test("退出与 pause/recover 并发不产生 cancelled 之后的非法状态事件", async () => {
    let entered!: () => void;
    const enteredExecution = new Promise<void>((resolve) => { entered = resolve; });
    let releasePause!: () => void;
    const pauseGate = new Promise<void>((resolve) => { releasePause = resolve; });
    const runtime = await create({
      execute: async () => { entered(); return new Promise<JsonObject>(() => {}); },
      pause: async () => { await pauseGate; },
      stop: async () => {},
    });
    void runtime.run(workflow).catch(() => undefined);
    await enteredExecution;
    const pausing = runtime.pause().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const exiting = runtime.cancelForDesktopExit("test-engine");
    // 在退出收敛期间释放 pause：pause 的 paused 写入必须先于 cancelled 或被 abort 丢弃，
    // 绝不能在 cancelled 之后落盘，否则 Journal 重放永久失败。
    releasePause();
    await Promise.all([pausing, exiting]);
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    const cancelledIndex = reopened.events.findIndex((event) => (event.type === "agent.status" || event.type === "run.status") && event.status === "cancelled");
    expect(cancelledIndex).toBeGreaterThanOrEqual(0);
    expect(reopened.events.slice(cancelledIndex).some((event) => event.type === "agent.status" && (event.status === "paused" || event.status === "pausing" || event.status === "recovering"))).toBe(false);
    const lastRunStatus = [...reopened.events].reverse().find((event) => event.type === "run.status");
    expect(lastRunStatus).toMatchObject({ status: "cancelled" });
  });
  test("因 Desktop 退出而 cancelled 的节点可显式恢复为新 attempt", async () => {
    let entered!: () => void;
    const enteredExecution = new Promise<void>((resolve) => { entered = resolve; });
    const initial = await create({ execute: async () => { entered(); return new Promise<JsonObject>(() => {}); }, stop: async () => {} });
    void initial.run(workflow).catch(() => undefined);
    await enteredExecution;
    await initial.cancelForDesktopExit("test-engine");
    const resumed = await RunRuntime.resume(initial.snapshot().id, { execute: async () => ({ resumed: true }) }, join(initial.journal.directory, ".."));
    await expect(resumed.run(workflow)).resolves.toEqual({ resumed: true });
    expect(resumed.snapshot()).toMatchObject({ status: "completed", currentExecutionAttemptId: 2, phases: [{ agents: [{ status: "completed", result: { resumed: true } }] }] });
  });
  test("显式 resume 为 interrupted 节点创建新 attempt", async () => {
    const initial = await create({ execute: async () => null });
    await initial.run(workflow).catch(() => undefined);
    const resumed = await RunRuntime.resume(initial.snapshot().id, { execute: async () => ({ resumed: true }) }, join(initial.journal.directory, ".."));
    await expect(resumed.run(workflow)).resolves.toEqual({ resumed: true });
    expect(resumed.snapshot()).toMatchObject({ status: "completed", currentExecutionAttemptId: 2, phases: [{ agents: [{ status: "completed", result: { resumed: true } }] }] });
    const prior=resumed.state.listPhaseVisits(1).items[0]!.batches[0]!.agents[0]!;
    expect(prior.status).toBe("interrupted");expect(prior.result).toBeNull();
    const reopened=await RunRuntime.open(initial.snapshot().id,{execute:async()=>{throw new Error("只读查询不得执行");}},join(initial.journal.directory,".."));
    expect(reopened.state.listPhaseVisits(1).items[0]!.batches[0]!.agents[0]!.status).toBe("interrupted");
    expect(reopened.state.listPhaseVisits(2).items[0]!.batches[0]!.agents[0]!.result).toEqual({resumed:true});
  });
  test("显式 resume 拒绝调用指纹不匹配的 Workflow，且不写入任何新事实", async () => {
    const initial = await create({ execute: async () => null });
    await initial.run(workflow).catch(() => undefined);
    const changed: WorkflowModule<JsonObject, unknown> = { meta: workflow.meta, default: async () => { phase("run"); return agent("改动后的任务", { id: "worker", cli: "codex" }); } };
    const resumed = await RunRuntime.resume(initial.snapshot().id, { execute: async () => ({ resumed: true }) }, join(initial.journal.directory, ".."));
    await expect(resumed.run(changed)).rejects.toThrow("与 Journal 节点不匹配");
    expect(resumed.snapshot().status).toBe("interrupted");
    const reopened = await RunJournal.open(initial.snapshot().id, join(initial.journal.directory, ".."));
    expect(reopened.events.some((event) => event.type === "agent.restarted")).toBe(false);
    expect(reopened.events.some((event) => event.type === "execution-attempt.started" && event.executionAttemptId === 2)).toBe(false);
  });
  test("显式 resume 复用 completed 前缀，只从首个 interrupted 节点重跑", async () => {
    const twoNodes: WorkflowModule<JsonObject, unknown> = {
      meta: { name: "runtime-core", description: "Runtime core.", phases: [{ title: "run" }] },
      default: async () => { phase("run"); const first = await agent("first", { id: "a", cli: "codex" }); const second = await agent("second", { id: "b", cli: "codex" }); return { first, second }; },
    };
    const executed: string[] = [];
    const initial = await create({ execute: async (node) => { executed.push(node.id); return node.id === "a" ? { ok: "a" } : null; } });
    await initial.run(twoNodes).catch(() => undefined);
    expect(initial.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ id: "a", status: "completed" }, { id: "b", status: "interrupted" }] }] });
    executed.length = 0;
    const resumed = await RunRuntime.resume(initial.snapshot().id, { execute: async (node) => { executed.push(node.id); return { ok: node.id }; } }, join(initial.journal.directory, ".."));
    await expect(resumed.run(twoNodes)).resolves.toEqual({ first: { ok: "a" }, second: { ok: "b" } });
    expect(executed).toEqual(["b"]);
    // 当前尝试视图只含本轮重跑节点；前缀节点 "a" 的结果直接来自 Journal 复用。
    expect(resumed.snapshot()).toMatchObject({ status: "completed", currentExecutionAttemptId: 2, phases: [{ agents: [{ id: "b", result: { ok: "b" } }] }] });
  });
  test("Worker 在 blocked 等待期间死亡：执行器失败必须收敛节点与 Run，不留非终态残留", async () => {
    let entered!: () => void;
    let fail!: (error: Error) => void;
    const enteredExecution = new Promise<void>((resolve) => { entered = resolve; });
    const execution = new Promise<JsonObject>((_, reject) => { fail = reject; });
    const runtime = await create({ execute: async () => { entered(); return execution; } });
    const running = runtime.run(workflow).then(() => null, (error: unknown) => error as Error);
    await enteredExecution;
    const agentSessionId = runtime.snapshot().phases[0].agents[0].agentSessionId!;
    const control = runtime.createControlServer();
    control.register({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, capability: "cap-1" });
    await control.recordSession({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, delivery: "acp", acp: { launcherId: "test", sessionId: "s", capabilities: {} } });
    // Worker 请求人工确认后未调用 continue/complete 就以 end_turn 结束回合。
    void control.block({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, capability: "cap-1", blockRequestId: crypto.randomUUID(), needHelp: "需要确认" }).then(() => null, () => null);
    const deadline = Date.now() + 5_000;
    while (runtime.snapshot().phases[0].agents[0].status !== "blocked") {
      if (Date.now() > deadline) throw new Error("等待节点 blocked 超时。 ");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fail(new Error("ACP Worker turn 已结束（end_turn），但未收到 wave-flow complete。"));
    const runError = await running;
    expect(runError).toBeInstanceOf(Error);
    expect(runError!.message).toContain("end_turn");
    expect(runtime.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ id: "worker", status: "interrupted", diagnostic: expect.stringContaining("end_turn") }] }] });
    // 节点收敛必须先于 Run 终态落盘，Journal 重放后投影一致。
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    const nodeIndex = reopened.events.findIndex((event) => event.type === "agent.status" && event.status === "interrupted");
    const runIndex = reopened.events.findIndex((event) => event.type === "run.status" && event.status === "interrupted");
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(nodeIndex);
  });
  test("resume 的新 attempt 再次失败：Run 与节点一起收敛为 interrupted，且仍可再次 resume", async () => {
    const initial = await create({ execute: async () => null });
    await initial.run(workflow).catch(() => undefined);
    const root = join(initial.journal.directory, "..");
    const failed = await RunRuntime.resume(initial.snapshot().id, { execute: async () => { throw new Error("Worker 再次死亡"); } }, root);
    await failed.run(workflow).catch(() => undefined);
    expect(failed.snapshot()).toMatchObject({ status: "interrupted", diagnostic: "Worker 再次死亡", phases: [{ agents: [{ status: "interrupted" }] }] });
    const resumed = await RunRuntime.resume(initial.snapshot().id, { execute: async () => ({ ok: true }) }, root);
    await expect(resumed.run(workflow)).resolves.toEqual({ ok: true });
    expect(resumed.snapshot()).toMatchObject({ status: "completed", currentExecutionAttemptId: 3 });
  });
  test("complete 磁盘窗口与 Desktop 退出并发：complete 持锁完成，退出跳过该节点的 cancelled", async () => {
    let entered!: () => void;
    const enteredExecution = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = await create({ execute: async () => { entered(); return new Promise<JsonObject>(() => {}); }, stop: async () => {} });
    void runtime.run(workflow).catch(() => undefined);
    await enteredExecution;
    const agentSessionId = runtime.snapshot().phases[0].agents[0].agentSessionId!;
    const control = runtime.createControlServer();
    control.register({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, capability: "cap-1" });
    await control.recordSession({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, delivery: "acp", acp: { launcherId: "test", sessionId: "s", capabilities: {} } });
    // 把 complete 卡在结果文件写入窗口内；此时退出收敛必须等待同一互斥区，
    // 不能把 cancelled 插进 complete 的校验与落盘之间。
    let writeStarted!: () => void;
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => { writeStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const originalWriteResult = runtime.journal.writeResult.bind(runtime.journal);
    const spy = spyOn(runtime.journal, "writeResult").mockImplementation(async (...args: Parameters<RunJournal["writeResult"]>) => { writeStarted(); await writeGate; return originalWriteResult(...args); });
    const completing = control.complete({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, capability: "cap-1", summary: "done", result: { ok: true } }).then(() => "completed", (error: unknown) => error as Error);
    await writing;
    const exiting = runtime.cancelForDesktopExit("test-engine");
    releaseWrite();
    await exiting;
    spy.mockRestore();
    expect(await completing).toBe("completed");
    expect(runtime.snapshot()).toMatchObject({ status: "cancelled", phases: [{ agents: [{ id: "worker", status: "completed", result: { ok: true } }] }] });
    // Journal 必须可重开重放：没有 cancelled 落在 completed 之后污染档案。
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    expect(reopened.events).toContainEqual(expect.objectContaining({ type: "agent.completed", nodeId: "worker" }));
    expect(reopened.events.some((event) => event.type === "agent.status" && event.nodeId === "worker" && event.status === "cancelled")).toBe(false);
    expect(reopened.events).toContainEqual(expect.objectContaining({ type: "run.status", status: "cancelled" }));
  });
  test("Desktop 退出已收敛后，迟到的 complete 被拒绝且 Journal 零污染", async () => {
    let entered!: () => void;
    const enteredExecution = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = await create({ execute: async () => { entered(); return new Promise<JsonObject>(() => {}); }, stop: async () => {} });
    void runtime.run(workflow).catch(() => undefined);
    await enteredExecution;
    const agentSessionId = runtime.snapshot().phases[0].agents[0].agentSessionId!;
    const control = runtime.createControlServer();
    control.register({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, capability: "cap-1" });
    await control.recordSession({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, delivery: "acp", acp: { launcherId: "test", sessionId: "s", capabilities: {} } });
    await runtime.cancelForDesktopExit("test-engine");
    await expect(control.complete({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, capability: "cap-1", summary: "late", result: { ok: true } })).rejects.toThrow("只允许当前 running 节点");
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    expect(reopened.events.some((event) => event.type === "agent.completed")).toBe(false);
    expect(reopened.events.at(-1)).toMatchObject({ type: "run.status", status: "cancelled" });
  });
});
