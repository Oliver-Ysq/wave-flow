import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessExecutionService } from "../../src/harness/executions";
import { HarnessJournal } from "../../src/harness/journal";
import { RunJournal } from "../../src/journal/run-journal";
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

/** 测试冻结配置；服务层不核对 runtimeId 真实性（那是 Engine action 的职责）。 */
function testConfig(): import("../../src/harness/types").ExecutionConfigSnapshot {
  const assignment = (agentId: string): import("../../src/harness/types").WorkerAssignment => ({ agentId, cli: "codex", model: "cli-default", source: "harness-cli", runtimeId: "test-runtime", adapterId: "codex-acp", adapterVersion: "0.0.0-test" });
  return { version: 1, createdAt: new Date().toISOString(), fallbackRuntimeId: "test-runtime", ruleText: null, ruleDegraded: false, defaultAssignment: assignment("*"), assignments: [assignment("w1"), assignment("w2")] };
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
    await expect(executions.createExecution(harnessRunId, 1, {}, testConfig())).rejects.toThrow("草稿永远不能执行");
    await expect(executions.createExecution(harnessRunId, 99)).rejects.toThrow("revision 不存在");
    expect(await executions.listExecutions(harnessRunId)).toEqual([]);
  });

  test("不可编译脚本在提案时即被拒绝，不存在可创建 Execution 的 revision", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await expect(harness.proposeWorkflowRevision(harnessRunId, `const meta = { name: "bad", description: "坏脚本", phases: [{ title: "工作" }] };\nasync function run(args) { return process.cwd(); }`)).rejects.toThrow("未注入的标识符：process");
    expect((await harness.snapshot(harnessRunId)).workflowRevisions).toEqual([]);
    await expect(executions.createExecution(harnessRunId, 1, {}, testConfig())).rejects.toThrow("revision 不存在");
    expect(await executions.listExecutions(harnessRunId)).toEqual([]);
  });

  test("无配置快照的 Harness Execution 拒绝创建", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    await expect(executions.createExecution(harnessRunId, 1)).rejects.toThrow("执行配置快照");
    expect(await executions.listExecutions(harnessRunId)).toEqual([]);
  });

  test("配置快照随登记耐久并在生效请求中改写 cli 与 assignedRuntimeId", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    const reopened = await HarnessJournal.open(harnessRunId, root);
    expect(reopened.snapshot.executions[0].config).toMatchObject({ version: 1, fallbackRuntimeId: "test-runtime", ruleDegraded: false });
    // Journal 记录的是生效请求：脚本字面量 cli 被快照指派覆盖，assignedRuntimeId 进入指纹。
    const detail = await executions.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.phases[0].agents[0].request).toMatchObject({ id: "w1", cli: "codex", assignedRuntimeId: "test-runtime" });
  });

  test("接受冻结后创建 Execution，完成后登记终态与摘要", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution, snapshot } = await executions.createExecution(harnessRunId, 1, { note: "来自用户" }, testConfig());
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
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    // 第一个 Execution 停在决策门上，未达终态。
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    await expect(executions.createExecution(harnessRunId, 1, {}, testConfig())).rejects.toThrow("未结束");
    await executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
    // 终态后新 revision 可以创建下一个 Execution。
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 2);
    const second = await executions.createExecution(harnessRunId, 2, {}, testConfig());
    expect(second.execution.revision).toBe(2);
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[1]?.status === "completed");
    expect((await executions.listExecutions(harnessRunId)).map((item) => item.status)).toEqual(["completed", "completed"]);
  });

  test("并发创建只登记首个 Execution，拒绝请求不会留下孤儿嵌套 Run", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const results = await Promise.allSettled([
      executions.createExecution(harnessRunId, 1, {}, testConfig()),
      executions.createExecution(harnessRunId, 1, {}, testConfig()),
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
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    const stopped = await executions.stop(harnessRunId, execution.executionId);
    expect(stopped.status).toBe("cancelled");
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "cancelled");
    await expect(executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true })).rejects.toThrow("可控制生命周期");
  });

  test("退出与 settle 并发登记终态只写一条 execution_finished，Journal 可重开", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    // 退出路径与后台 settle 会同时尝试登记终态；第二条 execution_finished
    // 会让 Journal 重放永久失败，因此必须幂等。
    await executions.cancelForDesktopExit("exit-engine");
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reopened = await HarnessJournal.open(harnessRunId, root);
    const finished = reopened.events.filter((event) => event.type === "workflow.execution_finished" && event.executionId === execution.executionId);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: "cancelled", diagnostic: "退出 Wave Flow 时停止。 " });
    expect(reopened.snapshot.executions[0]).toMatchObject({ status: "cancelled" });
  });

  test("recordExecutionFinished 对已终态 Execution 幂等，不产生重复事实", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    await harness.recordExecutionFinished(harnessRunId, execution.executionId, "cancelled", "迟到的重复登记。 ", null);
    const reopened = await HarnessJournal.open(harnessRunId, root);
    const finished = reopened.events.filter((event) => event.type === "workflow.execution_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: "completed" });
    expect(reopened.snapshot.executions[0]).toMatchObject({ status: "completed" });
  });

  test("blocked Worker 的 Execution 在退出时收敛为 cancelled 且可显式 resume", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    await executions.cancelForDesktopExit("exit-engine");
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    expect((await executions.listExecutions(harnessRunId))[0].status).toBe("cancelled");
    await executions.resume(harnessRunId, execution.executionId);
    await executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
    expect((await executions.snapshotExecution(harnessRunId, execution.executionId)).currentExecutionAttemptId).toBe(2);
    const reopened = await HarnessJournal.open(harnessRunId, root);
    expect(reopened.snapshot.executions[0]).toMatchObject({ status: "completed" });
  });

  test("用户取消的 Execution 可显式 resume 为新 attempt", async () => {
    const { harness, executions, harnessRunId } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);
    await executions.stop(harnessRunId, execution.executionId);
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "cancelled");
    await expect(executions.resume(harnessRunId, execution.executionId)).resolves.toMatchObject({ status: "cancelled" });
    await executions.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
    expect((await executions.snapshotExecution(harnessRunId, execution.executionId)).currentExecutionAttemptId).toBe(2);
  });

  test("Engine 重启后只读还原登记事实，显式 resume 以新 attempt 继续未答 gate", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);

    // 模拟 Engine 重启：全新服务实例，没有任何内存 Runtime。
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

  test("Engine 重启时遗留的 active Execution 必须收敛为 interrupted，不能伪装为工作中", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);

    const restartedHarness = new HarnessService(root, async () => model, createPi);
    const restarted = new HarnessExecutionService(restartedHarness, () => ({ executor: new DeterministicExecutor() }), {}, root);
    await restarted.convergeStaleExecutions(harnessRunId);
    await expect(restarted.listExecutions(harnessRunId)).resolves.toMatchObject([
      { executionId: execution.executionId, status: "interrupted", finishedAt: expect.any(String), diagnostic: expect.stringContaining("不可跨进程认领") },
    ]);
    await expect(restarted.snapshotExecution(harnessRunId, execution.executionId)).resolves.toMatchObject({ status: "interrupted" });
    const detail = await restarted.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.phases.flatMap((phase) => phase.agents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "w1", status: "completed" }),
    ]));
    expect(detail.phases.flatMap((phase) => phase.agents).every((node) => node.status !== "running" && node.status !== "blocked")).toBe(true);
  });

  test("重启收敛为 interrupted 后，用户仍可显式 resume 创建新 attempt", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);

    let resumedNodes = 0;
    const restartedHarness = new HarnessService(root, async () => model, createPi);
    const restarted = new HarnessExecutionService(restartedHarness, () => ({ executor: { execute: async () => ({ n: ++resumedNodes }) } }), {}, root);
    await restarted.convergeStaleExecutions(harnessRunId);
    // interrupted 的 running 事实由首个重放节点通过调用指纹校验后才写入；resume
    // 返回时可以仍是 interrupted，但后台重放必须实际创建 attempt #2。
    await expect(restarted.resume(harnessRunId, execution.executionId)).resolves.toMatchObject({ status: "interrupted", currentExecutionAttemptId: 1 });
    await restarted.answerGate(harnessRunId, execution.executionId, "confirm", { ok: true });
    await waitFor(async () => (await restarted.listExecutions(harnessRunId))[0].status === "completed");
    const detail = await restarted.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.currentExecutionAttemptId).toBe(2);
    expect(resumedNodes).toBe(1);
  });

  test("损坏的嵌套 Execution 不阻止后续 active Execution 在重启时收敛", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const first = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].status === "completed");
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 2);
    const second = await executions.createExecution(harnessRunId, 2, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, second.execution.executionId)).gates.length === 1);
    await Bun.write(join(root, harnessRunId, "executions", first.execution.executionId, "manifest.json"), "{}\n");

    const restartedHarness = new HarnessService(root, async () => model, createPi);
    const restarted = new HarnessExecutionService(restartedHarness, () => ({ executor: new DeterministicExecutor() }), {}, root);
    await restarted.convergeStaleExecutions(harnessRunId);
    await expect(restarted.listExecutions(harnessRunId)).resolves.toMatchObject([
      { executionId: first.execution.executionId, status: "completed" },
      { executionId: second.execution.executionId, status: "interrupted", finishedAt: expect.any(String) },
    ]);
  });

  test("升级时为已中断 Execution 补齐遗留 active 节点，不改写其终态", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, GATE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).gates.length === 1);

    // 模拟旧版本只写顶层 run.status，却漏掉旧 ACP 节点收敛的历史档案。
    const oldRuntime = await executions.snapshotExecution(harnessRunId, execution.executionId);
    const journalPath = join(root, harnessRunId, "executions", execution.executionId, "journal.jsonl");
    await Bun.write(journalPath, `${await Bun.file(journalPath).text()}${JSON.stringify({ type: "run.status", at: new Date().toISOString(), runId: execution.executionId, nodeId: null, agentSessionId: null, diagnostic: "旧版本中断", status: "interrupted" })}\n`);
    expect(oldRuntime.status).toBe("running");

    const restartedHarness = new HarnessService(root, async () => model, createPi);
    const restarted = new HarnessExecutionService(restartedHarness, () => ({ executor: new DeterministicExecutor() }), {}, root);
    await restarted.convergeStaleExecutions(harnessRunId);
    const detail = await restarted.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail.status).toBe("interrupted");
    expect(detail.phases.flatMap((phase) => phase.agents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "w1", status: "completed" }),
    ]));
    expect(detail.phases.flatMap((phase) => phase.agents).every((node) => node.status !== "running" && node.status !== "blocked")).toBe(true);
  });

  test("Execution 档案嵌套在 Harness 档案内并携带 harness 来源绑定", async () => {
    const { harness, executions, harnessRunId, root } = await fixture();
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.listExecutions(harnessRunId))[0].finishedAt !== null);
    const manifest = JSON.parse(await Bun.file(join(root, harnessRunId, "executions", execution.executionId, "manifest.json")).text()) as { harness?: { harnessRunId: string; revision: number; sourceHash: string } };
    expect(manifest.harness).toMatchObject({ harnessRunId, revision: 1, sourceHash: execution.sourceHash });
    const source = await Bun.file(join(root, harnessRunId, "executions", execution.executionId, "source.ts")).text();
    expect(source).toBe(SIMPLE_SOURCE);
  });

  test("旧档案遗留 blocked 节点 + 终态 Run：显式 resume 先收敛节点再创建新 attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-execution-"));
    directories.push(root);
    const harness = new HarnessService(root, async () => model, createPi);
    const created = await harness.create(root);
    const harnessRunId = created.harnessRunId;
    // 第一份 Engine：Worker 请求人工确认进入 blocked 后永不返回（真实故障中它以
    // end_turn 结束回合且不上报 complete/continue）。
    let control: import("../../src/control/control-server").ControlServer | null = null;
    let runtimeRef: import("../../src/runtime/run-runtime").RunRuntime | null = null;
    const executions = new HarnessExecutionService(harness, () => ({
      executor: {
        execute: async (node) => {
          const runId = runtimeRef!.snapshot().id;
          control!.register({ runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability: "cap-1" });
          await control!.recordSession({ runId, nodeId: node.id, agentSessionId: node.agentSessionId!, delivery: "acp", acp: { launcherId: "test", sessionId: "s", capabilities: {} } });
          void control!.block({ runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability: "cap-1", blockRequestId: crypto.randomUUID(), needHelp: "需要确认" }).then(() => null, () => null);
          return new Promise<never>(() => {});
        },
      },
    }), { wireControl: (runtime) => { runtimeRef = runtime; control = runtime.createControlServer(); } }, root);
    await harness.proposeWorkflowRevision(harnessRunId, SIMPLE_SOURCE);
    await harness.acceptWorkflowRevision(harnessRunId, 1);
    const { execution } = await executions.createExecution(harnessRunId, 1, {}, testConfig());
    await waitFor(async () => (await executions.snapshotExecution(harnessRunId, execution.executionId)).phases[0]?.agents[0]?.status === "blocked");

    // 模拟旧版本缺陷留下的损坏档案：只写 Run 终态，漏掉 blocked 节点的收敛。
    const journalPath = join(root, harnessRunId, "executions", execution.executionId, "journal.jsonl");
    await Bun.write(journalPath, `${await Bun.file(journalPath).text()}${JSON.stringify({ type: "run.status", at: new Date().toISOString(), runId: execution.executionId, nodeId: null, agentSessionId: null, diagnostic: "Error: ACP Worker turn 已结束（end_turn），但未收到 wave-flow complete。", status: "interrupted" })}\n`);
    await harness.recordExecutionFinished(harnessRunId, execution.executionId, "interrupted", "Error: ACP Worker turn 已结束（end_turn），但未收到 wave-flow complete。", null);

    // 全新 Engine（不做启动收敛），直接显式 resume：必须先收敛僵尸 blocked 节点，
    // 再由 replay 创建新 attempt 重跑，而不是 2ms 内以旧诊断再次 finished。
    let executed = 0;
    const harness2 = new HarnessService(root, async () => model, createPi);
    const executions2 = new HarnessExecutionService(harness2, () => ({ executor: { execute: async () => ({ n: ++executed }) } }), {}, root);
    await executions2.resume(harnessRunId, execution.executionId);
    await waitFor(async () => (await executions2.listExecutions(harnessRunId))[0].status === "completed");
    const detail = await executions2.snapshotExecution(harnessRunId, execution.executionId);
    expect(detail).toMatchObject({ status: "completed", currentExecutionAttemptId: 2 });
    expect(detail.phases[0].agents).toEqual([expect.objectContaining({ id: "w1", status: "completed", result: { n: 1 } })]);
    expect(executed).toBe(1);
    const reopened = await RunJournal.open(execution.executionId, join(root, harnessRunId, "executions"));
    const staleConverged = reopened.events.findIndex((event) => event.type === "agent.status" && event.status === "interrupted" && event.diagnostic?.includes("不可认领"));
    const restarted = reopened.events.findIndex((event) => event.type === "agent.restarted");
    expect(staleConverged).toBeGreaterThanOrEqual(0);
    expect(restarted).toBeGreaterThan(staleConverged);
    expect(reopened.events.some((event) => event.type === "execution-attempt.started" && event.executionAttemptId === 2)).toBe(true);
    const outer = await HarnessJournal.open(harnessRunId, root);
    expect(outer.events.some((event) => event.type === "workflow.execution_resumed" && event.executionId === execution.executionId)).toBe(true);
    const finished = outer.events.filter((event) => event.type === "workflow.execution_finished" && event.executionId === execution.executionId);
    expect(finished.map((event) => (event as { readonly status: string }).status)).toEqual(["interrupted", "completed"]);
  });
});
