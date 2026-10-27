import { afterEach, expect, spyOn, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository } from "../../src/workspace/git-repository";
import { WorkspaceManager, type WorkspaceAuthorization } from "../../src/workspace/workspace-manager";
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
  await manager.release(second, async () => true);
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
  await expect(manager.abandonUnstarted(second)).rejects.toThrow("租约");
});

test("循环写节点按披露前缀取得租约，未披露前缀拒绝，结果保留在worktree", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  const dynamicAuthorization = { ...authorization, nodes: [], dynamicNodes: [{ nodeIdPrefix: "repair-" }] };
  const workspace = await manager.create(workspaceId, dynamicAuthorization);
  await expect(manager.acquire(workspaceId, { runId, nodeId: "hidden-1", attempt: 1 })).rejects.toThrow("未获");
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "repair-1", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "a.txt"), "repaired\n");
  await manager.release(lease, async () => true);
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("repaired\n");
});

test("写节点结果只保留在受管worktree，宿主不产生快照，主工作区不变", async () => {
  const { manager, workspaceId, authorization, runId, cwd, git } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "a.txt"), "result\n");
  await manager.release(lease, async () => true);
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("result\n");
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
  expect(await git("rev-parse", "HEAD")).toBe(authorization.baseCommit);
  expect(await git("diff", "--cached", "--name-only")).toBe("");
  const worktreeState = await (await GitRepository.open(workspace.cwd)).inspect();
  expect(worktreeState.head).toBe(authorization.baseCommit);
  expect(worktreeState.changedPaths).toEqual(["a.txt"]);
  // 宿主不记录任何成果对象或证据引用。
  expect(await git("for-each-ref", "--format=%(refname)", "refs/wave-flow")).toBe("");
});

test("续作复用同一worktree，续作head来自worktree当前inspect，主工作区始终保持未修改", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const first = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "first", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "a.txt"), "one\n");
  await manager.release(first, async () => true);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");

  // 宿主不创建封存commit；续作head取受管worktree当前真实HEAD。
  const head = (await (await GitRepository.open(workspace.cwd)).inspect()).head;
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head });
  await manager.prepareExecution(nextRun, nextConfig);
  await expect(manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 })).rejects.toThrow("旧执行");
  const second = await manager.bindWriter(await manager.acquire(workspaceId, { runId: nextRun, nodeId: "repair", attempt: 1 }), "second", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "b.txt"), "two\n");
  await manager.release(second, async () => true);
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("one\n");
  expect(await Bun.file(join(workspace.cwd, "b.txt")).text()).toBe("two\n");
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
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("managed\n");

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

test("清理需显式授权；锁与冲突拒绝，dirty与ignored内容随checkout删除", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await expect(manager.cleanup(workspaceId, false)).rejects.toThrow("明确授权");
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await expect(manager.cleanup(workspaceId, true)).rejects.toThrow("锁");
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  await manager.release(lease, async () => true);
  // 未提交内容与ignored文件都随checkout删除；宿主不做成果保全。
  await writeFile(join(cwd, ".git", "info", "exclude"), "local.cache\n");
  await writeFile(join(workspace.cwd, "local.cache"), "ignored content");
  const wgit = async (input: string | undefined, ...args: string[]) => {
    const child = Bun.spawn(["/usr/bin/git", ...args], { cwd: workspace.cwd, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (input !== undefined) { child.stdin!.write(input); child.stdin!.end(); }
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err); return out.trim();
  };
  const blobA = await wgit("conflict-a\n", "hash-object", "-w", "--stdin");
  const blobB = await wgit("conflict-b\n", "hash-object", "-w", "--stdin");
  await wgit(`100644 ${blobA} 1\ta.txt\n100644 ${blobB} 2\ta.txt\n`, "update-index", "--index-info");
  await expect(manager.cleanup(workspaceId, true)).rejects.toThrow("冲突");
  await wgit(undefined, "read-tree", "HEAD");
  const cleaned = await manager.cleanup(workspaceId, true);
  expect(cleaned.cleanedAt).not.toBeNull();
  expect(await Bun.file(workspace.cwd).exists()).toBe(false);
});

test("cleanup拒绝同仓库branch被替换的checkout，保留现场", async () => {
  const { manager, workspaceId, authorization, git } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  await git("-C", workspace.cwd, "switch", "-c", "codex/wf-other");
  await expect(manager.cleanup(workspaceId, true)).rejects.toThrow("身份");
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("ready\n");
  expect((await manager.inspect(workspaceId)).cleanedAt).toBeNull();
});

test("cleanup内部ENOENT不得误记已清理，目录与重试资格保留", async () => {
  const { manager, workspaceId, authorization } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  const removal = spyOn(GitRepository.prototype, "removeWorktree").mockRejectedValueOnce(Object.assign(new Error("internal ENOENT"), { code: "ENOENT" }));
  try { await expect(manager.cleanup(workspaceId, true)).rejects.toThrow("internal ENOENT"); } finally { removal.mockRestore(); }
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("ready\n");
  expect((await manager.inspect(workspaceId)).cleanedAt).toBeNull();
  await manager.cleanup(workspaceId, true);
  expect(await Bun.file(workspace.cwd).exists()).toBe(false);
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

test("清理意图已耐久但checkout先被移除时，重试只补关联不重复删除", async () => {
  const { root, manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group", { pgid: 54321, startedAt: "test-fingerprint" });
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  await manager.release(lease, async () => true);
  // 模拟清理崩溃：意图已耐久、checkout已移除、cleanedAt 未落盘。
  const recordPath = join(root, "state", "records", `${workspaceId}.json`);
  const record = JSON.parse(await Bun.file(recordPath).text());
  record.cleanupRequestedAt = new Date().toISOString(); record.cleanedAt = null;
  await writeFile(recordPath, JSON.stringify(record));
  await rm(workspace.cwd, { recursive: true, force: true });
  const cleaned = await manager.cleanup(workspaceId, true);
  expect(cleaned.cleanedAt).not.toBeNull();
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
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: (await (await GitRepository.open(workspace.cwd)).inspect()).head });
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

test("spawn 成功但 bindWriter 前崩溃：未决启动意图 fail closed，拒绝恢复与撤回，不杀未知 PID", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  // 模拟崩溃窗口现场：spawn 前启动意图已耐久，writerIdentity 仍为 null。
  const pending = await manager.beginWriterSpawn(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }));
  expect(pending.writerSpawnIntentAt).toBeTruthy();
  // 有意图的租约不能按“未启动”撤回；同租约重复标记幂等，不推进时间。
  await expect(manager.abandonUnstarted(pending)).rejects.toThrow("启动意图");
  expect(await manager.beginWriterSpawn(pending)).toEqual(pending);
  // 跨 Engine 恢复：probe 即使报告进程组不存在也不得放行——意图在、身份缺失，fail closed。
  let killed = 0;
  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID(), { probe: async () => ({ state: "absent" }), killGroup: async () => { killed += 1; } });
  await expect(restarted.prepareResume(config(workspaceId, authorization), runId)).rejects.toThrow("启动意图");
  expect(killed).toBe(0);
  const kept = await restarted.inspect(workspaceId);
  expect(kept.leases).toHaveLength(1);
  expect(kept.closedReleases).toBeUndefined();
  // spawn 实际失败（进程确定未创建）：撤回意图后租约才可放弃。
  const cleared = await manager.cancelWriterSpawn(pending);
  expect(cleared.writerSpawnIntentAt).toBeNull();
  await manager.abandonUnstarted(cleared);
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
});

test("无意图的未启动租约仍按 not-started 收尾；bindWriter 清除启动意图", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const plain = await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 });
  const pending = await manager.beginWriterSpawn(await manager.acquire(workspaceId, { runId, nodeId: "b", attempt: 1 }));
  const bound = await manager.bindWriter(pending, "group-b", { pgid: 54321, startedAt: "fp" });
  expect(bound.writerSpawnIntentAt).toBeNull();
  // 解绑 b 的绑定模拟回滚不可能；改为直接核验 plain 的 not-started 收尾。
  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID(), { probe: async () => ({ state: "absent" }), killGroup: async () => {} });
  // 含一条已绑定租约（probe absent → exited）与一条无意图未启动租约（not-started），均正常收尾。
  await restarted.prepareResume(config(workspaceId, authorization), runId);
  const record = await restarted.inspect(workspaceId);
  expect(record.leases).toHaveLength(0);
  expect(record.closedReleases?.map(entry => entry.outcome).sort()).toEqual(["exited", "not-started"]);
  expect(record.closedReleases?.find(entry => entry.leaseId === plain.leaseId)?.outcome).toBe("not-started");
});

test("WorkspaceExecutor：beginSpawn 后 createWriter 崩溃（spawn 后绑定前），租约保留且恢复 fail closed", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, async (_, binding) => {
    await binding.beginSpawn();
    throw new Error("transport spawn 后 Engine 崩溃");
  });
  executor.bindControl({} as never);
  await expect(executor.execute(node("a"))).rejects.toThrow("崩溃");
  // 撤回被拒绝，租约与意图原样保留。
  const record = await manager.inspect(workspaceId);
  expect(record.leases).toHaveLength(1);
  expect(record.leases[0]!.writerIdentity).toBeNull();
  expect(record.leases[0]!.writerSpawnIntentAt).toBeTruthy();
  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID(), { probe: async () => ({ state: "absent" }), killGroup: async () => {} });
  await expect(restarted.prepareResume(config(workspaceId, authorization), runId)).rejects.toThrow("启动意图");
  expect((await restarted.inspect(workspaceId)).leases).toHaveLength(1);
});

test("WorkspaceExecutor：底层 spawn 失败撤回意图后租约正常放弃，不留未决意图", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, async (_, binding) => {
    await binding.beginSpawn();
    // 底层 spawn 失败：进程确定未创建，撤回意图。
    await binding.cancelSpawn();
    throw new Error("spawn failed");
  });
  executor.bindControl({} as never);
  await expect(executor.execute(node("a"))).rejects.toThrow("spawn failed");
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
});

test("WorkspaceExecutor：stop 先于 execute 到达时不误报没有执行器，execute 拒绝且不产生租约或 writer", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  let created = 0;
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, () => { created += 1; throw new Error("不应创建writer"); });
  executor.bindControl({} as never);
  const target = node("a");
  // 启动意图登记：不再抛“写节点没有当前Engine可控制的执行器”。
  await executor.stop(target);
  await expect(executor.execute(target)).rejects.toThrow("已停止");
  expect(created).toBe(0);
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
});

test("WorkspaceExecutor：stop 在 acquire 后 createWriter 前到达时不创建 writer，租约撤回", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  let created = 0;
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, () => { created += 1; throw new Error("不应创建writer"); });
  executor.bindControl({} as never);
  const target = node("a");
  const acquire = spyOn(manager, "acquire").mockImplementation(async (...args: Parameters<WorkspaceManager["acquire"]>) => {
    const lease = await WorkspaceManager.prototype.acquire.apply(manager, args);
    // 租约已持有、writer 尚未创建：模拟 stop 在此窗口到达。
    await executor.stop(target);
    return lease;
  });
  await expect(executor.execute(target)).rejects.toThrow("已停止");
  acquire.mockRestore();
  expect(created).toBe(0);
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
});

test("WorkspaceExecutor：stop 在 createWriter 期间到达时绝不投递业务，租约撤回且 writer.execute 从未调用", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  let entered!: () => void, release!: () => void, delivered = 0, writerStopped = 0;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const holdGate = new Promise<void>(resolve => { release = resolve; });
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, async (_, binding) => {
    entered(); await holdGate;
    return {
      bindControl() {}, bindWriter: binding.bindWriter, verifyExited: async () => true,
      stop: async () => { writerStopped += 1; },
      execute: async () => { delivered += 1; return { ok: true }; },
    };
  });
  executor.bindControl({} as never);
  const target = node("a");
  const executing = executor.execute(target).then((): never => { throw new Error("投递不应成功"); }, (error: unknown) => error as Error);
  await enteredGate;
  // 与终审竞态一致：durable running 后 stop 到达时 writer 尚未登记 active。
  await executor.stop(target);
  release();
  const failure = await executing;
  expect(failure).toBeInstanceOf(WorkflowContractError);
  expect(failure.message).toContain("已停止");
  expect(delivered).toBe(0);
  // 未启动的 writer 不需要也不允许被停止兜底；租约无启动意图可直接撤回。
  expect(writerStopped).toBe(0);
  expect((await manager.inspect(workspaceId)).leases).toHaveLength(0);
});

test("WorkspaceExecutor：createWriter 内已耐久启动意图时 stop 收尾保留租约与现场，不吞错也不撤回", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  let entered!: () => void, release!: () => void;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const holdGate = new Promise<void>(resolve => { release = resolve; });
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, async (_, binding) => {
    // 自定义执行器在工厂内 spawn：意图耐久但身份未绑定时不得按未启动撤回。
    await binding.beginSpawn(); entered(); await holdGate;
    return {
      bindControl() {}, bindWriter: binding.bindWriter, verifyExited: async () => true,
      stop: async () => {},
      execute: async () => ({ ok: true }),
    };
  });
  executor.bindControl({} as never);
  const target = node("a");
  const executing = executor.execute(target).then((): never => { throw new Error("投递不应成功"); }, (error: unknown) => error as Error);
  await enteredGate;
  await executor.stop(target);
  release();
  const failure = await executing;
  expect(failure).toBeInstanceOf(WorkflowContractError);
  expect(failure.message).toContain("已停止");
  const record = await manager.inspect(workspaceId);
  expect(record.leases).toHaveLength(1);
  expect(record.leases[0]!.writerIdentity).toBeNull();
  expect(record.leases[0]!.writerSpawnIntentAt).toBeTruthy();
});
