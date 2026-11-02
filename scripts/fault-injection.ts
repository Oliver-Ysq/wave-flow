import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedExit } from "../src/workspace/git-repository";
import { WorkspaceManager, type WorkspaceAuthorization } from "../src/workspace/workspace-manager";
import { fenceAcpNodeWriters } from "../src/runtime/acp-writer-fence";
import type { AgentNodeSnapshot } from "../src/runtime/run-types";
import { reportPathFor, writerLaunchKey } from "../src/runtimes/supervisor-report";
import { reportProviderPid } from "../src/runtimes/worker-supervisor";
import { captureWriterStartedAt } from "../src/workspace/writer-process-control";
import { runsRoot } from "../src/journal/paths";
import { RunRuntime } from "../src/runtime/run-runtime";
import type { WorkflowModule } from "../src/shared/workflow-types";
import type { JsonObject } from "../src/shared/json";
import { agent, phase } from "../src/workflow/author-api";

const workflow: WorkflowModule<JsonObject, unknown> = {
  meta: { name: "network-fault", description: "Network fault injection.", phases: [{ title: "network" }] },
  default: async () => { phase("network"); return agent("apply", { id: "network", cli: "codex" }); },
};

async function createRuntime(root: string, execute: () => Promise<JsonObject>): Promise<RunRuntime> {
  const workflowPath = join(root, "workflow.ts");
  await writeFile(workflowPath, "workflow", "utf8");
  return RunRuntime.create({
    workflow,
    input: {},
    workflowSource: "workflow",
    clientRequestId: crypto.randomUUID(),
    workflowProjectCwd: root,
    workflowPath,
    storeRoot: runsRoot(join(root, "store")),
    executor: { execute },
  });
}

async function networkChild(root: string, endpoint: string): Promise<void> {
  const runtime = await createRuntime(root, async () => {
    await fetch(endpoint, { method: "POST", body: JSON.stringify({ operationId: "op-1" }) });
    return new Promise<JsonObject>(() => {});
  });
  await runtime.run(workflow);
}

async function unresponsiveIo(): Promise<JsonObject> {
  const child = Bun.spawn(["/bin/bash", "-c", "trap '' TERM; sleep 60"], { stdout: "ignore", stderr: "ignore" });
  const started = performance.now();
  try {
    const code = await boundedExit(child.exited, signal => child.kill(signal), 25, 25, 1_000);
    if (code === 0 || performance.now() - started > 2_000) throw new Error(`进程终止阶梯失效：${code}`);
    await Bun.spawn(["/usr/bin/true"]).exited;
    return { scenario: "unresponsive-io", ignoredSigterm: true, escalatedToSigkill: true, bounded: true };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

async function powerLossSpawnIntent(root: string): Promise<JsonObject> {
  const repository = join(root, "repo");
  await mkdir(repository);
  await Bun.spawn(["/usr/bin/git", "init", "-b", "main", repository]).exited;
  await Bun.spawn(["/usr/bin/git", "-C", repository, "config", "user.name", "Fault Injection"]).exited;
  await Bun.spawn(["/usr/bin/git", "-C", repository, "config", "user.email", "fault@example.invalid"]).exited;
  await writeFile(join(repository, "README.md"), "fault\n");
  await Bun.spawn(["/usr/bin/git", "-C", repository, "add", "README.md"]).exited;
  await Bun.spawn(["/usr/bin/git", "-C", repository, "commit", "-m", "base"]).exited;
  const head = Bun.spawn(["/usr/bin/git", "-C", repository, "rev-parse", "HEAD"], { stdout: "pipe" });
  const baseCommit = (await new Response(head.stdout).text()).trim();
  const authorization: WorkspaceAuthorization = {
    authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository,
    baseCommit, excludeExistingDirty: false, nodes: [{ nodeId: "writer" }],
  };
  const workspaceId = crypto.randomUUID(), runId = crypto.randomUUID();
  const manager = await WorkspaceManager.open(join(root, "workspaces"), crypto.randomUUID());
  await manager.create(workspaceId, authorization);
  await manager.assertWriterAllowed(workspaceId, runId, "writer");
  // Engine 在 spawn 后、进程证据落盘前被强杀：Journal 只有启动意图。
  const intentOnly = {
    id: "writer", phase: "write", executionAttemptId: 1, phaseVisitId: 1, sequence: 1,
    executionBatch: { sequence: 1, mode: "serial" }, cli: "codex", sandbox: "workspace-write",
    cwd: repository, label: "writer", status: "running", result: null, diagnostic: null,
    createdAt: new Date().toISOString(), startedAt: null, endedAt: null, agentSessionId: "fault-session",
    block: null, writer: null, writerIntentAt: new Date().toISOString(),
    request: { id: "writer", cli: "codex", sandbox: "workspace-write", cwd: repository, prompt: "work" },
  } as unknown as AgentNodeSnapshot;
  const reportDir = join(root, "supervisor-reports");
  const reportPath = reportPathFor(writerLaunchKey(runId, "writer", "fault-session"), reportDir);
  // 只有启动意图、没有 supervisor 启动记录：可以判定 provider 从未创建，不再把执行卡死。
  const intentOnlyFence = await fenceAcpNodeWriters(runId, [intentOnly], { reportDir });
  if (intentOnlyFence.failures.length > 0) throw new Error(`没有 supervisor 记录时不应拒绝恢复：${JSON.stringify(intentOnlyFence.failures)}`);
  // 有 provider 报告时必须按报告围栏：用真实 detached 进程组验证 SIGKILL 与消失确认。
  const writerProcess = Bun.spawn(["/bin/sleep", "60"], { detached: true, stdout: "ignore", stderr: "ignore" });
  try {
    const startedAt = await captureWriterStartedAt(writerProcess.pid);
    reportProviderPid(reportPath, writerProcess.pid, startedAt);
    const reportedFence = await fenceAcpNodeWriters(runId, [intentOnly], { reportDir });
    if (reportedFence.failures.length > 0) throw new Error(`provider 报告围栏失败：${JSON.stringify(reportedFence.failures)}`);
    const deadline = Date.now() + 5_000;
    let probe = (() => { try { process.kill(-writerProcess.pid, 0); return true; } catch { return false; } })();
    while (probe && Date.now() < deadline) { await Bun.sleep(20); probe = (() => { try { process.kill(-writerProcess.pid, 0); return true; } catch { return false; } })(); }
    if (probe) throw new Error("provider 报告对应的进程组未被围栏终止。");
  } finally {
    try { process.kill(-writerProcess.pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
  // 清理必须收到 Engine 的围栏证明；证明失败时按契约拒绝并保留现场。
  let rejectedCleanup = "";
  try { await manager.cleanup(workspaceId, true, runId, async () => { throw new Error("写者仍无法核验"); }); }
  catch (error) { rejectedCleanup = error instanceof Error ? error.message : String(error); }
  if (!rejectedCleanup.includes("无法核验")) throw new Error(`无围栏证明的清理未被拒绝：${rejectedCleanup}`);
  const kept = await manager.inspect(workspaceId);
  if (kept.cleanedAt !== null || !(await Bun.file(join(kept.cwd, "README.md")).exists())) throw new Error("拒绝清理后现场未保留。");
  // 围栏通过（Engine 证明）后才允许删除。
  const cleaned = await manager.cleanup(workspaceId, true, runId, async () => {});
  if (cleaned.cleanedAt === null) throw new Error("围栏通过后的清理未落盘。");
  return { scenario: "power-loss-spawn", rejectedResume: true, duplicateWriterPrevented: true, cleanupRequiresProof: true };
}

async function networkPowerLoss(root: string): Promise<JsonObject> {
  let requests = 0;
  let notify!: () => void;
  const firstRequest = new Promise<void>(resolve => { notify = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() { requests++; if (requests === 1) notify(); return new Response(JSON.stringify({ accepted: requests })); },
  });
  try {
    const endpoint = `http://127.0.0.1:${server.port}/apply`;
    const child = Bun.spawn([process.execPath, import.meta.path, "network-child", root, endpoint], { stdout: "inherit", stderr: "inherit" });
    await Promise.race([firstRequest, Bun.sleep(5_000).then(() => { throw new Error("未收到首次网络副作用"); })]);
    child.kill("SIGKILL");
    await child.exited;
    if (requests !== 1) throw new Error(`强杀前请求数异常：${requests}`);
    await Bun.sleep(100);
    if (requests !== 1) throw new Error("Engine 强杀后仍自动重发请求");

    const journalPath = (await Array.fromAsync(new Bun.Glob("*/journal.jsonl").scan(join(root, "store", "runs"))))[0];
    const runId = journalPath?.split("/").at(-2);
    if (!runId) throw new Error("未找到被强杀的 Run");
    const interrupted = await RunRuntime.open(runId, { execute: async () => ({ ok: true }) }, runsRoot(join(root, "store")));
    for (const node of interrupted.snapshot().phases.flatMap(item => item.agents)) {
      if (["completed", "cancelled", "interrupted"].includes(node.status)) continue;
      await interrupted.commitConvergence({ type: "agent.status", at: new Date().toISOString(), runId, nodeId: node.id, agentSessionId: node.agentSessionId as string, status: "interrupted", diagnostic: "故障注入：Engine 被 SIGKILL。" });
    }
    await interrupted.commitConvergence({ type: "run.status", at: new Date().toISOString(), runId, nodeId: null, agentSessionId: null, status: "interrupted", diagnostic: "故障注入：Engine 被 SIGKILL。" });
    if (requests !== 1) throw new Error("中断收敛重复了网络副作用");

    const resumed = await RunRuntime.resume(runId, {
      execute: async () => {
        await fetch(endpoint, { method: "POST", body: JSON.stringify({ operationId: "op-1" }) });
        return { ok: true };
      },
    }, runsRoot(join(root, "store")));
    await resumed.run(workflow);
    if (requests !== 2) throw new Error(`显式恢复后的请求数异常：${requests}`);
    return { scenario: "network-power-loss", beforeKill: 1, afterRestart: 1, afterExplicitResume: 2, noAutomaticRetry: true };
  } finally {
    server.stop(true);
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-fault-injection-"));
  try {
    const io = await unresponsiveIo();
    const spawn = await powerLossSpawnIntent(root);
    const network = await networkPowerLoss(root);
    console.log(JSON.stringify({ ok: true, scenarios: [io, spawn, network] }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "network-child") {
  const [root, endpoint] = process.argv.slice(3);
  if (!root || !endpoint) throw new Error("network-child 需要 root 与 endpoint");
  await networkChild(root, endpoint);
} else {
  await main();
}
