import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRuntime } from "../../src/runtime/run-runtime";
import type { AgentNodeExecutor } from "../../src/runtime/run-types";
import type { JsonObject } from "../../src/shared/json";
import type { WorkflowModule } from "../../src/shared/workflow-types";
import { agent, phase } from "../../src/workflow/author-api";
import type { CapabilitySnapshot } from "../../src/adapters/capabilities";
import { ControlServer } from "../../src/control/control-server";
import type { SessionIdentity } from "../../src/sessions/types";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const workflow: WorkflowModule<JsonObject, unknown> = {
  meta: { name: "runtime-check", description: "Check runtime.", phases: [{ title: "scan" }] },
  default: async () => {
    phase("scan");
    return agent("scan", { id: "scan-auth", cli: "codex" });
  },
};

async function runtime(executor: AgentNodeExecutor): Promise<RunRuntime> {
  const cwd = await mkdtemp(join(tmpdir(), "wave-flow-runtime-"));
  directories.push(cwd);
  return RunRuntime.create({ workflow, input: {}, workflowSource: "workflow source", cwd, executor });
}

describe("RunRuntime", () => {
  test("以 durable-first 保存完成结果并提供 Phase → Agent 查询", async () => {
    const instance = await runtime({ execute: async () => ({ ok: true }) });
    await expect(instance.run(workflow)).resolves.toEqual({ ok: true });
    expect(instance.snapshot()).toMatchObject({ status: "completed", phases: [{ title: "scan", agents: [{ id: "scan-auth", status: "completed", result: { ok: true } }] }] });
  });

  test("executor 返回 null 时标记 interrupted，不能伪装为业务失败", async () => {
    const instance = await runtime({ execute: async () => null });
    await expect(instance.run(workflow)).rejects.toThrow("无法验证节点已完成");
    expect(instance.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ status: "interrupted" }] }] });
  });

  test("真实执行器经 Control 完成后不会重复追加 completed 事件", async () => {
    let control: ControlServer | undefined;
    const instance = await runtime({
      execute: async (node) => {
        const server = control!;
        const capability = "runtime-capability";
        server.register({ runId: server.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability });
        const session: SessionIdentity = { backend: "tmux", sessionName: "wf-runtime", backendRef: "/tmp/wf-runtime.sock", runId: server.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, cli: "codex", createdAt: new Date().toISOString() };
        await server.recordSession({ runId: server.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, delivery: "tmux", session });
        await server.complete({ runId: server.runId, nodeId: node.id, agentSessionId: node.agentSessionId!, capability, summary: "done", result: { ok: true } });
        return { ok: true };
      },
    });
    control = instance.createControlServer();
    await expect(instance.run(workflow)).resolves.toEqual({ ok: true });
    const reopened = await RunRuntime.open(instance.journal.manifest.runId, instance.journal.manifest.cwd, { execute: async () => ({ unused: true }) });
    expect(reopened.snapshot().phases[0]?.agents[0]).toMatchObject({ status: "completed", result: { ok: true } });
  });

  test("executor 抛错时标记 interrupted", async () => {
    const instance = await runtime({ execute: async () => { throw new Error("executor crashed"); } });
    await expect(instance.run(workflow)).rejects.toThrow("executor crashed");
    expect(instance.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ status: "interrupted", diagnostic: "executor crashed" }] }] });
  });

  test("拒绝未选择 Phase 的 Agent，避免节点脱离 Phase → Agent 主视图", async () => {
    const noPhase: WorkflowModule<JsonObject, unknown> = {
      meta: workflow.meta,
      default: () => agent("scan", { id: "unassigned", cli: "codex" }),
    };
    const instance = await runtime({ execute: async () => ({ unused: true }) });
    await expect(instance.run(noPhase)).rejects.toThrow("必须调用 phase");
    expect(instance.snapshot().phases[0].agents).toEqual([]);
  });

  test("即使作者未 await agent()，Run 也等待节点完成后才封存", async () => {
    let release: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const detached: WorkflowModule<JsonObject, unknown> = {
      meta: workflow.meta,
      default: async () => { phase("scan"); void agent("detached", { id: "detached", cli: "codex" }); return { submitted: true }; },
    };
    const instance = await runtime({ execute: async () => { await delayed; return { ok: true }; } });
    const running = instance.run(detached);
    await Promise.resolve();
    expect(instance.snapshot().status).toBe("running");
    release?.();
    await expect(running).resolves.toEqual({ submitted: true });
    expect(instance.snapshot()).toMatchObject({ status: "completed", phases: [{ agents: [{ id: "detached", status: "completed" }] }] });
  });

  test("可以从 Manifest 和 Journal 重开并重建 Phase → Agent 视图", async () => {
    const instance = await runtime({ execute: async () => ({ ok: true }) });
    await instance.run(workflow);
    const restored = await RunRuntime.open(instance.journal.manifest.runId, instance.journal.manifest.cwd, { execute: async () => ({ unused: true }) });
    expect(restored.snapshot()).toMatchObject({ status: "completed", phases: [{ title: "scan", agents: [{ id: "scan-auth", status: "completed", result: { ok: true } }] }] });
  });

  test("同步 phase Journal 写入失败会中断 Run，不会静默完成", async () => {
    const instance = await runtime({ execute: async () => ({ ok: true }) });
    instance.journal.failNextAppendForTest();
    await expect(instance.run(workflow)).rejects.toThrow("Injected Journal append failure");
    expect(instance.snapshot().status).toBe("interrupted");
  });

  test("执行器声明的运行期能力 unknown 时节点在启动前 fail closed", async () => {
    const unknownSnapshot: CapabilitySnapshot = {
      version: 1,
      host: { platform: "test", tmux: { status: "unknown", persistentSessions: "unknown" } },
      adapters: { codex: { status: "available", interactiveSession: "unknown", verifiedPromptDelivery: "unknown", persistentTmuxSession: "unknown", sandbox: { readOnly: "unknown", workspaceWrite: "unknown" } } },
    };
    let executions = 0;
    const instance = await runtime({
      execute: async () => { executions += 1; return { unexpected: true }; },
      probeCapabilities: async () => unknownSnapshot,
      requiredCapabilities: () => ({ "codex.interactiveSession": (snapshot) => snapshot.adapters.codex.interactiveSession }),
    });
    await expect(instance.run(workflow)).rejects.toThrow("codex.interactiveSession=unknown");
    expect(executions).toBe(0);
    expect(instance.snapshot()).toMatchObject({ status: "interrupted", phases: [{ agents: [{ status: "interrupted" }] }] });
  });
});
