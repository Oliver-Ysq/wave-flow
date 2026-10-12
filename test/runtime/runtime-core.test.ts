import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsRoot } from "../../src/journal/paths";
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
});
