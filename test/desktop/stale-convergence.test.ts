import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopExecutionEngine } from "../../src/desktop/desktop-execution-engine";
import { LeadExecutionService } from "../../src/lead/executions";
import type { ResolvedLeadModelConfig } from "../../src/lead/config";
import type { LeadSession } from "../../src/lead/session";
import { LeadService } from "../../src/lead/service";
import { DeterministicExecutor } from "../../src/runtime/deterministic-executor";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const model: ResolvedLeadModelConfig = { model: "test-model", baseUrl: "http://127.0.0.1:9", apiKey: "test-key" };
const createPi = (): LeadSession => { throw new Error("测试不创建真实 Pi 会话。 "); };

const GATE_SOURCE = `import { agent, decisionGate, phase } from "wave-flow";
export const meta = { name: "exec-gate", description: "带决策门", phases: [{ title: "工作" }], inputSchema: { type: "object", properties: {}, additionalProperties: false } };
export default async function run(args) {
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

describe("DesktopExecutionEngine 启动收敛", () => {
  test("全局 Run Store 缺失且旧版 0755 权限时，仍修复权限并把失联 Execution 收敛为 interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-converge-"));
    directories.push(root);
    const leadRoot = join(root, "lead-runs");
    // 全局 Run Store 刻意不创建：纯 Lead 使用的 home 没有 runs/ 目录。
    const storeRoot = join(root, "runs");

    // 制造一个等待决策门的 Execution 档案（模拟上一个 Engine 进程死亡前的现场）。
    const lead = new LeadService(leadRoot, async () => model, createPi);
    const executions = new LeadExecutionService(lead, () => ({ executor: new DeterministicExecutor() }), {}, leadRoot);
    const { leadRunId } = await lead.create(root);
    await lead.proposeWorkflowRevision(leadRunId, GATE_SOURCE);
    await lead.acceptWorkflowRevision(leadRunId, 1);
    const { execution } = await executions.createExecution(leadRunId, 1, {});
    await waitFor(async () => (await executions.snapshotExecution(leadRunId, execution.executionId)).gates.length === 1);

    // 模拟旧版本以 0755 创建的状态目录：读取校验会让 list() 把档案静默丢弃。
    await chmod(leadRoot, 0o755);
    const staleLead = new LeadService(leadRoot, async () => model, createPi);
    expect(await staleLead.list()).toEqual([]);

    const engine = new DesktopExecutionEngine({ storeRoot, leadRoot, deterministicForTest: true });
    await engine.convergeStaleAcpWorkers();

    // 权限被收紧修复，失联 Execution 不再伪装为工作中。
    expect((await lstat(leadRoot)).mode & 0o077).toBe(0);
    const convergedLead = new LeadService(leadRoot, async () => model, createPi);
    const converged = new LeadExecutionService(convergedLead, () => ({ executor: new DeterministicExecutor() }), {}, leadRoot);
    await expect(converged.listExecutions(leadRunId)).resolves.toMatchObject([
      { executionId: execution.executionId, status: "interrupted", diagnostic: expect.stringContaining("不可跨进程认领") },
    ]);
    await expect(converged.snapshotExecution(leadRunId, execution.executionId)).resolves.toMatchObject({ status: "interrupted" });
    expect(converged.isControllable(execution.executionId)).toBe(false);
    engine.shutdown();
  });
});
