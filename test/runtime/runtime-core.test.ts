import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RunRuntime } from "../../src/runtime/run-runtime";
import type { AgentNodeExecutor } from "../../src/runtime/run-types";
import type { JsonObject } from "../../src/shared/json";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import { agent, phase } from "../../src/workflow/author-api";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const workflow: WorkflowModule<JsonObject, unknown> = { meta: { name: "runtime-core", description: "Runtime core.", phases: [{ title: "run" }] }, default: async () => { phase("run"); return agent("work", { id: "worker", cli: "codex" }); } };
async function create(executor: AgentNodeExecutor): Promise<RunRuntime> { const cwd = await mkdtemp(join(tmpdir(), "wave-flow-runtime-core-")); directories.push(cwd); const workflowPath = join(cwd, "workflow.ts"); await writeFile(workflowPath, "workflow", "utf8"); return RunRuntime.create({ workflow, input: {}, workflowSource: "workflow", clientRequestId: crypto.randomUUID(), workflowProjectCwd: cwd, workflowPath, storeRoot: runsRoot(join(cwd, "store")), executor }); }

describe("RunRuntime ACP-neutral core", () => {
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
    const blockFailure = control.block({ runId: runtime.snapshot().id, nodeId: "worker", agentSessionId, capability: "cap-1", blockRequestId: crypto.randomUUID(), needHelp: "需要确认" }).then(() => null, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
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
});
