import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRuntime } from "../../src/runtime/run-runtime";
import type { AgentNodeExecutor } from "../../src/runtime/run-types";
import type { JsonObject } from "../../src/shared/json";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import { agent, phase } from "../../src/workflow/author-api";
import type { CapabilitySnapshot } from "../../src/adapters/capabilities";
import { ControlServer } from "../../src/control/control-server";
import type { SessionIdentity } from "../../src/sessions/types";
import { runsRoot } from "../../src/journal/paths";
import { AgentStartLimiter, LimitedAgentExecutor } from "../../src/daemon/agent-start-limiter";
import { nodeDirectoryName } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const workflow: WorkflowModule<JsonObject, unknown> = {
  meta: { name: "runtime-check", description: "Check runtime.", phases: [{ title: "scan" }] },
  default: async () => {
    phase("scan");
    return agent("scan", { id: "scan-auth", cli: "codex" });
  },
};

async function runtime(executor: AgentNodeExecutor): Promise<RunRuntime> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-runtime-"));
  directories.push(cwd);
  const workflowPath = join(cwd, "workflow.ts");
  await writeFile(workflowPath, "workflow source", "utf8");
  return RunRuntime.create({ workflow, input: {}, workflowSource: "workflow source", clientRequestId: crypto.randomUUID(), workflowProjectCwd: cwd, workflowPath, storeRoot: runsRoot(join(cwd, "store")), executor });
}

describe("RunRuntime", () => {
  test("以 durable-first 保存完成结果并提供 Phase → Agent 查询", async () => {
    const instance = await runtime({ execute: async () => ({ ok: true }) });
    await expect(instance.run(workflow)).resolves.toEqual({ ok: true });
    expect(instance.snapshot()).toMatchObject({ status: "completed", phases: [{ title: "scan", agents: [{ id: "scan-auth", status: "completed", result: { ok: true } }] }] });
  });

  test("回溯 phase 会耐久拆分为独立阶段访问，重开后不按标题错误合并", async () => {
    const loopWorkflow: WorkflowModule<JsonObject, unknown> = {
      meta: { name: "phase-loop", description: "Loop phases.", phases: [{ title: "guess" }, { title: "analyze" }] },
      default: async () => {
        for (let round = 1; round <= 2; round += 1) {
          phase("guess"); await agent(`guess ${round}`, { id: `guess-${round}`, cli: "codex" });
          phase("analyze"); await agent(`analyze ${round}`, { id: `analyze-${round}`, cli: "codex" });
        }
        return { rounds: 2 };
      },
    };
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-phase-loop-")); directories.push(cwd);
    const workflowPath = join(cwd, "workflow.ts"); await writeFile(workflowPath, "workflow source", "utf8");
    const instance = await RunRuntime.create({ workflow: loopWorkflow, input: {}, workflowSource: "workflow source", clientRequestId: crypto.randomUUID(), workflowProjectCwd: cwd, workflowPath, storeRoot: runsRoot(join(cwd, "store")), executor: { execute: async (node) => ({ node: node.id }) } });
    await instance.run(loopWorkflow);
    const reopened = await RunRuntime.open(instance.snapshot().id, { execute: async () => ({ unused: true }) }, join(instance.journal.directory, ".."));
    expect(reopened.snapshot().phaseVisits.map((visit) => ({ title: visit.title, occurrence: visit.occurrence, agents: visit.batches.flatMap((batch) => batch.agents.map((agent) => agent.id)) }))).toEqual([
      { title: "guess", occurrence: 1, agents: ["guess-1"] },
      { title: "analyze", occurrence: 1, agents: ["analyze-1"] },
      { title: "guess", occurrence: 2, agents: ["guess-2"] },
      { title: "analyze", occurrence: 2, agents: ["analyze-2"] },
    ]);
  });

  test("executor 返回 null 时标记 interrupted，不能伪装为业务失败", async () => {
    const instance = await runtime({ execute: async () => null });
    await expect(instance.run(workflow)).rejects.toThrow("无法验证节点已完成");
    expect(instance.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ status: "interrupted" }] }] });
  });

  test("真实执行器经 Control 完成后不会重复追加 completed 事件", async () => {
    let control: ControlServer | undefined;
    const instance = await runtime({
      execute: async (node) => {
        const server = control!;
        const capability = "runtime-capability";
        server.register({ runId: server.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability, reclaimTokenHash: "a".repeat(64) });
        const session: SessionIdentity = { backend: "tmux", sessionName: "wf-runtime", backendRef: "/tmp/wf-runtime.sock", runId: server.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, cli: "codex", createdAt: new Date().toISOString() };
        await server.recordSession({ runId: server.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, delivery: "tmux", session });
        await server.complete({ runId: server.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability, summary: "done", result: { ok: true } });
        return { ok: true };
      },
    });
    control = instance.createControlServer();
    await expect(instance.run(workflow)).resolves.toEqual({ ok: true });
    const reopened = await RunRuntime.open(instance.journal.manifest.runId, { execute: async () => ({ unused: true }) }, join(instance.journal.directory, ".."));
    expect(reopened.snapshot().phases[0]?.agents[0]).toMatchObject({ status: "completed", result: { ok: true } });
  });

  test("executor 抛错时标记 interrupted", async () => {
    const instance = await runtime({ execute: async () => { throw new Error("executor crashed"); } });
    await expect(instance.run(workflow)).rejects.toThrow("executor crashed");
    expect(instance.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ status: "interrupted", diagnostic: "executor crashed" }] }] });
  });

  test("拒绝未选择 Phase 的 Agent，避免节点脱离 Phase → Agent 主视图", async () => {
    const noPhase: WorkflowModule<JsonObject, unknown> = {
      meta: workflow.meta,
      default: () => agent("scan", { id: "unassigned", cli: "codex" }),
    };
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    await expect(instance.run(noPhase)).rejects.toThrow("必须调用 phase");
    expect(instance.snapshot().phases[0].agents).toEqual([]);
  });

  test("即使作者未 await agent()，Run 也等待节点完成后才封存", async () => {
    let release: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const detached: WorkflowModule<JsonObject, unknown> = {
      meta: workflow.meta,
      default: async () => { phase("scan"); void agent("detached", { id: "detached", cli: "codex" }); return { submitted: true }; },
    };
    const instance = await runtime({ execute: async () => { await delayed; return { ok: true }; } });
    const running = instance.run(detached);
    await Promise.resolve();
    expect(instance.snapshot().status).toBe("running");
    release?.();
    await expect(running).resolves.toEqual({ submitted: true });
    expect(instance.snapshot()).toMatchObject({ status: "completed", phases: [{ agents: [{ id: "detached", status: "completed" }] }] });
  });

  test("可以从 Manifest 和 Journal 重开并重建 Phase → Agent 视图", async () => {
    const instance = await runtime({ execute: async () => ({ ok: true }) });
    await instance.run(workflow);
    const restored = await RunRuntime.open(instance.journal.manifest.runId, { execute: async () => ({ unused: true }) }, join(instance.journal.directory, ".."));
    expect(restored.snapshot()).toMatchObject({ status: "completed", phases: [{ title: "scan", agents: [{ id: "scan-auth", status: "completed", result: { ok: true } }] }] });
  });

  test("resume 严格复用已完成节点，不再次调用执行器或追加 agent.created", async () => {
    const first = await runtime({ execute: async () => ({ ok: true }) });
    await first.run(workflow);
    // 为模拟 daemon 崩溃前 Control 已完成、但旧 Runtime 未能封存 Run，删除 run.status
    // 不属于该测试范围；直接构造一个 running completed-node Journal 更精确。
    const instance = await runtime({ execute: async () => ({ ok: true }) });
    const created = { type: "agent.created" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId: "scan-auth", agentSessionId: null, diagnostic: null, sequence: 1, phase: "scan", request: { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd: instance.journal.manifest.workflowProjectCwd, prompt: "scan", phase: "scan" } };
    await instance.journal.append(created); instance.state.apply(created);
    const started = { type: "agent.status" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId: "scan-auth", agentSessionId: "old", diagnostic: null, status: "running" as const };
    await instance.journal.append(started); instance.state.apply(started);
    const resultPath = await instance.journal.writeResult("scan-auth", { ok: true }, "old");
    const completed = { type: "agent.completed" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId: "scan-auth", agentSessionId: "old", diagnostic: null, resultPath, result: { ok: true } };
    await instance.journal.append(completed); instance.state.apply(completed);
    let executions = 0;
    const resumed = await RunRuntime.resume(instance.journal.manifest.runId, { execute: async () => { executions += 1; return { unexpected: true }; } }, join(instance.journal.directory, ".."));
    let replayed: unknown;
    try { replayed = await resumed.run(workflow); } catch (error) { throw new Error(`completed replay: ${error instanceof Error ? error.message : String(error)}`); }
    expect(replayed).toEqual({ ok: true });
    expect(executions).toBe(0);
    const opened = await RunRuntime.open(instance.journal.manifest.runId, { execute: async () => ({ unused: true }) }, join(instance.journal.directory, ".."));
    expect(opened.snapshot().phases[0]?.agents).toHaveLength(1);
    const journal = await RunJournal.open(instance.journal.manifest.runId, join(instance.journal.directory, ".."));
    expect(journal.events.filter((event) => event.type === "execution-attempt.started")).toHaveLength(1);
  });

  test("Runtime API 拒绝对只读兼容的 v4 Journal 执行 Replay", async () => {
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    const manifestPath = join(instance.journal.directory, "manifest.json");
    const legacy = JSON.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
    legacy.runtimeVersion = 4;
    await Bun.write(manifestPath, JSON.stringify(legacy));
    await expect(RunRuntime.resume(instance.journal.manifest.runId, { execute: async () => ({ unexpected: true }) }, join(instance.journal.directory, ".."))).rejects.toThrow("只能读取");
  });

  test("resume 只为 interrupted 节点创建新 attempt", async () => {
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    const request = { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd: instance.journal.manifest.workflowProjectCwd, prompt: "scan", phase: "scan" };
    const created = { type: "agent.created" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId: "scan-auth", agentSessionId: null, diagnostic: null, sequence: 1, phase: "scan", request };
    await instance.journal.append(created); instance.state.apply(created);
    const started = { type: "agent.status" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId: "scan-auth", agentSessionId: "old", diagnostic: null, status: "running" as const };
    await instance.journal.append(started); instance.state.apply(started);
    const interrupted = { ...started, at: new Date().toISOString(), status: "interrupted" as const, diagnostic: "old daemon lost session" };
    await instance.journal.append(interrupted); instance.state.apply(interrupted);
    let executions = 0;
    const resumed = await RunRuntime.resume(instance.journal.manifest.runId, { execute: async () => { executions += 1; return { resumed: true }; } }, join(instance.journal.directory, ".."));
    let restartedResult: unknown;
    try { restartedResult = await resumed.run(workflow); } catch (error) { throw new Error(`interrupted replay: ${error instanceof Error ? error.message : String(error)}`); }
    expect(restartedResult).toEqual({ resumed: true });
    expect(executions).toBe(1);
    const opened = await RunJournal.open(instance.journal.manifest.runId, join(instance.journal.directory, ".."));
    expect(opened.events.filter((event) => event.type === "agent.restarted")).toHaveLength(1);
    expect(opened.events.filter((event) => event.type === "execution-attempt.started")).toHaveLength(2);
    expect(opened.events.filter((event) => event.type === "phase.entered").at(-1)).toMatchObject({ executionAttemptId: 2, title: "scan", occurrence: 1 });
  });

  test("resume 的 Agent 请求不匹配时拒绝且不污染旧 Journal", async () => {
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    const request = { id: "scan-auth", cli: "codex" as const, sandbox: "read-only" as const, cwd: instance.journal.manifest.workflowProjectCwd, prompt: "old prompt", phase: "scan" };
    const created = { type: "agent.created" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId: "scan-auth", agentSessionId: null, diagnostic: null, sequence: 1, phase: "scan", request };
    await instance.journal.append(created); instance.state.apply(created);
    const started = { type: "agent.status" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId: "scan-auth", agentSessionId: "old", diagnostic: null, status: "running" as const };
    await instance.journal.append(started); instance.state.apply(started);
    const interrupted = { ...started, at: new Date().toISOString(), status: "interrupted" as const, diagnostic: "old daemon lost session" };
    await instance.journal.append(interrupted); instance.state.apply(interrupted);
    const changed: WorkflowModule<JsonObject, unknown> = { ...workflow, default: async () => { phase("scan"); return agent("new prompt", { id: "scan-auth", cli: "codex" }); } };
    const resumed = await RunRuntime.resume(instance.journal.manifest.runId, { execute: async () => ({ unexpected: true }) }, join(instance.journal.directory, ".."));
    await expect(resumed.run(changed)).rejects.toThrow("调用与 Journal 节点不匹配");
    const opened = await RunJournal.open(instance.journal.manifest.runId, join(instance.journal.directory, ".."));
    expect(opened.events.filter((event) => event.type === "agent.restarted")).toHaveLength(0);
    expect(opened.events.at(-1)).toMatchObject({ type: "agent.status", status: "interrupted" });
  });

  test("resume 从第一个 interrupted 节点开始，使后续旧 completed 节点重新执行", async () => {
    const two: WorkflowModule<JsonObject, unknown> = {
      meta: workflow.meta,
      default: async () => { phase("scan"); const first = await agent("first", { id: "first", cli: "codex" }); return agent("second", { id: "second", cli: "codex", input: first ?? {} }); },
    };
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    const firstRequest = { id: "first", cli: "codex" as const, sandbox: "read-only" as const, cwd: instance.journal.manifest.workflowProjectCwd, prompt: "first", phase: "scan" };
    const secondRequest = { id: "second", cli: "codex" as const, sandbox: "read-only" as const, cwd: instance.journal.manifest.workflowProjectCwd, prompt: "second", phase: "scan", input: {} };
    for (const [nodeId, sequence, request, status] of [["first", 1, firstRequest, "interrupted"], ["second", 2, secondRequest, "completed"]] as const) {
      const created = { type: "agent.created" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId, agentSessionId: null, diagnostic: null, sequence, phase: "scan", request };
      await instance.journal.append(created); instance.state.apply(created);
      const started = { type: "agent.status" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId, agentSessionId: `${nodeId}-old`, diagnostic: null, status: "running" as const };
      await instance.journal.append(started); instance.state.apply(started);
      if (status === "interrupted") { const event = { ...started, at: new Date().toISOString(), status: "interrupted" as const, diagnostic: "lost" }; await instance.journal.append(event); instance.state.apply(event); }
      else { const session = `${nodeId}-old`; const resultPath = await instance.journal.writeResult(nodeId, {}, session); const event = { type: "agent.completed" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId, agentSessionId: session, diagnostic: null, resultPath, result: {} }; await instance.journal.append(event); instance.state.apply(event); }
    }
    const executions: string[] = [];
    const resumed = await RunRuntime.resume(instance.journal.manifest.runId, { execute: async (node) => { executions.push(node.id); return {}; } }, join(instance.journal.directory, ".."));
    await resumed.run(two);
    expect(executions).toEqual(["first", "second"]);
    const opened = await RunJournal.open(instance.journal.manifest.runId, join(instance.journal.directory, ".."));
    expect(opened.events.filter((event) => event.type === "agent.restarted")).toMatchObject([
      { nodeId: "first", invalidatedByPriorRestart: false },
      { nodeId: "second", invalidatedByPriorRestart: true },
    ]);
  });

  test("resume 允许重跑结果改变后进入新的下游分支", async () => {
    const oldFlow: WorkflowModule<JsonObject, unknown> = {
      meta: workflow.meta,
      default: async () => { phase("scan"); const first = await agent("decision", { id: "decision", cli: "codex" }); return agent("old branch", { id: "old-branch", cli: "codex", input: first ?? {} }); },
    };
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    const firstRequest = { id: "decision", cli: "codex" as const, sandbox: "read-only" as const, cwd: instance.journal.manifest.workflowProjectCwd, prompt: "decision", phase: "scan" };
    const oldRequest = { id: "old-branch", cli: "codex" as const, sandbox: "read-only" as const, cwd: instance.journal.manifest.workflowProjectCwd, prompt: "old branch", phase: "scan", input: {} };
    for (const [nodeId, sequence, request, status] of [["decision", 1, firstRequest, "interrupted"], ["old-branch", 2, oldRequest, "completed"]] as const) {
      const created = { type: "agent.created" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId, agentSessionId: null, diagnostic: null, sequence, phase: "scan", request };
      await instance.journal.append(created); instance.state.apply(created);
      const started = { type: "agent.status" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId, agentSessionId: `${nodeId}-old`, diagnostic: null, status: "running" as const };
      await instance.journal.append(started); instance.state.apply(started);
      if (status === "interrupted") { const event = { ...started, status: "interrupted" as const, diagnostic: "lost" }; await instance.journal.append(event); instance.state.apply(event); }
      else { const resultPath = await instance.journal.writeResult(nodeId, {}, `${nodeId}-old`); const event = { type: "agent.completed" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId, agentSessionId: `${nodeId}-old`, diagnostic: null, resultPath, result: {} }; await instance.journal.append(event); instance.state.apply(event); }
    }
    const newFlow: WorkflowModule<JsonObject, unknown> = {
      ...oldFlow,
      default: async () => { phase("scan"); const first = await agent("decision", { id: "decision", cli: "codex" }); return agent("new branch", { id: "new-branch", cli: "codex", input: first ?? {} }); },
    };
    const resumed = await RunRuntime.resume(instance.journal.manifest.runId, { execute: async (node) => node.id === "decision" ? ({ branch: "new" } as JsonObject) : ({ done: true } as JsonObject) }, join(instance.journal.directory, ".."));
    let dynamicResult: unknown;
    try { dynamicResult = await resumed.run(newFlow); } catch (error) { throw new Error(`dynamic branch resume: ${error instanceof Error ? error.message : String(error)}`); }
    expect(dynamicResult).toEqual({ done: true });
  });

  test("动态新分支节点可在第二次 resume 中按逻辑调用位置重新匹配", async () => {
    const flow: WorkflowModule<JsonObject, unknown> = {
      meta: workflow.meta,
      default: async () => { phase("scan"); const decision = await agent("decision", { id: "decision", cli: "codex" }); return agent("new", { id: "new-branch", cli: "codex", input: decision ?? {} }); },
    };
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    const oldRequest = { id: "decision", cli: "codex" as const, sandbox: "read-only" as const, cwd: instance.journal.manifest.workflowProjectCwd, prompt: "decision", phase: "scan" };
    const oldCreated = { type: "agent.created" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId: "decision", agentSessionId: null, diagnostic: null, sequence: 1, logicalSequence: 1, phase: "scan", request: oldRequest };
    await instance.journal.append(oldCreated); instance.state.apply(oldCreated);
    const oldRunning = { type: "agent.status" as const, at: new Date().toISOString(), runId: instance.journal.manifest.runId, nodeId: "decision", agentSessionId: "old", diagnostic: null, status: "running" as const };
    await instance.journal.append(oldRunning); instance.state.apply(oldRunning);
    const oldInterrupted = { ...oldRunning, status: "interrupted" as const, diagnostic: "lost" };
    await instance.journal.append(oldInterrupted); instance.state.apply(oldInterrupted);
    const first = await RunRuntime.resume(instance.journal.manifest.runId, { execute: async (node) => node.id === "decision" ? ({ branch: "new" } as JsonObject) : null }, join(instance.journal.directory, ".."));
    await expect(first.run(flow)).rejects.toThrow("无法验证节点已完成");
    const second = await RunRuntime.resume(instance.journal.manifest.runId, { execute: async (node) => ({ resumed: node.id } as JsonObject) }, join(instance.journal.directory, ".."));
    await expect(second.run(flow)).resolves.toEqual({ resumed: "new-branch" });
  });

  test("重开当前尝试时新动态节点的展示序号必须避开旧尝试历史", async () => {
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    const request = (id: string) => ({ id, cli: "codex" as const, sandbox: "read-only" as const, cwd: instance.journal.manifest.workflowProjectCwd, prompt: id, phase: "scan" });
    const base = { at: new Date().toISOString(), runId: instance.journal.manifest.runId, agentSessionId: null, diagnostic: null };
    const firstAttempt = { type: "agent.created" as const, ...base, nodeId: "old-visible", sequence: 1, phase: "scan", request: request("old-visible") };
    const hiddenOldBranch = { type: "agent.created" as const, ...base, nodeId: "old-hidden", sequence: 2, phase: "scan", request: request("old-hidden") };
    for (const event of [firstAttempt, hiddenOldBranch]) { await instance.journal.append(event); instance.state.apply(event); }
    const reopened = await RunRuntime.open(instance.journal.manifest.runId, { execute: async (node) => ({ node: node.id }) }, join(instance.journal.directory, ".."));
    const dynamic: WorkflowModule<JsonObject, unknown> = { meta: workflow.meta, default: async () => { phase("scan"); return agent("new", { id: "new-node", cli: "codex" }); } };
    // 让重开 Host 直接执行一个新节点，验证其展示序号来自全部 Journal，而非当前投影视图。
    await reopened.run(dynamic).catch(() => undefined);
    const opened = await RunJournal.open(instance.journal.manifest.runId, join(instance.journal.directory, ".."));
    expect(opened.events.find((event) => event.type === "agent.created" && event.nodeId === "new-node")).toMatchObject({ sequence: 3 });
  });

  test("同步 phase Journal 写入失败会中断 Run，不会静默完成", async () => {
    const instance = await runtime({ execute: async () => ({ ok: true }) });
    instance.journal.failNextAppendForTest();
    await expect(instance.run(workflow)).rejects.toThrow("Injected Journal append failure");
    expect(instance.snapshot().status).toBe("interrupted");
  });

  test("执行器声明的运行期能力 unknown 时节点在启动前 fail closed", async () => {
    const unknownSnapshot: CapabilitySnapshot = {
      version: 1,
      host: { platform: "test", tmux: { status: "unknown", persistentSessions: "unknown" } },
      adapters: { codex: { status: "available", interactiveSession: "unknown", verifiedPromptDelivery: "unknown", persistentTmuxSession: "unknown", sandbox: { readOnly: "unknown", workspaceWrite: "unknown" } } },
    };
    let executions = 0;
    const instance = await runtime({
      execute: async () => { executions += 1; return { unexpected: true }; },
      probeCapabilities: async () => unknownSnapshot,
      requiredCapabilities: () => ({ "codex.interactiveSession": (snapshot) => snapshot.adapters.codex.interactiveSession }),
    });
    await expect(instance.run(workflow)).rejects.toThrow("codex.interactiveSession=unknown");
    expect(executions).toBe(0);
    expect(instance.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ status: "interrupted" }] }] });
  });

  test("真实 Runtime 在 Agent 获得 sessionId 后仍释放全局启动名额", async () => {
    const limiter = new AgentStartLimiter(1);
    const base = { execute: async (node: import("../../src/runtime/run-types").AgentNodeSnapshot) => ({ id: node.id }) };
    const first = await runtime(new LimitedAgentExecutor(base, limiter));
    const second = await runtime(new LimitedAgentExecutor(base, limiter));
    await expect(first.run(workflow)).resolves.toEqual({ id: "scan-auth" });
    await expect(second.run(workflow)).resolves.toEqual({ id: "scan-auth" });
  });

  test("pause 阻断后续调度且不结束 agent()，recover 后才在同一调用继续", async () => {
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    let finish!: (value: JsonObject) => void;
    const pending = new Promise<JsonObject>((resolve) => { finish = resolve; });
    let pauses = 0;
    let recovers = 0;
    const subject = await RunRuntime.create({
      workflow,
      input: {}, workflowSource: "workflow source", clientRequestId: crypto.randomUUID(), workflowProjectCwd: instance.journal.manifest.workflowProjectCwd, workflowPath: instance.journal.manifest.workflowPath, storeRoot: join(instance.journal.directory, ".."),
      executor: { execute: async () => pending, pause: async () => { pauses += 1; }, recover: async () => { recovers += 1; finish({ resumed: true }); return {}; } },
    });
    const running = subject.run(workflow);
    while (subject.snapshot().phases[0]?.agents[0]?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 5));
    await subject.pause();
    expect(subject.snapshot().status).toBe("paused");
    expect(subject.snapshot().phases[0]?.agents[0]?.status).toBe("paused");
    expect(pauses).toBe(1);
    await subject.recover();
    await expect(running).resolves.toEqual({ resumed: true });
    expect(recovers).toBe(1);
    expect(subject.snapshot().status).toBe("completed");
  });

  test("stop 先耐久 cancelled，再结束执行 Promise，不能被误记为 interrupted", async () => {
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    let reject!: (error: Error) => void;
    const pending = new Promise<JsonObject>((_, fail) => { reject = fail; });
    const subject = await RunRuntime.create({
      workflow, input: {}, workflowSource: "workflow source", clientRequestId: crypto.randomUUID(), workflowProjectCwd: instance.journal.manifest.workflowProjectCwd, workflowPath: instance.journal.manifest.workflowPath, storeRoot: join(instance.journal.directory, ".."),
      executor: { execute: async () => pending, stop: async () => { setTimeout(() => reject(new Error("stopped")), 0); } },
    });
    const running = subject.run(workflow);
    const outcome = running.then(() => "resolved", (error) => error instanceof Error ? error.message : String(error));
    while (subject.snapshot().phases[0]?.agents[0]?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 5));
    await subject.stop();
    await expect(outcome).resolves.toBe("stopped");
    expect(subject.snapshot()).toMatchObject({ status: "cancelled", phases: [{ agents: [{ status: "cancelled" }] }] });
  });

  test("pause 期间执行器异常必须收敛为 interrupted，不能被 stop 保护掩盖", async () => {
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    let reject!: (error: Error) => void;
    const pending = new Promise<JsonObject>((_, fail) => { reject = fail; });
    const subject = await RunRuntime.create({
      workflow, input: {}, workflowSource: "workflow source", clientRequestId: crypto.randomUUID(), workflowProjectCwd: instance.journal.manifest.workflowProjectCwd, workflowPath: instance.journal.manifest.workflowPath, storeRoot: join(instance.journal.directory, ".."),
      executor: { execute: async () => pending, pause: async () => { reject(new Error("pause transport lost")); throw new Error("pause transport lost"); } },
    });
    const running = subject.run(workflow).catch(() => undefined);
    while (subject.snapshot().phases[0]?.agents[0]?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(subject.pause()).rejects.toThrow("pause transport lost");
    await running;
    expect(subject.snapshot().status).toBe("interrupted");
  });

  test("stop 会抢占 pausing 中的控制调用并收敛为 cancelled", async () => {
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    let reject!: (error: Error) => void;
    const pending = new Promise<JsonObject>((_, fail) => { reject = fail; });
    let pauseStarted!: () => void;
    const pauseEntered = new Promise<void>((resolve) => { pauseStarted = resolve; });
    const subject = await RunRuntime.create({
      workflow, input: {}, workflowSource: "workflow source", clientRequestId: crypto.randomUUID(), workflowProjectCwd: instance.journal.manifest.workflowProjectCwd, workflowPath: instance.journal.manifest.workflowPath, storeRoot: join(instance.journal.directory, ".."),
      executor: {
        execute: async () => pending,
        pause: async (_node, signal) => {
          pauseStarted();
          await new Promise<void>((_resolve, fail) => signal?.addEventListener("abort", () => fail(new Error("pause aborted by stop")), { once: true }));
        },
        stop: async () => { setTimeout(() => reject(new Error("stopped")), 0); },
      },
    });
    const running = subject.run(workflow).catch(() => undefined);
    while (subject.snapshot().phases[0]?.agents[0]?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 5));
    const pausing = subject.pause().then(() => null, (error) => error);
    await pauseEntered;
    await expect(subject.stop()).resolves.toMatchObject({ status: "cancelled" });
    await expect(pausing).resolves.toBeInstanceOf(Error);
    await running;
    expect(subject.snapshot()).toMatchObject({ status: "cancelled", phases: [{ agents: [{ status: "cancelled" }] }] });
  });
});
