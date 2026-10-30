import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
import { RunJournal } from "../../src/journal/run-journal";
import { RunRuntime } from "../../src/runtime/run-runtime";
import type { ControlServer } from "../../src/control/control-server";
import type { AgentNodeExecutor } from "../../src/runtime/run-types";
import type { ExecutionConfigSnapshot, WorkerAssignment } from "../../src/harness/types";
import type { RuntimeProvenance } from "../../src/runtimes/types";
import type { JsonObject } from "../../src/shared/json";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import { agent, phase } from "../../src/workflow/author-api";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const single: WorkflowModule<JsonObject, unknown> = {
  meta: { name: "exec-config", description: "执行配置消费。", phases: [{ title: "run" }] },
  default: async () => { phase("run"); return agent("work", { id: "worker", cli: "codex" }); },
};

/** 两节点 Workflow：a 先完成，b 的结果决定 Run 是否到达终态；resume 复用语义在 a 上验证。 */
const twoNodes: WorkflowModule<JsonObject, unknown> = {
  meta: single.meta,
  default: async () => { phase("run"); const a = await agent("first", { id: "a", cli: "codex" }); const b = await agent("second", { id: "b", cli: "codex" }); return { a, b }; },
};

/** 测试分配快照；默认指派 kimi 的 assigned-runtime，覆盖脚本字面量 codex。 */
type AssignedConfig = Extract<ExecutionConfigSnapshot, { fallbackRuntimeId: string }>;
function testConfig(runtimeId = "assigned-runtime", adapterVersion = "1.0"): AssignedConfig {
  const assignment = (agentId: string): WorkerAssignment => ({ agentId, cli: "kimi", model: "cli-default", source: "harness-cli", runtimeId, adapterId: "kimi-acp", adapterVersion });
  return { version: 1, createdAt: new Date().toISOString(), fallbackRuntimeId: runtimeId, ruleText: null, ruleDegraded: false, defaultAssignment: assignment("*"), assignments: [assignment("worker"), assignment("a"), assignment("b")] };
}

async function create(executor: AgentNodeExecutor, module: WorkflowModule<JsonObject, unknown>, config: ExecutionConfigSnapshot): Promise<RunRuntime> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-exec-config-")); directories.push(cwd);
  const workflowPath = join(cwd, "workflow.ts"); await writeFile(workflowPath, "workflow", "utf8");
  return RunRuntime.create({ workflow: module, input: {}, workflowSource: "workflow", clientRequestId: crypto.randomUUID(), workflowProjectCwd: cwd, workflowPath, storeRoot: runsRoot(join(cwd, "store")), executor, executionConfig: config });
}

function storeRootOf(runtime: RunRuntime): string { return join(runtime.journal.directory, ".."); }

/** a 节点完成并（可选）耐久 ACP provenance；b 节点按 failOnB 收敛 Run 为 interrupted。 */
function twoNodeExecutor(options: { readonly provenance?: RuntimeProvenance; readonly failOnB: boolean }, controlRef: { current: ControlServer | null }, executed: string[]): AgentNodeExecutor {
  return {
    execute: async (node) => {
      executed.push(node.id);
      if (node.id === "b" && options.failOnB) return null;
      if (options.provenance) {
        const control = controlRef.current!;
        const capability = crypto.randomUUID();
        control.register({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability });
        await control.recordSession({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, delivery: "acp", acp: { launcherId: "test", sessionId: "s", capabilities: {}, runtime: options.provenance } });
        await control.complete({ runId: control.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability, summary: "完成", result: { ok: node.id } });
      }
      return { ok: node.id };
    },
  };
}

function provenanceOf(runtimeId: string): RuntimeProvenance {
  return { runtimeId, cli: "kimi", executablePath: "/usr/local/bin/kimi", version: "kimi 2.1.1", adapterId: "kimi-acp", adapterVersion: "1.0", verifiedAt: new Date().toISOString() };
}

describe("RunRuntimeHost 分配快照消费", () => {
  test("生效请求改写先于 agent.created 落盘：cli 被覆盖、model 省略、assignedRuntimeId 进入 Journal", async () => {
    const runtime = await create({ execute: async () => ({ ok: true }) }, single, testConfig());
    await expect(runtime.run(single)).resolves.toEqual({ ok: true });
    const node = runtime.snapshot().phases[0].agents[0];
    expect(node.cli).toBe("kimi");
    expect(node.request).toMatchObject({ id: "worker", cli: "kimi", assignedRuntimeId: "assigned-runtime" });
    expect(node.request.model).toBeUndefined();
    const reopened = await RunJournal.open(runtime.snapshot().id, storeRootOf(runtime));
    const created = reopened.events.find((event) => event.type === "agent.created");
    expect(created).toMatchObject({ request: { cli: "kimi", assignedRuntimeId: "assigned-runtime" } });
  });

  test("未命中 assignments 的节点落 defaultAssignment", async () => {
    const dynamic: WorkflowModule<JsonObject, unknown> = {
      meta: single.meta,
      default: async () => { phase("run"); await agent("甲", { id: "a", cli: "codex" }); return agent("动态", { id: "dynamic-worker", cli: "codex" }); },
    };
    const config = testConfig();
    const runtime = await create({ execute: async () => ({ ok: true }) }, dynamic, config);
    await runtime.run(dynamic);
    const agents = runtime.snapshot().phases[0].agents;
    expect(agents.map((item) => item.request.assignedRuntimeId)).toEqual([config.assignments[1].runtimeId, config.defaultAssignment.runtimeId]);
  });

  test("replay 同快照复用 completed 前缀；快照变化因指纹不匹配拒绝复用", async () => {
    const controlRef = { current: null as ControlServer | null };
    const executed: string[] = [];
    const initial = await create(twoNodeExecutor({ failOnB: true }, controlRef, executed), twoNodes, testConfig());
    await initial.run(twoNodes).catch(() => undefined);
    expect(initial.snapshot().status).toBe("interrupted");
    expect(initial.snapshot().phases[0].agents.map((node) => `${node.id}:${node.status}`)).toEqual(["a:completed", "b:interrupted"]);
    // 分配变化（不同 runtimeId）改变生效请求指纹：resume 必须拒绝而不是静默换 Runtime 复用。
    // 该拒绝不写任何新事实，Run 仍是 interrupted，后续同快照 resume 不受影响。
    const changed = await RunRuntime.resume(initial.snapshot().id, { execute: async () => ({ ok: true }) }, storeRootOf(initial), testConfig("another-runtime"));
    await expect(changed.run(twoNodes)).rejects.toThrow("与 Journal 节点不匹配");
    let reopened = await RunJournal.open(initial.snapshot().id, storeRootOf(initial));
    expect(reopened.events.some((event) => event.type === "agent.restarted")).toBe(false);
    executed.length = 0;
    // 同一快照 resume：completed 的 a 直接复用，只有 b 重新执行。
    const reused = await RunRuntime.resume(initial.snapshot().id, twoNodeExecutor({ failOnB: false }, controlRef, executed), storeRootOf(initial), testConfig());
    await expect(reused.run(twoNodes)).resolves.toEqual({ a: { ok: "a" }, b: { ok: "b" } });
    expect(executed).toEqual(["b"]);
    expect(reused.snapshot()).toMatchObject({ status: "completed", currentExecutionAttemptId: 2 });
    reopened = await RunJournal.open(initial.snapshot().id, storeRootOf(initial));
    expect(reopened.events.filter((event) => event.type === "agent.restarted")).toHaveLength(1);
  });

  test("provenance 与分配快照不匹配时不复用 completed 节点，从它开始新 attempt", async () => {
    // 首个 attempt 的 a 实际落在回退 Runtime 上（启动前回退），但分配快照未变。
    const controlRef = { current: null as ControlServer | null };
    const executed: string[] = [];
    const initial = await create(twoNodeExecutor({ provenance: provenanceOf("fallback-runtime"), failOnB: true }, controlRef, executed), twoNodes, testConfig());
    controlRef.current = initial.createControlServer();
    await initial.run(twoNodes).catch(() => undefined);
    expect(initial.snapshot().status).toBe("interrupted");
    expect(initial.snapshot().phases[0].agents.map((node) => `${node.id}:${node.status}`)).toEqual(["a:completed", "b:interrupted"]);
    executed.length = 0;
    // 同一快照 resume：指纹一致，但 a 的已耐久 provenance 是 fallback-runtime 而非
    // assigned-runtime——旧结果不可复用，a 重启为新 attempt 并失效下游。
    const resumed = await RunRuntime.resume(initial.snapshot().id, twoNodeExecutor({ failOnB: false }, controlRef, executed), storeRootOf(initial), testConfig());
    await expect(resumed.run(twoNodes)).resolves.toEqual({ a: { ok: "a" }, b: { ok: "b" } });
    expect(executed).toEqual(["a", "b"]);
    expect(resumed.snapshot()).toMatchObject({ status: "completed", currentExecutionAttemptId: 2 });
    const reopened = await RunJournal.open(initial.snapshot().id, storeRootOf(initial));
    expect(reopened.events.some((event) => event.type === "agent.restarted" && event.nodeId === "a" && event.invalidatedByPriorRestart === true)).toBe(true);
  });

  test("provenance 与分配快照一致时正常复用", async () => {
    const controlRef = { current: null as ControlServer | null };
    const executed: string[] = [];
    const initial = await create(twoNodeExecutor({ provenance: provenanceOf("assigned-runtime"), failOnB: true }, controlRef, executed), twoNodes, testConfig());
    controlRef.current = initial.createControlServer();
    await initial.run(twoNodes).catch(() => undefined);
    executed.length = 0;
    const resumed = await RunRuntime.resume(initial.snapshot().id, twoNodeExecutor({ failOnB: false }, controlRef, executed), storeRootOf(initial), testConfig());
    await expect(resumed.run(twoNodes)).resolves.toEqual({ a: { ok: "a" }, b: { ok: "b" } });
    expect(executed).toEqual(["b"]);
    expect(resumed.snapshot()).toMatchObject({ status: "completed", currentExecutionAttemptId: 2 });
  });
});

/**
 * 执行级 CLI 选择：作者可以省略 `cli`，由本次执行在启动前选定；它必须进入生效请求与
 * Journal，才能让 Replay 指纹随后续选择变化，而不是把"省略"当成某个隐式默认。
 */
describe("RunRuntimeHost 执行级 CLI 选择", () => {
  const scriptConfig = (cli: "codex" | "claude" | "dsh"): ExecutionConfigSnapshot => ({ version: 1, assignmentMode: "script", createdAt: new Date().toISOString(), cli });
  const portable: WorkflowModule<JsonObject, unknown> = {
    meta: { name: "portable", description: "可移植模块", phases: [{ title: "run" }] },
    default: async () => { phase("run"); return agent("work", { id: "worker" }); },
  };

  test("省略 cli 时使用本次执行的选择，并作为生效 cli 落入 Journal", async () => {
    const runtime = await create({ execute: async () => ({ ok: true }) }, portable, scriptConfig("claude"));
    await expect(runtime.run(portable)).resolves.toEqual({ ok: true });
    const node = runtime.snapshot().phases[0].agents[0];
    expect(node.cli).toBe("claude");
    expect(node.request.cli).toBe("claude");
    const reopened = await RunJournal.open(runtime.snapshot().id, storeRootOf(runtime));
    expect(reopened.events.find((event) => event.type === "agent.created")).toMatchObject({ request: { cli: "claude" } });
  });

  test("逐节点选择：同一份模块的两个节点可以跑在不同 CLI 上", async () => {
    const twoPortable: WorkflowModule<JsonObject, unknown> = {
      meta: { name: "portable-two", description: "两个可移植节点", phases: [{ title: "run" }] },
      default: async () => { phase("run"); const a = await agent("甲", { id: "a" }); const b = await agent("乙", { id: "b" }); return { a, b }; },
    };
    const config: ExecutionConfigSnapshot = { version: 1, assignmentMode: "script", createdAt: new Date().toISOString(), nodeClis: { a: "claude", b: "dsh" } };
    const runtime = await create({ execute: async node => ({ ok: node.cli }) }, twoPortable, config);
    await expect(runtime.run(twoPortable)).resolves.toEqual({ a: { ok: "claude" }, b: { ok: "dsh" } });
    const agents = runtime.snapshot().phases[0].agents;
    expect(agents.map(node => `${node.id}:${node.cli}`)).toEqual(["a:claude", "b:dsh"]);
    const reopened = await RunJournal.open(runtime.snapshot().id, storeRootOf(runtime));
    expect(reopened.events.filter(event => event.type === "agent.created").map(event => (event as { request: { cli: string } }).request.cli)).toEqual(["claude", "dsh"]);
  });

  test("源码字面量优先：执行级选择不覆盖写死的 cli", async () => {
    const runtime = await create({ execute: async () => ({ ok: true }) }, single, scriptConfig("claude"));
    await runtime.run(single);
    expect(runtime.snapshot().phases[0].agents[0]).toMatchObject({ cli: "codex", request: { cli: "codex" } });
  });

  test("既没有字面量也没有执行级选择时，在任何 Journal 事实与 Worker 之前拒绝", async () => {
    const executed: string[] = [];
    const runtime = await create({ execute: async (node) => { executed.push(node.id); return { ok: true }; } }, portable, { version: 1, assignmentMode: "script", createdAt: new Date().toISOString() });
    await expect(runtime.run(portable)).rejects.toThrow("未声明 cli");
    // 契约错误发生在节点创建前：没有启动任何执行器，也没有 agent.created 事实。
    expect(executed).toEqual([]);
    const reopened = await RunJournal.open(runtime.snapshot().id, storeRootOf(runtime));
    expect(reopened.events.some((event) => event.type === "agent.created")).toBe(false);
  });

  test("恢复沿用同一执行级选择：省略 cli 的节点在新 attempt 仍能解析", async () => {
    const executed: string[] = [];
    const initial = await create({ execute: async (node) => { executed.push(node.id); return node.id === "worker" ? null : { ok: true }; } }, portable, scriptConfig("dsh"));
    await initial.run(portable).catch(() => undefined);
    // 首个 attempt 的节点未完成；resume 必须带上同一选择才能重放脚本。
    const resumed = await RunRuntime.resume(initial.snapshot().id, { execute: async (node) => { executed.push(node.id); return { ok: node.id }; } }, storeRootOf(initial), scriptConfig("dsh"));
    await expect(resumed.run(portable)).resolves.toEqual({ ok: "worker" });
    expect(resumed.snapshot().phases[0].agents[0].cli).toBe("dsh");
  });
});
