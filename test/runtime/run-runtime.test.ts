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
});
