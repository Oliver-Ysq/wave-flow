import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRuntime } from "../../src/runtime/run-runtime";
import { RunJournal } from "../../src/journal/run-journal";
import { agent, parallel, phase, pipeline } from "../../src/workflow/author-api";
import { WorkflowContractError } from "../../src/workflow/errors";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import type { JsonObject } from "../../src/shared/json";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const meta = { name: "result-ready", description: "成果交接验证", phases: [{ title: "run" }] };
async function create(workflow: WorkflowModule<JsonObject, unknown>, finalize: () => Promise<void>) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-ready-test-"))); directories.push(cwd);
  const workflowPath = join(cwd, "workflow.ts"); await writeFile(workflowPath, "workflow");
  return RunRuntime.create({ workflow, input: {}, workflowSource: "workflow", workflowPath, workflowProjectCwd: cwd, clientRequestId: crypto.randomUUID(), storeRoot: join(cwd, "runs"), executor: { execute: async () => ({ ok: true }), finalizeCompleted: finalize } });
}
test("业务complete耐久后等待成果ready再向脚本返回，JSON Schema不改变", async () => {
  let release!: () => void, started!: () => void, downstream = false;
  const ready = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const workflow: WorkflowModule<JsonObject, unknown> = { meta, default: async () => { phase("run"); const value = await agent("work", { id: "a", cli: "codex" }); downstream = true; return value; } };
  const runtime = await create(workflow, async () => { started(); await ready; });
  const running = runtime.run(workflow); await entered;
  expect(runtime.snapshot().phases[0].agents[0].status).toBe("completed"); expect(downstream).toBe(false); expect(runtime.snapshot().status).toBe("running");
  release(); expect(await running).toEqual({ ok: true }); expect(downstream).toBe(true);
});
for (const mode of ["parallel", "pipeline"] as const) test(`${mode}不得吞掉成果保存契约错误；completed保持且原版resume只补收尾`, async () => {
  let calls = 0;
  const invoke = () => agent("work", { id: "a", cli: "codex" });
  const workflow: WorkflowModule<JsonObject, unknown> = { meta, default: async () => { phase("run"); return mode === "parallel" ? parallel([invoke]) : pipeline([0], invoke); } };
  const runtime = await create(workflow, async () => { calls++; throw new WorkflowContractError("Git成果保存失败"); });
  await expect(runtime.run(workflow)).rejects.toThrow("Git成果保存失败");
  expect(runtime.snapshot().status).toBe("interrupted"); expect(runtime.snapshot().phases[0].agents[0].status).toBe("completed");
  let executions = 0, finalized = 0;
  const root = join(runtime.journal.directory, "..");
  const resumed = await RunRuntime.resume(runtime.snapshot().id, { execute: async () => { executions++; return { invalid: true }; }, finalizeCompleted: async () => { finalized++; } }, root);
  expect(await resumed.run(workflow)).toEqual([{ ok: true }]); expect(executions).toBe(0); expect(finalized).toBe(1); expect(calls).toBe(1);
  const { events } = await RunJournal.open(runtime.snapshot().id, root);
  expect(events.filter(event => event.type === "agent.restarted")).toHaveLength(0);
});