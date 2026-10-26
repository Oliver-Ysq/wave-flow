import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RUNTIME_VERSION, type JournalEvent, type RunManifest } from "../../src/journal/types";
import { AgentStartLimiter, LimitedAgentExecutor } from "../../src/runtime/agent-start-limiter";
import { RunRuntime } from "../../src/runtime/run-runtime";
import { RunStateMachine } from "../../src/runtime/run-state-machine";
import type { AgentNodeExecutor } from "../../src/runtime/run-types";
import type { JsonObject } from "../../src/shared/json";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import { agent, phase } from "../../src/workflow/author-api";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const parallel: WorkflowModule<JsonObject, unknown> = {
  meta: { name: "queued-start", description: "Queued start.", phases: [{ title: "run" }] },
  default: async () => { phase("run"); return Promise.all([agent("甲", { id: "a", cli: "codex" }), agent("乙", { id: "b", cli: "codex" })]); },
};

async function create(executor: AgentNodeExecutor): Promise<RunRuntime> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-queued-start-")); directories.push(cwd);
  const workflowPath = join(cwd, "workflow.ts"); await writeFile(workflowPath, "workflow", "utf8");
  return RunRuntime.create({ workflow: parallel, input: {}, workflowSource: "workflow", clientRequestId: crypto.randomUUID(), workflowProjectCwd: cwd, workflowPath, storeRoot: runsRoot(join(cwd, "store")), executor });
}

async function waitForNode(runtime: RunRuntime, nodeId: string, status: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (runtime.snapshot().phases.flatMap((phase) => phase.agents).find((node) => node.id === nodeId)?.status !== status) {
    if (Date.now() > deadline) throw new Error(`等待节点 ${nodeId} 进入 ${status} 超时。`);
    await Bun.sleep(1);
  }
}

describe("queued 节点的启动许可复核", () => {
  test("maxActiveAgents=1：stop 释放名额后排队节点不再 execute，节点与 Run 均 cancelled 且 Journal 可重开", async () => {
    const executed: string[] = [];
    const failures = new Map<string, (error: Error) => void>();
    const executor = new LimitedAgentExecutor({
      execute: (node) => { executed.push(node.id); return new Promise<JsonObject>((_, reject) => failures.set(node.id, reject)); },
      stop: async (node) => { failures.get(node.id)?.(new Error("已停止")); },
    }, new AgentStartLimiter(1));
    const runtime = await create(executor);
    const running = runtime.run(parallel).catch(() => undefined);
    await waitForNode(runtime, "a", "running");
    await waitForNode(runtime, "b", "queued");
    await runtime.stop();
    await running;
    // B 从未进入真实执行器；A/B 与 Run 都是 cancelled 终态。
    expect(executed).toEqual(["a"]);
    expect(runtime.snapshot()).toMatchObject({ status: "cancelled", phases: [{ agents: [{ id: "a", status: "cancelled" }, { id: "b", status: "cancelled" }] }] });
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    expect(reopened.events.some((event) => event.nodeId === "b" && ((event.type === "agent.status" && event.status === "running") || event.type === "agent.session" || event.type === "agent.completed"))).toBe(false);
    expect(reopened.events).toContainEqual(expect.objectContaining({ type: "agent.status", nodeId: "b", status: "cancelled" }));
    expect(reopened.events.at(-1)).toMatchObject({ type: "run.status", status: "cancelled" });
  });

  test("pause 不启动排队节点也不中断 Run；recover 后名额按顺序投递", async () => {
    const executed: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const executor = new LimitedAgentExecutor({
      execute: async (node) => { executed.push(node.id); if (node.id === "a") await gateA; return { ok: node.id }; },
      pause: async () => {},
      recover: async () => ({}),
      stop: async () => {},
    }, new AgentStartLimiter(1));
    const runtime = await create(executor);
    const running = runtime.run(parallel);
    await waitForNode(runtime, "a", "running");
    await waitForNode(runtime, "b", "queued");
    const paused = await runtime.pause();
    expect(paused.status).toBe("paused");
    expect(paused.phases[0].agents.find((node) => node.id === "b")?.status).toBe("queued");
    await Bun.sleep(10);
    expect(executed).toEqual(["a"]);
    const recovered = await runtime.recover();
    expect(recovered.status).toBe("running");
    releaseA();
    await expect(running).resolves.toEqual([{ ok: "a" }, { ok: "b" }]);
    expect(executed).toEqual(["a", "b"]);
    expect(runtime.snapshot()).toMatchObject({ status: "completed", phases: [{ agents: [{ id: "a", status: "completed" }, { id: "b", status: "completed" }] }] });
    await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
  });

  test("pause 期间的 queued 节点在 stop 后也不启动，Journal 可重开", async () => {
    const executed: string[] = [];
    const failures = new Map<string, (error: Error) => void>();
    const executor = new LimitedAgentExecutor({
      execute: (node) => { executed.push(node.id); return new Promise<JsonObject>((_, reject) => failures.set(node.id, reject)); },
      pause: async () => {},
      recover: async () => ({}),
      stop: async (node) => { failures.get(node.id)?.(new Error("已停止")); },
    }, new AgentStartLimiter(1));
    const runtime = await create(executor);
    const running = runtime.run(parallel).catch(() => undefined);
    await waitForNode(runtime, "a", "running");
    await waitForNode(runtime, "b", "queued");
    await runtime.pause();
    await runtime.stop();
    await running;
    expect(executed).toEqual(["a"]);
    expect(runtime.snapshot()).toMatchObject({ status: "cancelled", phases: [{ agents: [{ id: "a", status: "cancelled" }, { id: "b", status: "cancelled" }] }] });
    const reopened = await RunJournal.open(runtime.snapshot().id, join(runtime.journal.directory, ".."));
    expect(reopened.events.some((event) => event.nodeId === "b" && event.type === "agent.status" && event.status === "running")).toBe(false);
  });

  test("running 已耐久但真实启动前 stop，撤销标记仍阻止 execute", async () => {
    const executed: string[] = [];
    const failures = new Map<string, (error: Error) => void>();
    const runtime = await create({
      execute: (node) => { executed.push(node.id); return new Promise<JsonObject>((_, reject) => failures.set(node.id, reject)); },
      stop: async (node) => { failures.get(node.id)?.(new Error("已停止")); },
    });
    const apply = runtime.state.apply.bind(runtime.state);
    let stopping!: Promise<unknown>;
    const applied = spyOn(runtime.state, "apply").mockImplementation((event) => {
      apply(event);
      if (event.type === "agent.status" && event.nodeId === "b" && event.status === "running") stopping = runtime.stop();
    });
    const running = runtime.run(parallel).catch(() => undefined);
    await waitForNode(runtime, "a", "cancelled");
    await waitForNode(runtime, "b", "cancelled");
    await stopping;
    await running;
    applied.mockRestore();
    expect(executed).toEqual(["a"]);
    expect(runtime.snapshot().status).toBe("cancelled");
  });

  test("queued 节点落盘失败后仍停止其他真实 Worker", async () => {
    const stopped: string[] = [];
    const failures = new Map<string, (error: Error) => void>();
    const executor = new LimitedAgentExecutor({
      execute: (node) => new Promise<JsonObject>((_, reject) => failures.set(node.id, reject)),
      stop: async (node) => { stopped.push(node.id); failures.get(node.id)?.(new Error("已停止")); },
    }, new AgentStartLimiter(1));
    const runtime = await create(executor);
    const running = runtime.run(parallel).catch(() => undefined);
    await waitForNode(runtime, "a", "running");
    await waitForNode(runtime, "b", "queued");
    runtime.journal.failNextAppendForTest("磁盘已满（注入）");
    await expect(runtime.stop()).rejects.toThrow("磁盘已满（注入）");
    await running;
    expect(stopped).toEqual(["a"]);
  });
});

describe("终态 Run 的状态机防write", () => {
  function fixture(): { readonly state: RunStateMachine; readonly runId: string; readonly at: (offset: number) => string } {
    const manifest: RunManifest = {
      runId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), runtimeVersion: RUNTIME_VERSION,
      workflow: { name: "guard", description: "Guard.", phases: [{ title: "run" }] },
      workflowHash: "a".repeat(64), workflowPath: "/tmp/wave-flow-guard/workflow.ts", workflowProjectCwd: "/tmp/wave-flow-guard",
      input: {}, createdAt: new Date().toISOString(),
    };
    const at = (offset: number): string => new Date(Date.parse(manifest.createdAt) + offset).toISOString();
    const state = new RunStateMachine(manifest);
    const request = { id: "node", cli: "codex" as const, sandbox: "workspace-write" as const, cwd: "/tmp/wave-flow-guard", prompt: "做", phase: "run" };
    state.apply({ type: "run.created", at: at(0), runId: manifest.runId, nodeId: null, agentSessionId: null, diagnostic: null, runStatus: "running" });
    state.apply({ type: "agent.created", at: at(1), runId: manifest.runId, nodeId: "node", agentSessionId: null, diagnostic: null, sequence: 1, phase: "run", request });
    return { state, runId: manifest.runId, at };
  }

  test("cancelled Run 拒绝 queued→running、agent.session 与 agent.completed，但仍接受收敛类 cancelled/interrupted", () => {
    const { state, runId, at } = fixture();
    state.apply({ type: "run.status", at: at(2), runId, nodeId: null, agentSessionId: null, diagnostic: "用户停止 Run。", status: "cancelled" });
    expect(() => state.apply({ type: "agent.status", at: at(3), runId, nodeId: "node", agentSessionId: null, diagnostic: null, status: "running" })).toThrow("已终态");
    expect(() => state.apply({ type: "agent.session", at: at(4), runId, nodeId: "node", agentSessionId: "s", diagnostic: null, delivery: "acp", acp: { launcherId: "codex-acp", sessionId: "s", capabilities: {} } })).toThrow("已终态");
    expect(() => state.apply({ type: "agent.completed", at: at(5), runId, nodeId: "node", agentSessionId: null, diagnostic: null, resultPath: "nodes/node/result.json", result: { ok: true } })).toThrow("已终态");
    // 合法收敛不受影响：queued 节点仍可落 cancelled/interrupted 终态证据。
    state.apply({ type: "agent.status", at: at(6), runId, nodeId: "node", agentSessionId: null, diagnostic: "用户停止 Run。", status: "cancelled" });
    expect(state.agent("node").status).toBe("cancelled");
  });

  test("interrupted Run 拒绝迟到的节点 completed 事实", () => {
    const { state, runId, at } = fixture();
    state.apply({ type: "agent.status", at: at(2), runId, nodeId: "node", agentSessionId: null, diagnostic: null, status: "running" });
    state.apply({ type: "run.status", at: at(3), runId, nodeId: null, agentSessionId: null, diagnostic: "Engine 重启。", status: "interrupted" });
    expect(() => state.apply({ type: "agent.completed", at: at(4), runId, nodeId: "node", agentSessionId: null, diagnostic: null, resultPath: "nodes/node/result.json", result: { ok: true } })).toThrow("已终态");
  });
});
