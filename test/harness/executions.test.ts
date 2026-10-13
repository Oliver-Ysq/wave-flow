import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessExecutionService } from "../../src/harness/executions";
import { HarnessService } from "../../src/harness/service";
import type { ResolvedHarnessModelConfig } from "../../src/harness/config";
import type { HarnessPiSession } from "../../src/harness/pi-harness";
import { DeterministicExecutor } from "../../src/runtime/deterministic-executor";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const model: ResolvedHarnessModelConfig = { model: "test-model", baseUrl: "http://127.0.0.1:9", apiKey: "test-key" };
const createPi = (): HarnessPiSession => { throw new Error("测试不创建真实 Pi 会话。 "); };

async function fixture(): Promise<{ harness: HarnessService; executions: HarnessExecutionService; harnessRunId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-execution-"));
  directories.push(root);
  const harness = new HarnessService(root, async () => model, createPi);
  const executions = new HarnessExecutionService(harness, () => ({ executor: new DeterministicExecutor() }), {}, root);
  const created = await harness.create(root);
  return { harness, executions, harnessRunId: created.harnessRunId, root };
}

const SIMPLE_SOURCE = `const meta = { name: "exec-simple", description: "简单执行", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  const done = await agent("完成任务", { id: "w1", cli: "codex" });
  return { ok: true, node: done.nodeId, note: args.note ?? null };
}`;

const GATE_SOURCE = `const meta = { name: "exec-gate", description: "带决策门", phases: [{ title: "工作" }] };
async function run(args) {
  phase("工作");
  await agent("第一阶段", { id: "w1", cli: "codex" });
  const answer = await decisionGate({ id: "confirm", question: "是否进入第二阶段？" });
  if (!answer.ok) throw new Error("用户拒绝");
  return agent("第二阶段", { id: "w2", cli: "codex" });
}`;

async function waitFor(condition: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("等待条件超时。 ");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("HarnessExecutionService", () => {
  test("草稿与未接受 revision 永远不能创建 Execution", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await expect(executions.createExecution(harnessRunId, 1)).rejects.toThrow("草稿永远不能执行");
    await expect(executions.createExecution(harnessRunId, 99)).rejects.toThrow("revision 不存在");
    expect(await executions.listExecutions(harnessRunId)).toEqual([]);
  });

  test("不可编译脚本在提案时即被拒绝，不存在可创建 Execution 的 revision", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await expect(harness.proposeWorkflowRevision(harnessRunId, `const meta = { name: "bad", description: "坏脚本", phases: [{ title: "工作" }] };\nasync function run(args) { return process.cwd(); }`)).rejects.toThrow("未注入的标识符：process");
    expect((await harness.snapshot(harnessRunId)).workflowRevisions).toEqual([]);
    await expect(executions.createExecution(harnessRunId, 1)).rejects.toThrow("revision 不存在");
    expect(await executions.listExecutions(harnessRunId)).toEqual([]);
  });

  test("接受冻结后创建 Execution，完成后登记终态与摘要", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution, snapshot } = await executions.createExecution(harnessRunId, 1, { note: "来自用户" });
    expect(execution).toMatchObject({ revision: 1, status: "running", finishedAt: null });
    expect(snapshot.workflow.name).toBe("exec-simple");
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    const [finished] = await executions.listExecutions(harnessRunId);
    expect(finished).toMatchObject({ status: "completed", summary: { ok: true, node: "w1", note: "来自用户" } });
    const detail = await executions.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.status).toBe("completed");
    expect(detail.phases[0].agents[0]).toMatchObject({ id: "w1", status: "completed" });
  });

  test("一个 Harness 顺序拥有多个 Execution：活跃期拒绝新执行", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1);
    // 第一个 Execution 停在决策门上，未达终态。
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    await expect(executions.createExecution(harnessRunId, 1)).rejects.toThrow("未结束");
    await executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
    // 终态后新 revision 可以创建下一个 Execution。
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 2);
    const second = await executions.createExecution(harnessRunId, 2);
    expect(second.execution.revision).toBe(2);
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[1]?.status === "completed");
    expect((await executions.listExecutions(harnessRunId)).map((item) => item.status)).toEqual(["completed", "completed"]);
  });

  test("并发创建只登记首个 Execution，拒绝请求不会留下孤儿嵌套 Run", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const results = await Promise.allSettled([
      executions.createExecution(harnessRunId, 1),
      executions.createExecution(harnessRunId, 1),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await executions.listExecutions(harnessRunId)).toHaveLength(1);
    expect(await readdir(join(root, harnessRunId, "executions"))).toHaveLength(1);
  });

  test("stop 是终态并拒绝 pending 决策门；离线 Execution 不可控制", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1);
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    const stopped = await executions.stop(harnessRunId, execution.executionId);
    expect(stopped.status).toBe("cancelled");
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "cancelled");
    await expect(executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true })).rejects.toThrow("可控制生命周期");
  });

  test("daemon 重启后只读还原登记事实，显式 resume 以新 attempt 继续未答 gate", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1);
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);

    // 模拟 daemon 重启：全新服务实例，没有任何内存 Runtime。
    let executions2Count = 0;
    const harness2 = new HarnessService(root, async () => model, createPi);
    const executions2 = new HarnessExecutionService(harness2, () => ({ executor: { execute: async () => { executions2Count += 1; return { n: executions2Count }; } } }), {}, root);
    const records = await executions2.listExecutions(harnessRunId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("running");
    await expect(executions2.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true })).rejects.toThrow("可控制生命周期");

    // 显式 resume：w1 复用 completed 结果，已创建的 gate 不重复落盘，等待原 gate 答案。
    const resumed = await executions2.resume(harnessRunId, execution.executionId);
    expect(resumed.status).toBe("running");
    await executions2.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await executions2.listExecutions(harnessRunId))[0].status === "completed");
    const detail = await executions2.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.gates).toHaveLength(1);
    // w1 在尝试 #1 已完成并被复用；答题后新建的 w2 属于新尝试 #2。
    expect(detail.currentExecutionAttemptId).toBe(2);
    expect(executions2Count).toBe(1);
    expect(detail.phases[0].agents.map((agent) => `${agent.id}:${agent.status}`)).toEqual(["w2:completed"]);
  });

  test("Execution 档案嵌套在 Harness 档案内并携带 harness 来源绑定", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1);
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    const manifest = JSON.parse(await Bun.file(join(root, harnessRunId, "executions", execution.executionId, "manifest.json")).text()) as { harness?: { harnessRunId: string; revision: number; sourceHash: string } };
    expect(manifest.harness).toMatchObject({ harnessRunId, revision: 1, sourceHash: execution.sourceHash });
    const source = await Bun.file(join(root, harnessRunId, "executions", execution.executionId, "source.ts")).text();
    expect(source).toBe(SIMPLE_SOURCE);
  });
});
