import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopExecutionEngine } from "../../src/desktop/desktop-execution-engine";

const roots: string[] = [];
const engines: DesktopExecutionEngine[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) engine.shutdown(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function engineWithTask(): Promise<{ engine: DesktopExecutionEngine; harnessRunId: string }> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-archive-ipc-")); roots.push(root);
  const project = await mkdtemp(join(tmpdir(), "wave-flow-archive-ipc-project-")); roots.push(project);
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true });
  engines.push(engine);
  const { project: created } = await engine.handleDesktopAction("projects.create", { cwd: project }) as { project: { projectId: string } };
  const { harness } = await engine.handleDesktopAction("harnesses.startConversation", { projectId: created.projectId, text: "归档通道", clientRequestId: crypto.randomUUID() }) as { harness: { harnessRunId: string; status: string } };
  for (let n = 0; n < 200; n++) {
    const snapshot = await engine.handleDesktopAction("harnesses.get", { harnessRunId: harness.harnessRunId }) as { harness: { status: string } };
    if (snapshot.harness.status === "idle") return { engine, harnessRunId: harness.harnessRunId };
    await Bun.sleep(5);
  }
  throw new Error("主控回合未收敛。 ");
}

test("归档预览与协调归档 IPC：形状完整、严格/放弃语义与幂等重试", async () => {
  const { engine, harnessRunId } = await engineWithTask();
  const preview = await engine.handleDesktopAction("harnesses.archivePreview", { harnessRunId }) as { preview: { requiresAbandon: boolean; candidate: unknown; pendingSummaries: unknown[]; pendingDecisions: unknown[] } };
  expect(preview.preview).toMatchObject({ harnessRunId, requiresAbandon: false, candidate: null, pendingSummaries: [], pendingDecisions: [] });
  // 严格归档无待定项直接封存；协调重试幂等返回同一归档。
  const archived = await engine.handleDesktopAction("harnesses.complete", { harnessRunId }) as { harness: { status: string } };
  expect(archived.harness.status).toBe("completed");
  const retried = await engine.handleDesktopAction("harnesses.complete", { harnessRunId, abandonPending: true }) as { harness: { status: string } };
  expect(retried.harness.status).toBe("completed");
  // 旧前端字段 abandonImpactSummaries 收敛到同一协调归档，不是旁路。
  const legacy = await engine.handleDesktopAction("harnesses.complete", { harnessRunId, abandonImpactSummaries: true }) as { harness: { status: string } };
  expect(legacy.harness.status).toBe("completed");
  await expect(engine.handleDesktopAction("harnesses.archivePreview", { harnessRunId })).rejects.toThrow("已归档");
});

test("归档 IPC 参数校验在读档前拒绝，未知任务报明确错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-archive-ipc-invalid-")); roots.push(root);
  const engine = new DesktopExecutionEngine({ storeRoot: join(root, "runs"), harnessRoot: join(root, "harness-runs"), deterministicForTest: true });
  engines.push(engine);
  const harnessRunId = crypto.randomUUID();
  for (const flag of ["true", 1, null]) {
    await expect(engine.handleDesktopAction("harnesses.complete", { harnessRunId, abandonPending: flag })).rejects.toThrow("归档放弃标识无效");
    await expect(engine.handleDesktopAction("harnesses.complete", { harnessRunId, abandonImpactSummaries: flag })).rejects.toThrow("归档放弃标识无效");
  }
  await expect(engine.handleDesktopAction("harnesses.archivePreview", { harnessRunId, extra: true })).rejects.toThrow("额外请求字段");
  await expect(engine.handleDesktopAction("harnesses.archivePreview", { harnessRunId })).rejects.toThrow();
  await expect(engine.handleDesktopAction("harnesses.complete", { harnessRunId })).rejects.toThrow();
});
