import { afterEach, expect, spyOn, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository } from "../../src/workspace/git-repository";
import { SourcePersistenceError, isRetryableSourceError, WorkspaceManager, type WorkspaceAuthorization } from "../../src/workspace/workspace-manager";
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
  const first = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group-a");
  const second = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "b", attempt: 1 }), "group-b");
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

test("Execution收尾一次性封存共享worktree并自动应用，主工作区保持未提交", async () => {
  const { manager, workspaceId, authorization, runId, cwd, git } = await fixture();
  await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group");
  await writeFile(join((await manager.inspect(workspaceId)).cwd, "a.txt"), "result\n");
  await manager.release(lease, async () => true);
  const source = await manager.finalizeSource(runId, config(workspaceId, authorization), ["a", "b"]);
  expect("at" in source.applied).toBe(true);
  expect(source.paths).toEqual(["a.txt"]);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("result\n");
  expect(await git("rev-parse", "HEAD")).toBe(authorization.baseCommit);
  expect(await git("diff", "--cached", "--name-only")).toBe("");
  expect((await manager.inspect(workspaceId)).lastApplied).toMatchObject({ commit: source.commit, executionId: runId });
  expect(await manager.finalizeSource(runId, config(workspaceId, authorization))).toEqual(source);
});

test("主工作区dirty时记录未应用原因，处理后重试补应用", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group");
  await writeFile(join((await manager.inspect(workspaceId)).cwd, "a.txt"), "result\n");
  await manager.release(lease, async () => true);
  await writeFile(join(cwd, "user.txt"), "keep");
  const source = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect(source.applied).toMatchObject({ skippedAt: expect.any(String), reason: expect.stringContaining("未提交") });
  expect(await manager.canRetrySource(runId)).toBe(true);
  await rm(join(cwd, "user.txt"));
  const retried = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect("at" in retried.applied).toBe(true);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("result\n");
  expect(await manager.canRetrySource(runId)).toBe(false);
});

test("续作复用同一worktree，并在上次自动应用的未提交现场上更新", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const first = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "first");
  await writeFile(join(workspace.cwd, "a.txt"), "one\n");
  await manager.release(first, async () => true);
  const prior = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("one\n");

  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: prior.commit });
  await manager.prepareExecution(nextRun, nextConfig);
  await expect(manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 })).rejects.toThrow("旧执行");
  const second = await manager.bindWriter(await manager.acquire(workspaceId, { runId: nextRun, nodeId: "repair", attempt: 1 }), "second");
  await writeFile(join(workspace.cwd, "b.txt"), "two\n");
  await manager.release(second, async () => true);
  const source = await manager.finalizeSource(nextRun, nextConfig, ["repair"]);
  expect("at" in source.applied).toBe(true);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("one\n");
  expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("two\n");
  expect((await (await GitRepository.open(cwd)).inspect()).changedPaths).toEqual(["a.txt", "b.txt"]);
});

test("续作拒绝旧批准、HEAD漂移与未退出writer；冻结后不能换HEAD", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: authorization.baseCommit });
  await expect(manager.prepareExecution(nextRun, { ...nextConfig, authorization: { ...renewed, authorizationId: authorization.authorizationId } })).rejects.toThrow("独立新授权");
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group");
  await expect(manager.prepareExecution(nextRun, nextConfig)).rejects.toThrow("writer未交接");
  await manager.release(lease, async () => true);
  const drifted = { ...nextConfig, continuation: { ...nextConfig.continuation!, head: "b".repeat(40) } };
  await expect(manager.prepareExecution(nextRun, drifted)).rejects.toThrow("现场变化");
  await expect(manager.prepareExecution(nextRun, nextConfig)).resolves.toBeUndefined();
  await expect(manager.prepareExecution(nextRun, drifted)).rejects.toThrow("来源已冻结");
  expect((await manager.inspect(workspaceId)).executionAuthorizations).toHaveLength(2);
});

test("显式resume释放旧Engine租约并保留共享worktree改动，不伪装自动重连", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "old-group");
  const workspace = await manager.inspect(workspaceId);
  await writeFile(join(workspace.cwd, "a.txt"), "partial\n");

  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID());
  await restarted.prepareResume(config(workspaceId, authorization), runId);
  const resumed = await restarted.inspect(workspaceId);
  expect(resumed.leases).toHaveLength(0);
  expect(resumed.staleReleases).toHaveLength(1);
  expect(resumed.staleReleases?.[0]?.leaseId).toBe(lease.leaseId);
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("partial\n");
  const next = await restarted.bindWriter(await restarted.acquire(workspaceId, { runId, nodeId: "a", attempt: 2 }), "new-group");
  await restarted.release(next, async () => true);
  const newer = crypto.randomUUID(), renewal = { ...authorization, authorizationId: crypto.randomUUID(), nodes: [{ nodeId: "repair" }] };
  await restarted.prepareExecution(newer, config(workspaceId, renewal, { executionId: runId, workspaceId, head: authorization.baseCommit }));
  await expect(restarted.prepareResume(config(workspaceId, authorization), runId)).rejects.toThrow("旧版恢复只读");
});

test("WorkspaceExecutor共享cwd、逐节点只释放租约；Execution收尾才封存并自动应用", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  let calls = 0;
  const nodeSnapshot = node("a");
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, (_, binding) => ({
    bindControl() {},
    bindWriter: binding.bindWriter,
    verifyExited: async () => true,
    execute: async actual => { calls += 1; expect(actual.cwd).toBe(workspace.cwd); await binding.bindWriter("test-group"); await writeFile(join(actual.cwd, "a.txt"), "managed\n"); return { ok: true }; },
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
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("managed\n");

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
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group");
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
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group");
  await writeFile(join(workspace.cwd, "a.txt"), "saved\n");
  await manager.release(lease, async () => true);
  const write = spyOn(manager as unknown as { write: (...args: unknown[]) => Promise<void> }, "write").mockRejectedValueOnce(new Error("association failed"));
  try { await expect(manager.finalizeSource(runId, config(workspaceId, authorization))).rejects.toThrow("association failed"); } finally { write.mockRestore(); }
  expect(await manager.inspectSource(runId)).toBeNull();
  const result = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect(await manager.inspectSource(runId)).toEqual(result);
  expect(await Bun.file(join(authorization.repository, "a.txt")).text()).toBe("saved\n");
});

test("清理意图已耐久但checkout先被移除时，重试只补关联不重复删除", async () => {
  const { root, manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  const lease = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "group");
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
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("ready\n");
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
  const first = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "first");
  await writeFile(join(workspace.cwd, "a.txt"), "one\n");
  await manager.release(first, async () => true);
  const prior = await manager.finalizeSource(runId, config(workspaceId, authorization));
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: prior.commit });
  await manager.prepareExecution(nextRun, nextConfig);
  const leaked = await manager.bindWriter(await manager.acquire(workspaceId, { runId: nextRun, nodeId: "repair", attempt: 1 }), "crashed");
  expect(leaked.leaseId).toBeTruthy();
  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID());
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

test("旧执行跳过应用后，较新接续已应用时重试不会回退新现场", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const first = await manager.bindWriter(await manager.acquire(workspaceId, { runId, nodeId: "a", attempt: 1 }), "first");
  await writeFile(join(workspace.cwd, "a.txt"), "one\n");
  await manager.release(first, async () => true);
  // 主工作区 dirty：E1 记录未应用原因。
  await writeFile(join(cwd, "user.txt"), "keep");
  const skipped = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect("skippedAt" in skipped.applied).toBe(true);
  await rm(join(cwd, "user.txt"));

  // E2 接续同一 worktree 写入并成功应用，主工作区进入 C2 现场。
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: skipped.commit });
  await manager.prepareExecution(nextRun, nextConfig);
  const second = await manager.bindWriter(await manager.acquire(workspaceId, { runId: nextRun, nodeId: "repair", attempt: 1 }), "second");
  await writeFile(join(workspace.cwd, "b.txt"), "two\n");
  await manager.release(second, async () => true);
  const applied = await manager.finalizeSource(nextRun, nextConfig, ["repair"]);
  expect("at" in applied.applied).toBe(true);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("one\n");
  expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("two\n");

  // 旧 E1 的补应用不能把主工作区回退到 C1。
  const retried = await manager.finalizeSource(runId, config(workspaceId, authorization));
  expect("skippedAt" in retried.applied).toBe(true);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("one\n");
  expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("two\n");
});
