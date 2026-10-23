import { afterEach, expect, spyOn, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository } from "../../src/workspace/git-repository";
import { SourcePersistenceError, isRetryableSourceError, WorkspaceManager, type WorkspaceAuthorization } from "../../src/workspace/workspace-manager";
import { captureWriterStartedAt, nodeWriterProcessControl, type WriterProcessControl } from "../../src/workspace/writer-process-control";
import { WorkflowContractError } from "../../src/workflow/errors";
import { WorkspaceExecutor } from "../../src/workspace/workspace-executor";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import type { ExecutionWorkspaceConfig } from "../../src/workspace/execution-workspaces";

// 多次真实Git子进程的端到端测试使用明确预算，避免默认5s杀进程产生伪逻辑错误。
const test = (name: string, run: () => Promise<void>, timeout = 15_000) => bunTest(name, run, timeout);

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-workspace-test-"))); directories.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd);
  async function git(...args: string[]) { const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(err); return out.trim(); }
  await git("init", "-b", "main"); await writeFile(join(cwd, "a.txt"), "base\n"); await writeFile(join(cwd, "b.txt"), "base\n"); await git("add", "--", "a.txt", "b.txt"); await git("commit", "-m", "fixture");
  const authorization: WorkspaceAuthorization = { authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), repository: cwd, baseCommit: await git("rev-parse", "HEAD"), excludeExistingDirty: false, nodes: [{ nodeId: "a" }, { nodeId: "b" }] };
  const manager = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID());
  const workspaceId = crypto.randomUUID(), runId = crypto.randomUUID();
  return { root, cwd, manager, workspaceId, authorization, runId, git };
}
function config(workspaceId: string, authorization: WorkspaceAuthorization, continuation?: { executionId: string; workspaceId: string; head: string }): ExecutionWorkspaceConfig {
  return { version: 3, authorization, workspaceId, ...(continuation ? { continuation } : {}) };
}
function node(id: string, attempt = 1, sandbox: "workspace-write" | "read-only" = "workspace-write"): AgentNodeSnapshot {
  return { id, phase: "run", executionAttemptId: attempt, phaseVisitId: 1, sequence: 1, executionBatch: { sequence: 1, mode: "serial" }, cli: "codex", sandbox, cwd: "/tmp/project", label: id, status: "running", result: null, diagnostic: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, agentSessionId: crypto.randomUUID(), block: null, request: { id, cli: "codex", sandbox, cwd: "/tmp/project", phase: "run", prompt: "work" } };
}

test("交付重试按错误类型分类，安全契约拒绝不误当临时失败", async () => {
  expect(isRetryableSourceError(new SourcePersistenceError("fixture"))).toBe(true);
  expect(isRetryableSourceError(new Error("disk"))).toBe(true);
  expect(isRetryableSourceError(new WorkflowContractError("未授权/锁"))).toBe(false);
  const { manager, runId } = await fixture();
  await manager.recordSourceDiagnostic(runId, "contract refused");
  expect(await manager.canRetrySource(runId)).toBe(false);
  await manager.recordSourceDiagnostic(runId, "disk", true);
  expect(await manager.canRetrySource(runId)).toBe(true);
});

test("同一共享worktree可并行持有多个writer租约，释放需独立退出证明", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  const first = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group-a", { pgid: 54321, startedAt: "test-fingerprint" });
  const second = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "b", attempt: 1 }), "group-b", { pgid: 54321, startedAt: "test-fingerprint" });
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(2);
  await expect(manager.acquire(workspaceId, { runId, nodeId: "ghost", attempt: 1 })).rejects.toThrow("未获");
  await expect(manager.release(first, async () => false)).rejects.toThrow("退出不可核验");
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(2);
  await manager.release(first, async () => true);
  expect((await manager.inspect(workspaceId)).leases.map(lease => lease.nodeId)).toEqual(["b"]);
  await expect(manager.finalizeSource(runId, config(workspaceId, authorization))).rejects.toThrow("锁");
  await manager.release(second, async () => true);
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
  await expect(manager.abandonUnstarted(second)).rejects.toThrow("租约");
});

test("Execution收尾只封存共享worktree，主工作区保持不变", async () => {
  const { manager, workspaceId, authorization, runId, cwd, git } = await fixture();
  await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join((await manager.inspect(workspaceId)).cwd, "a.txt"), "result\n");
  await manager.release(lease, async () => true);
  const source = await manager.finalizeSource(runId, config(workspaceId, authorization), ["a", "b"]);
  expect("skippedAt" in source.applied).toBe(true);
  expect(source.paths).toEqual(["a.txt"]);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
  expect(await git("rev-parse", "HEAD")).toBe(authorization.baseCommit);
  expect(await git("diff", "--cached", "--name-only")).toBe("");
  expect((await manager.inspect(workspaceId)).lastApplied).toBeUndefined();
  expect(await manager.finalizeSource(runId, config(workspaceId, authorization))).toEqual(source);
});

test("主工作区dirty不影响worktree封存；结果仍只保留在worktree", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join((await manager.inspect(workspaceId)).cwd, "a.txt"), "result\n");
  await manager.release(lease, async () => true);
  await writeFile(join(cwd, "user.txt"), "keep");
  const source = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect(source.applied).toMatchObject({ skippedAt: expect.any(String), reason: expect.stringContaining("worktree") });
  expect(await manager.canRetrySource(runId)).toBe(false);
  await rm(join(cwd, "user.txt"));
  const retried = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect(retried).toEqual(source);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
});

test("续作复用同一worktree，主工作区始终保持未修改", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const first = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "first", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "a.txt"), "one\n");
  await manager.release(first, async () => true);
  const prior = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");

  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: prior.commit });
  await manager.prepareExecution(nextRun, nextConfig);
  await expect(manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 })).rejects.toThrow("旧执行");
  const second = await manager.bindWriter(await manager.acquire(workspaceId, { runId: nextRun, nodeId: "repair", attempt: 1 }), "second", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "b.txt"), "two\n");
  await manager.release(second, async () => true);
  const source = await manager.finalizeSource(nextRun, nextConfig, ["repair"]);
  expect("skippedAt" in source.applied).toBe(true);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
  expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("base\n");
  expect((await (await GitRepository.open(cwd)).inspect()).changedPaths).toEqual([]);
});

test("续作拒绝旧批准、HEAD漂移与未退出writer；冻结后不能换HEAD", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: authorization.baseCommit });
  await expect(manager.prepareExecution(nextRun, { ...nextConfig, authorization: { ...renewed, authorizationId: authorization.authorizationId } })).rejects.toThrow("独立新授权");
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await expect(manager.prepareExecution(nextRun, nextConfig)).rejects.toThrow("writer未交接");
  await manager.release(lease, async () => true);
  const drifted = { ...nextConfig, continuation: { ...nextConfig.continuation!, head: "b".repeat(40) } };
  await expect(manager.prepareExecution(nextRun, drifted)).rejects.toThrow("现场变化");
  await expect(manager.prepareExecution(nextRun, nextConfig)).resolves.toBeUndefined();
  await expect(manager.prepareExecution(nextRun, drifted)).rejects.toThrow("来源已冻结");
  expect((await manager.inspect(workspaceId)).executionAuthorizations).toHaveLength(2);
});

test("显式resume终止并核验旧Engine writer租约，保留共享worktree改动", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const evidence = { pgid: 4242, startedAt: "Wed Oct 22 09:00:02 2026" };
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "old-group", evidence);
  const workspace = await manager.inspect(workspaceId);
  await writeFile(join(workspace.cwd, "a.txt"), "partial\n");

  const killed: number[] = [];
  const control: WriterProcessControl = {
    probe: async (pgid) => killed.includes(pgid) ? { state: "absent" } : { state: "present", startedAt: evidence.startedAt },
    killGroup: async (pgid) => { killed.push(pgid); },
  };
  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID(), control);
  await restarted.prepareResume(config(workspaceId, authorization), runId);
  const resumed = await restarted.inspect(workspaceId);
  expect(resumed.leases).toHaveLength(0);
  expect(resumed.closedReleases).toHaveLength(1);
  expect(resumed.closedReleases?.[0]).toMatchObject({ leaseId: lease.leaseId, nodeId: "a", attempt: 1, outcome: "killed" });
  expect(killed).toEqual([4242]);
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("partial\n");
  const next = await restarted.bindWriter(await restarted.acquire(workspaceId, { runId, nodeId: "a", attempt: 2 }), "new-group", { pgid: 54321, startedAt: "test-fingerprint" });
  await restarted.release(next, async () => true);
  const newer = crypto.randomUUID(), renewal = { ...authorization, authorizationId: crypto.randomUUID(), nodes: [{ nodeId: "repair" }] };
  await restarted.prepareExecution(newer, config(workspaceId, renewal, { executionId: runId, workspaceId, head: authorization.baseCommit }));
  await expect(restarted.prepareResume(config(workspaceId, authorization), runId)).rejects.toThrow("旧版恢复只读");
});

test("真实进程组：resume 用真实 kill 终止旧 writer，租约释放且现场保留", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const child = Bun.spawn(["/bin/sh", "-c", "sleep 120"], { detached: true, stdout: "ignore", stderr: "ignore" });
  try {
    const evidence = { pgid: child.pid, startedAt: await captureWriterStartedAt(child.pid) };
    const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "real-group", evidence);
    const workspace = await manager.inspect(workspaceId);
    await writeFile(join(workspace.cwd, "a.txt"), "partial-real\n");
    const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID(), nodeWriterProcessControl());
    await restarted.prepareResume(config(workspaceId, authorization), runId);
    const resumed = await restarted.inspect(workspaceId);
    expect(resumed.leases).toHaveLength(0);
    expect(resumed.closedReleases?.[0]).toMatchObject({ leaseId: lease.leaseId, nodeId: "a", outcome: "killed" });
    expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("partial-real\n");
    const control = nodeWriterProcessControl();
    const deadline = Date.now() + 5_000;
    let probe = await control.probe(child.pid);
    while (probe.state !== "absent" && Date.now() < deadline) { await Bun.sleep(20); probe = await control.probe(child.pid); }
    expect(probe.state).toBe("absent");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
}, 20_000);

test("旧writer进程组无法核验时拒绝恢复，租约与现场原样保留", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "old-group", { pgid: 5151, startedAt: "fp" });
  let killed = 0;
  const control: WriterProcessControl = {
    probe: async () => ({ state: "unknown", reason: "ps 输出异常" }),
    killGroup: async () => { killed += 1; },
  };
  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID(), control);
  await expect(restarted.prepareResume(config(workspaceId, authorization), runId)).rejects.toThrow("无法核验");
  const record = await restarted.inspect(workspaceId);
  expect(record.leases.map(item => item.leaseId)).toEqual([lease.leaseId]);
  expect(record.closedReleases).toBeUndefined();
  expect(killed).toBe(0);
});

test("历史租约缺少进程证据时拒绝恢复；启动指纹不一致视为PID复用且不误杀", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "legacy", { pgid: 54321, startedAt: "test-fingerprint" });
  // 模拟本能力上线前的旧租约：有 writer 身份，但没有进程组/启动时间字段。
  const recordPath = join(root, "state", "records", `${workspaceId}.json`);
  const legacy = JSON.parse(await Bun.file(recordPath).text());
  delete legacy.leases[0].writerPgid;
  delete legacy.leases[0].writerStartedAt;
  await writeFile(recordPath, JSON.stringify(legacy));
  const noEvidence = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID(), { probe: async () => ({ state: "absent" }), killGroup: async () => {} });
  await expect(noEvidence.prepareResume(config(workspaceId, authorization), runId)).rejects.toThrow("缺少进程证据");

  const second = await fixture();
  await second.manager.create(second.workspaceId, second.authorization);
  await second.manager.prepareExecution(second.runId, config(second.workspaceId, second.authorization));
  await second.manager.bindWriter(await second.manager.acquire(second.workspaceId, { runId: second.runId, nodeId: "a", attempt: 1 }), "reused-pid", { pgid: 6161, startedAt: "old-fingerprint" });
  let killed = 0;
  const reused = await WorkspaceManager.open(join(second.root, "state"), crypto.randomUUID(), {
    probe: async () => ({ state: "present", startedAt: "different-fingerprint" }),
    killGroup: async () => { killed += 1; },
  });
  await reused.prepareResume(config(second.workspaceId, second.authorization), second.runId);
  const closed = await reused.inspect(second.workspaceId);
  expect(closed.closedReleases?.[0]).toMatchObject({ outcome: "exited" });
  expect(killed).toBe(0);
});

test("损坏的writer进程证据或终止记录拒绝读取", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "damaged", { pgid: 9191, startedAt: "fp" });
  const path = join(root, "state", "records", `${workspaceId}.json`);
  const rewrite = async (mutate: (record: Record<string, unknown>) => void) => {
    const record = JSON.parse(await Bun.file(path).text());
    mutate(record);
    await writeFile(path, JSON.stringify(record));
  };
  await rewrite(record => { (record.leases as Record<string, unknown>[])[0]!.writerPgid = "not-a-pid"; });
  await expect(manager.inspect(workspaceId)).rejects.toThrow("进程组记录损坏");
  await rewrite(record => { (record.leases as Record<string, unknown>[])[0]!.writerPgid = 9191; record.closedReleases = [{ at: new Date().toISOString(), leaseId: crypto.randomUUID(), nodeId: "a", attempt: 1, outcome: "unknown", reason: "x" }]; });
  await expect(manager.inspect(workspaceId)).rejects.toThrow("终止记录损坏");
});

test("leader 已退出但进程组仍存在（孤儿组）时仍按原 writer 终止", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "orphan-group", { pgid: 8282, startedAt: "leader-fingerprint" });
  const killed: number[] = [];
  const control: WriterProcessControl = {
    probe: async (pgid) => killed.includes(pgid) ? { state: "absent" } : { state: "present", startedAt: null },
    killGroup: async (pgid) => { killed.push(pgid); },
  };
  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID(), control);
  await restarted.prepareResume(config(workspaceId, authorization), runId);
  const resumed = await restarted.inspect(workspaceId);
  expect(resumed.closedReleases?.[0]).toMatchObject({ leaseId: lease.leaseId, outcome: "killed" });
  expect(killed).toEqual([8282]);
});

test("WorkspaceExecutor共享cwd、逐节点只释放租约；Execution收尾只封存worktree", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  let calls = 0;
  const nodeSnapshot = node("a");
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, (_, binding) => ({
    bindControl() {},
    bindWriter: binding.bindWriter,
    verifyExited: async () => true,
    execute: async actual => { calls += 1; expect(actual.cwd).toBe(workspace.cwd); await binding.bindWriter("test-group", { pgid: 4321, startedAt: "test-fingerprint" }); await writeFile(join(actual.cwd, "a.txt"), "managed\n"); return { ok: true }; },
  }));
  executor.bindControl({} as never);
  expect(await executor.execute(nodeSnapshot)).toEqual({ ok: true });
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(1);
  await expect((await GitRepository.open(workspace.cwd)).inspect()).resolves.toMatchObject({ head: authorization.baseCommit, changedPaths: ["a.txt"] });
  const completed = { ...nodeSnapshot, status: "completed" as const, result: { ok: true } };
  await executor.finalizeCompleted(completed);
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
  await expect((await GitRepository.open(workspace.cwd)).inspect()).resolves.toMatchObject({ head: authorization.baseCommit });
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
  await manager.finalizeSource(runId, config(workspaceId, authorization), ["a"]);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");

  const reopened = new WorkspaceExecutor(await WorkspaceManager.open(join(tmpdir(), crypto.randomUUID()), crypto.randomUUID()), runId, workspaceId, { execute: async () => null }, () => { throw new Error("不应重新创建writer"); });
  reopened.bindControl({} as never);
  await expect(reopened.finalizeCompleted(completed)).resolves.toBeUndefined();
  expect(calls).toBe(1);
});

test("写Execution的只读节点也在共享worktree中读取，不读主项目目录", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  let seen = "";
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, {
    execute: async actual => { seen = actual.cwd; expect(actual.request.cwd).toBe(workspace.cwd); return { read: true }; },
  }, () => { throw new Error("只读节点不应创建写writer"); });
  executor.bindControl({} as never);
  expect(await executor.execute(node("reviewer", 1, "read-only"))).toEqual({ read: true });
  expect(seen).toBe(workspace.cwd);
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
});

test("清理只接受已封存且干净checkout；锁、未封存与ignored内容拒绝", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await expect(manager.cleanup(workspaceId, runId, false)).rejects.toThrow("明确授权");
  await expect(manager.cleanup(workspaceId, runId, true)).rejects.toThrow("尚无最终封存");
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await expect(manager.cleanup(workspaceId, runId, true)).rejects.toThrow("锁");
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  await manager.release(lease, async () => true);
  const source = await manager.finalizeSource(runId, config(workspaceId, authorization));
  await writeFile(join(cwd, ".git", "info", "exclude"), "local.cache\n");
  await writeFile(join(workspace.cwd, "local.cache"), "unknown-content");
  await expect(manager.cleanup(workspaceId, runId, true)).rejects.toThrow("ignored");
  await rm(join(workspace.cwd, "local.cache"));
  const cleaned = await manager.cleanup(workspaceId, runId, true);
  expect(cleaned.cleanedAt).not.toBeNull();
  expect(await Bun.file(workspace.cwd).exists()).toBe(false);
  expect(await manager.inspectSource(runId)).toEqual(source);
});

test("首次dirty基线拒绝；显式排除后创建且同身份重试不重复分支", async () => {
  const { cwd, manager, workspaceId, authorization } = await fixture();
  await writeFile(join(cwd, "a.txt"), "dirty\n");
  await expect(manager.create(workspaceId, authorization)).rejects.toThrow("dirty");
  const approved = { ...authorization, excludeExistingDirty: true };
  const workspace = await manager.create(workspaceId, approved);
  expect(await manager.create(workspaceId, approved)).toEqual(workspace);
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("base\n");
  await expect(manager.create(workspaceId, { ...approved, authorizationId: crypto.randomUUID() })).rejects.toThrow("冲突");
});

test("封存成功但来源关联失败保留Git证据，重试只补关联", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "a.txt"), "saved\n");
  await manager.release(lease, async () => true);
  const write = spyOn(manager as unknown as { write: (...args: unknown[]) => Promise<void> }, "write").mockRejectedValueOnce(new Error("association failed"));
  try { await expect(manager.finalizeSource(runId, config(workspaceId, authorization))).rejects.toThrow("association failed"); } finally { write.mockRestore(); }
  expect(await manager.inspectSource(runId)).toBeNull();
  const result = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect(await manager.inspectSource(runId)).toEqual(result);
  expect(await Bun.file(join(authorization.repository, "a.txt")).text()).toBe("base\n");
});

test("清理意图已耐久但checkout先被移除时，重试只补关联不重复删除", async () => {
  const { root, manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  await manager.release(lease, async () => true);
  await manager.finalizeSource(runId, config(workspaceId, authorization));
  // 模拟清理崩溃：意图已耐久、checkout已移除、cleanedAt 未落盘。
  const recordPath = join(root, "state", "records", `${workspaceId}.json`);
  const record = JSON.parse(await Bun.file(recordPath).text());
  record.cleanupRequestedAt = new Date().toISOString(); record.cleanedAt = null;
  await writeFile(recordPath, JSON.stringify(record));
  await rm(workspace.cwd, { recursive: true, force: true });
  const cleaned = await manager.cleanup(workspaceId, runId, true);
  expect(cleaned.cleanedAt).not.toBeNull();
  expect(await manager.inspectSource(runId)).not.toBeNull();
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
});

test("交接后writer在受管worktree内提交，prepareExecution重试不误判为现场漂移", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  await writeFile(join(workspace.cwd, "a.txt"), "committed by worker\n");
  for (const args of [["add", "--", "a.txt"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "worker commit"]]) {
    const child = Bun.spawn(["/usr/bin/git", ...args], { cwd: workspace.cwd, stdout: "ignore", stderr: "pipe" });
    const err = await new Response(child.stderr).text();
    expect(await child.exited, err).toBe(0);
  }
  await expect(manager.prepareExecution(runId, config(workspaceId, authorization))).resolves.toBeUndefined();
  expect((await (await GitRepository.open(workspace.cwd)).inspect()).head).not.toBe(authorization.baseCommit);
});

test("续作resume先释放旧租约再补交接，顺序颠倒会拒绝派发", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const first = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "first", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "a.txt"), "one\n");
  await manager.release(first, async () => true);
  const prior = await manager.finalizeSource(runId, config(workspaceId, authorization));
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: prior.commit });
  await manager.prepareExecution(nextRun, nextConfig);
  const leaked = await manager.bindWriter(await manager.acquire(workspaceId, { runId: nextRun, nodeId: "repair", attempt: 1 }), "crashed", { pgid: 7373, startedAt: "fp-crashed" });
  expect(leaked.leaseId).toBeTruthy();
  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID(), { probe: async () => ({ state: "absent" }), killGroup: async () => {} });
  await expect(restarted.prepareExecution(nextRun, nextConfig)).rejects.toThrow("writer");
  await restarted.prepareResume(nextConfig, nextRun);
  await expect(restarted.prepareExecution(nextRun, nextConfig)).resolves.toBeUndefined();
});

test("现场指纹识别同一路径dirty内容变化，读取不创建commit或覆盖文件", async () => {
  const { cwd, authorization } = await fixture();
  const repo = await GitRepository.open(cwd);
  const first = await repo.sceneFingerprint();
  await writeFile(join(cwd, "a.txt"), "dirty-one\n");
  const second = await repo.sceneFingerprint();
  await writeFile(join(cwd, "a.txt"), "dirty-two\n");
  const third = await repo.sceneFingerprint();
  expect(second.state.changedPaths).toEqual(third.state.changedPaths);
  expect(second.hash).not.toBe(first.hash); expect(third.hash).not.toBe(second.hash);
  expect((await repo.inspect()).head).toBe(authorization.baseCommit);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("dirty-two\n");
});

test("现场指纹拒绝软链接和超限内容，不追读链接或接受不完整证据", async () => {
  const { cwd, root } = await fixture();
  const repo = await GitRepository.open(cwd);
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(cwd, "linked.txt"));
  await expect(repo.sceneFingerprint()).rejects.toThrow();
  expect(await Bun.file(join(root, "outside.txt")).text()).toBe("outside");
  await rm(join(cwd, "linked.txt"));
  await writeFile(join(cwd, "large.bin"), new Uint8Array(16 * 1024 * 1024 + 1));
  await expect(repo.sceneFingerprint()).rejects.toThrow("16MiB");
  expect((await repo.inspect()).changedPaths).toEqual(["large.bin"]);
});

test("工作文件回到HEAD但暂存区不同仍改变现场指纹，读取不清除暂存", async () => {
  const { cwd } = await fixture(), repo = await GitRepository.open(cwd);
  const original = await repo.sceneFingerprint();
  await writeFile(join(cwd, "a.txt"), "staged\n");
  const add = Bun.spawn(["/usr/bin/git", "add", "--", "a.txt"], { cwd, stdout: "ignore", stderr: "pipe" }); expect(await add.exited).toBe(0);
  await writeFile(join(cwd, "a.txt"), "base\n");
  const changed = await repo.sceneFingerprint(); expect(changed.hash).not.toBe(original.hash);
  expect(changed.state.changedPaths).toEqual(["a.txt"]);
  const read = Bun.spawn(["/usr/bin/git", "show", ":a.txt"], { cwd, stdout: "pipe", stderr: "pipe" }); expect(await new Response(read.stdout).text()).toBe("staged\n"); expect(await read.exited).toBe(0);
});

test("写Worker启动超时先核验退出并释放租约，自动重试不会留下双writer", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  let attempts = 0;
  let finalized = 0;
  const nodeSnapshot = node("a");
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, (_, binding) => ({
    bindControl() {},
    bindWriter: binding.bindWriter,
    verifyExited: async () => true,
    finalizePartial: async () => { finalized += 1; },
    execute: async () => {
      attempts += 1;
      await binding.bindWriter("retry-group", { pgid: 4321, startedAt: "test-fingerprint" });
      if (attempts === 1) throw new Error("ACP Worker 启动超时：initialize 超过 60000ms 未返回。");
      return { ok: true };
    },
  }));
  executor.bindControl({ hasRecordedNodeSession: () => false } as never);
  await expect(executor.execute(nodeSnapshot)).rejects.toThrow("启动超时");
  expect(finalized).toBe(1);
  expect((await manager.inspect(workspaceId)).leases).toEqual([]);
  expect(await executor.execute(nodeSnapshot)).toEqual({ ok: true });
  expect(attempts).toBe(2);
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(1);
  await executor.finalizeCompleted({ ...nodeSnapshot, status: "completed", result: { ok: true } });
  expect((await manager.inspect(workspaceId)).leases).toEqual([]);
});
