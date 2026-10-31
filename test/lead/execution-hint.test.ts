import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlServer } from "../../src/control/control-server";
import type { ExecutionConfigSnapshot, WorkerAssignment } from "../../src/lead/types";
import { LeadExecutionService } from "../../src/lead/executions";
import { LeadService } from "../../src/lead/service";
import type { ResolvedLeadModelConfig } from "../../src/lead/config";
import type { LeadSession } from "../../src/lead/session";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import type { RunRuntime } from "../../src/runtime/run-runtime";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const model: ResolvedLeadModelConfig = { model: "test-model", baseUrl: "http://127.0.0.1:9", apiKey: "test-key" };
const createPi = (): LeadSession => { throw new Error("测试不创建真实 Pi 会话。 "); };

const SOURCE = `import { agent, phase } from "wave-flow";
export const meta = { name: "exec-hint", description: "提示证据", phases: [{ title: "工作" }], inputSchema: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false } };
export default async function run(args) {
  phase("工作");
  const done = await agent("做任务", { id: "w1", cli: "codex" });
  return { ok: true, node: done.nodeId, note: args.note ?? null };
}`;

/** 测试冻结配置；服务层不核对 runtimeId 真实性（那是 Engine action 的职责）。 */
function executionConfig(): ExecutionConfigSnapshot {
  const assignment = (agentId: string): WorkerAssignment => ({ agentId, cli: "codex", model: "cli-default", source: "lead-cli", runtimeId: "test-runtime", adapterId: "codex-acp", adapterVersion: "0.0.0-test" });
  return { version: 1, createdAt: new Date().toISOString(), fallbackRuntimeId: "test-runtime", ruleText: null, ruleDegraded: false, defaultAssignment: assignment("*"), assignments: [assignment("w1")] };
}

type CapsuleEvidence = {
  readonly nodes: readonly { readonly id: string; readonly status: string; readonly diagnostic: string | null; readonly hint: string | null }[];
  readonly journalEvidence: readonly { readonly type: string; readonly nodeId?: string | null; readonly message?: string }[];
};

async function waitFor(condition: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("等待条件超时。 ");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("执行器停滞提示在运行快照与 capsule 证据中可见，完成后清除", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-execution-hint-"));
  directories.push(root);
  const lead = new LeadService(root, async () => model, createPi);
  const leadRunId = (await lead.create(root)).leadRunId;
  let runtime: RunRuntime | null = null;
  let control: ControlServer | null = null;
  let executions!: LeadExecutionService;
  let observed: {
    readonly snapshotNodes: readonly AgentNodeSnapshot[];
    readonly capsule: CapsuleEvidence;
  } | null = null;
  const HINT_COUNT = 25;

  executions = new LeadExecutionService(lead, () => ({
    executor: {
      execute: async (node) => {
        const executionId = runtime!.snapshot().id;
        // 模拟 acp-worker-executor 的停滞诊断：多次写节点绑定 log.written。
        for (let index = 1; index <= HINT_COUNT; index++) {
          await control!.recordExecutorDiagnostic(`执行器诊断 ${index}：暂无有效进展；仅提示，不改变业务状态。`, node.id, node.agentSessionId!);
        }
        // 运行中的权威快照与 capsule 证据都必须在完成前就能看到最近提示。
        const live = await executions.snapshotExecution(leadRunId, executionId);
        observed = {
          snapshotNodes: live.phases.flatMap((phase) => phase.agents),
          capsule: await executions.capsuleEvidence(leadRunId, executionId, 1) as CapsuleEvidence,
        };
        return { ok: true };
      },
    },
  }), { wireControl: (bound) => { runtime = bound; control = bound.createControlServer(); } }, root);

  try {
    await lead.proposeWorkflowRevision(leadRunId, SOURCE);
    await lead.acceptWorkflowRevision(leadRunId, 1);
    const { execution } = await executions.createExecution(leadRunId, 1, {});
    await waitFor(async () => (await executions.listExecutions(leadRunId))[0].finishedAt !== null);

    expect(observed).not.toBeNull();
    const live = observed!.snapshotNodes.find((node) => node.id === "w1")!;
    expect(live).toMatchObject({ status: "running", diagnostic: null, hint: `执行器诊断 ${HINT_COUNT}：暂无有效进展；仅提示，不改变业务状态。` });
    const capsuleNode = observed!.capsule.nodes.find((node) => node.id === "w1")!;
    expect(capsuleNode).toMatchObject({ status: "running", diagnostic: null, hint: live.hint });
    // 提示进入 Journal 证据，但有界：只保留本 attempt 最近 20 条节点绑定日志。
    const logs = observed!.capsule.journalEvidence.filter((event) => event.type === "log.written");
    expect(logs).toHaveLength(20);
    expect(logs.every((event) => event.nodeId === "w1")).toBe(true);
    expect(logs[0].message).toContain("执行器诊断 6");
    expect(logs.at(-1)!.message).toContain(`执行器诊断 ${HINT_COUNT}`);
    // 提示不是业务状态：节点随后仍按正常 complete 路径完成。
    expect((await executions.listExecutions(leadRunId))[0]).toMatchObject({ executionId: execution.executionId, status: "completed" });
    const finished = (await executions.snapshotExecution(leadRunId, execution.executionId)).phases.flatMap((phase) => phase.agents).find((node) => node.id === "w1")!;
    expect(finished).toMatchObject({ status: "completed", hint: null });
    expect(finished.status).toBe("completed");
    expect(finished.result).toEqual({ ok: true });
  } finally { lead.close(); }
});
