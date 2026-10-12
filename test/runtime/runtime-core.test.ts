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
});
