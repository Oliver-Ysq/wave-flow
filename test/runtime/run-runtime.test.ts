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

  test("executor 明确返回 null 时区分业务失败，且 Workflow 得到 null", async () => {
    const instance = await runtime({ execute: async () => null });
    await expect(instance.run(workflow)).resolves.toBeNull();
    expect(instance.snapshot()).toMatchObject({ status: "failed", phases: [{ agents: [{ status: "failed" }] }] });
  });

  test("executor 抛错时标记 interrupted，而不伪装为业务 failed", async () => {
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
