import { afterEach, expect, spyOn, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository } from "../../src/workspace/git-repository";
import { WorkspaceManager, type WorkspaceAuthorization } from "../../src/workspace/workspace-manager";
import { WorkflowContractError } from "../../src/workflow/errors";
import { WorkspaceExecutor } from "../../src/workspace/workspace-executor";
import type { AgentNodeSnapshot } from "../../src/runtime/run-types";
import type { ExecutionWorkspaceConfig } from "../../src/workspace/execution-workspaces";

// 多次真实Git子进程的端到端测试使用明确预算，避免默认5s杀进程产生伪逻辑错误。
const test = (name: string, run: () => Promise<void>, timeout = 15_000) => bunTest(name, run, timeout);

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
/** 清理时由 Engine 提供的写者围栏证明；普通用例无存活写者。 */
const noWriters = async () => {};

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

test("写入门禁按节点授权放行，未授权、清理中或已清理的worktree拒绝writer", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  await expect(manager.assertWriterAllowed(workspaceId, runId, "a")).resolves.toBeUndefined();
  await expect(manager.assertWriterAllowed(workspaceId, runId, "ghost")).rejects.toThrow("未获");
  await expect(manager.assertWriterAllowed(workspaceId, crypto.randomUUID(), "a")).rejects.toThrow("较新Execution");
  // 门禁只校验授权、清理状态、冲突与交接 HEAD，不产生逐 writer 记录。
  const record = await manager.inspect(workspaceId);
  expect(Object.keys(record)).not.toContain("leases");
  await manager.cleanup(workspaceId, true, runId, noWriters);
  await expect(manager.assertWriterAllowed(workspaceId, runId, "a")).rejects.toThrow("已清理");
});

test("循环写节点按披露前缀通过写入门禁，未披露前缀拒绝，结果保留在worktree", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  const dynamicAuthorization = { ...authorization, nodes: [], dynamicNodes: [{ nodeIdPrefix: "repair-" }] };
  const workspace = await manager.create(workspaceId, dynamicAuthorization);
  await expect(manager.assertWriterAllowed(workspaceId, runId, "hidden-1")).rejects.toThrow("未获");
  await manager.assertWriterAllowed(workspaceId, runId, "repair-1");
  await writeFile(join(workspace.cwd, "a.txt"), "repaired\n");
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("repaired\n");
});

test("写节点结果只保留在受管worktree，宿主不产生快照，主工作区不变", async () => {
  const { manager, workspaceId, authorization, runId, cwd, git } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await manager.assertWriterAllowed(workspaceId, runId, "a");
  await writeFile(join(workspace.cwd, "a.txt"), "result\n");
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
  await manager.assertWriterAllowed(workspaceId, runId, "a");
  await writeFile(join(workspace.cwd, "a.txt"), "one\n");
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");

  // 宿主不创建封存commit；续作head取受管worktree当前真实HEAD。
  const head = (await (await GitRepository.open(workspace.cwd)).inspect()).head;
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head });
  await manager.prepareExecution(nextRun, nextConfig);
  await expect(manager.assertWriterAllowed(workspaceId, runId, "a")).rejects.toThrow("旧执行");
  await manager.assertWriterAllowed(workspaceId, nextRun, "repair");
  await writeFile(join(workspace.cwd, "b.txt"), "two\n");
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("one\n");
  expect(await Bun.file(join(workspace.cwd, "b.txt")).text()).toBe("two\n");
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
  expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("base\n");
  expect((await (await GitRepository.open(cwd)).inspect()).changedPaths).toEqual([]);
});

test("续作拒绝旧批准与HEAD漂移；冻结后不能换HEAD", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: authorization.baseCommit });
  await expect(manager.prepareExecution(nextRun, { ...nextConfig, authorization: { ...renewed, authorizationId: authorization.authorizationId } })).rejects.toThrow("独立新授权");
  const drifted = { ...nextConfig, continuation: { ...nextConfig.continuation!, head: "b".repeat(40) } };
  await expect(manager.prepareExecution(nextRun, drifted)).rejects.toThrow("现场变化");
  await expect(manager.prepareExecution(nextRun, nextConfig)).resolves.toBeUndefined();
  await expect(manager.prepareExecution(nextRun, drifted)).rejects.toThrow("来源已冻结");
  expect((await manager.inspect(workspaceId)).executionAuthorizations).toHaveLength(2);
});

test("显式resume只核验授权、仓库身份与冲突，保留共享worktree改动", async () => {
  const { root, manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const workspace = await manager.inspect(workspaceId);
  await writeFile(join(workspace.cwd, "a.txt"), "partial\n");

  const restarted = await WorkspaceManager.open(join(root, "state"), crypto.randomUUID());
  await restarted.prepareResume(config(workspaceId, authorization), runId);
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("partial\n");
  // 恢复后仍可派发新 attempt 的 writer。
  await restarted.assertWriterAllowed(workspaceId, runId, "a");
  // 授权漂移拒绝原版恢复。
  await expect(restarted.prepareResume(config(workspaceId, { ...authorization, authorizationId: crypto.randomUUID() }), runId)).rejects.toThrow("授权");
  // 已交接给新 Execution 后旧版恢复只读。
  const newer = crypto.randomUUID(), renewal = { ...authorization, authorizationId: crypto.randomUUID(), nodes: [{ nodeId: "repair" }] };
  await restarted.prepareExecution(newer, config(workspaceId, renewal, { executionId: runId, workspaceId, head: authorization.baseCommit }));
  await expect(restarted.prepareResume(config(workspaceId, authorization), runId)).rejects.toThrow("旧版恢复只读");
});

test("清理需显式授权与写者围栏证明；冲突拒绝，dirty与ignored内容随checkout删除", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await expect(manager.cleanup(workspaceId, false, runId, noWriters)).rejects.toThrow("明确授权");
  await expect(manager.cleanup(workspaceId, true, runId, undefined as never)).rejects.toThrow("写者围栏证明");
  await expect(manager.cleanup(workspaceId, true, runId, async () => { throw new WorkflowContractError("写者仍存活"); })).rejects.toThrow("仍存活");
  expect(await Bun.file(join(workspace.cwd, "a.txt")).exists()).toBe(true);
  await manager.assertWriterAllowed(workspaceId, runId, "a");
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
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
  await expect(manager.cleanup(workspaceId, true, runId, noWriters)).rejects.toThrow("冲突");
  await wgit(undefined, "read-tree", "HEAD");
  const cleaned = await manager.cleanup(workspaceId, true, runId, noWriters);
  expect(cleaned.cleanedAt).not.toBeNull();
  expect(await Bun.file(workspace.cwd).exists()).toBe(false);
});

test("cleanup拒绝同仓库branch被替换的checkout，保留现场", async () => {
  const { manager, workspaceId, authorization, git } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  await git("-C", workspace.cwd, "switch", "-c", "codex/wf-other");
  await expect(manager.cleanup(workspaceId, true, crypto.randomUUID(), noWriters)).rejects.toThrow("身份");
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("ready\n");
  expect((await manager.inspect(workspaceId)).cleanedAt).toBeNull();
});

test("cleanup内部ENOENT不得误记已清理，目录与重试资格保留", async () => {
  const { manager, workspaceId, authorization } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  const removal = spyOn(GitRepository.prototype, "removeWorktree").mockRejectedValueOnce(Object.assign(new Error("internal ENOENT"), { code: "ENOENT" }));
  try { await expect(manager.cleanup(workspaceId, true, crypto.randomUUID(), noWriters)).rejects.toThrow("internal ENOENT"); } finally { removal.mockRestore(); }
  expect(await Bun.file(join(workspace.cwd, "a.txt")).text()).toBe("ready\n");
  expect((await manager.inspect(workspaceId)).cleanedAt).toBeNull();
  await manager.cleanup(workspaceId, true, crypto.randomUUID(), noWriters);
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
  const { root, manager, workspaceId, authorization, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await writeFile(join(workspace.cwd, "a.txt"), "ready\n");
  // 模拟清理崩溃：意图已耐久、checkout已移除、cleanedAt 未落盘。
  const recordPath = join(root, "state", "records", `${workspaceId}.json`);
  const record = JSON.parse(await Bun.file(recordPath).text());
  record.cleanupRequestedAt = new Date().toISOString(); record.cleanedAt = null;
  await writeFile(recordPath, JSON.stringify(record));
  await rm(workspace.cwd, { recursive: true, force: true });
  const cleaned = await manager.cleanup(workspaceId, true, crypto.randomUUID(), noWriters);
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

test("writer scratch key 只接受节点身份字符，每次调用生成独立目录", async () => {
  const { manager } = await fixture();
  const scratch = await manager.createScratch("a:1");
  expect(scratch).toContain("/scratch/a:1.");
  expect((await manager.createScratch("a:1"))).not.toBe(scratch);
  await expect(manager.createScratch("../escape")).rejects.toThrow("无效");
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

test("WorkspaceExecutor共享cwd、完成后交接writer；Execution收尾只封存worktree", async () => {
  const { manager, workspaceId, authorization, runId, cwd } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  let calls = 0, finalized = 0, scratch = "";
  const nodeSnapshot = node("a");
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, (_, binding) => ({
    bindControl() {},
    execute: async actual => { calls += 1; scratch = binding.scratch; expect(actual.cwd).toBe(workspace.cwd); expect(binding.cwd).toBe(workspace.cwd); expect(await stat(binding.scratch).then(() => true, () => false)).toBe(true); await writeFile(join(actual.cwd, "a.txt"), "managed\n"); return { ok: true }; },
    finalizeCompleted: async () => { finalized += 1; },
  }));
  executor.bindControl({} as never);
  expect(await executor.execute(nodeSnapshot)).toEqual({ ok: true });
  expect(finalized).toBe(1);
  await expect((await GitRepository.open(workspace.cwd)).inspect()).resolves.toMatchObject({ head: authorization.baseCommit, changedPaths: ["a.txt"] });
  const completed = { ...nodeSnapshot, status: "completed" as const, result: { ok: true } };
  await executor.finalizeCompleted(completed);
  expect(finalized).toBe(2);
  // 节点收尾后私有 scratch 被删除，不随 Engine 生命周期累积。
  expect(await stat(scratch).then(() => true, () => false)).toBe(false);
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
  expect(Object.keys(await manager.inspect(workspaceId))).not.toContain("leases");
});

test("WorkspaceExecutor：写Worker启动超时先核验退出，自动重试不会留下双writer", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  let attempts = 0, finalized = 0;
  const nodeSnapshot = node("a");
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, () => ({
    bindControl() {},
    finalizePartial: async () => { finalized += 1; },
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ACP Worker 启动超时：initialize 超过 60000ms 未返回。");
      return { ok: true };
    },
  }));
  executor.bindControl({ hasRecordedNodeSession: () => false } as never);
  await expect(executor.execute(nodeSnapshot)).rejects.toThrow("启动超时");
  expect(finalized).toBe(1);
  expect(await executor.execute(nodeSnapshot)).toEqual({ ok: true });
  expect(attempts).toBe(2);
  await executor.finalizeCompleted({ ...nodeSnapshot, status: "completed", result: { ok: true } });
});

test("WorkspaceExecutor：stop 先于 execute 到达时不误报没有执行器，execute 拒绝且不创建 writer", async () => {
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
});

test("WorkspaceExecutor：stop 在写入门禁后 createWriter 前到达时不创建 writer", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  let created = 0;
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, () => { created += 1; throw new Error("不应创建writer"); });
  executor.bindControl({} as never);
  const target = node("a");
  const gate = spyOn(manager, "assertWriterAllowed").mockImplementation(async (...args: Parameters<WorkspaceManager["assertWriterAllowed"]>) => {
    await WorkspaceManager.prototype.assertWriterAllowed.apply(manager, args);
    // 门禁已通过、writer 尚未创建：模拟 stop 在此窗口到达。
    await executor.stop(target);
  });
  await expect(executor.execute(target)).rejects.toThrow("已停止");
  gate.mockRestore();
  expect(created).toBe(0);
});

test("WorkspaceExecutor：stop 在 createWriter 期间到达时绝不投递业务且 writer 被关闭", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  await manager.create(workspaceId, authorization);
  let entered!: () => void, release!: () => void, delivered = 0, writerStopped = 0;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const holdGate = new Promise<void>(resolve => { release = resolve; });
  const executor = new WorkspaceExecutor(manager, runId, workspaceId, { execute: async () => { throw new Error("不应使用只读执行器"); } }, async () => {
    entered(); await holdGate;
    return {
      bindControl() {},
      stop: async () => { writerStopped += 1; },
      execute: async () => { delivered += 1; return { ok: true }; },
    };
  });
  executor.bindControl({} as never);
  const target = node("a");
  const executing = executor.execute(target).then((): never => { throw new Error("投递不应成功"); }, (error: unknown) => error as Error);
  await enteredGate;
  // durable running 后 stop 到达，writer 尚未登记 active：关闭刚创建的 writer，不投递业务。
  await executor.stop(target);
  release();
  const failure = await executing;
  expect(failure).toBeInstanceOf(WorkflowContractError);
  expect(failure.message).toContain("已停止");
  expect(delivered).toBe(0);
  expect(writerStopped).toBe(1);
});

test("共享worktree只允许最近交接的Execution清理，旧执行不能删除正在写入的现场", async () => {
  const { manager, workspaceId, authorization, runId } = await fixture();
  const workspace = await manager.create(workspaceId, authorization);
  await manager.prepareExecution(runId, config(workspaceId, authorization));
  const nextRun = crypto.randomUUID(), renewed = { ...authorization, authorizationId: crypto.randomUUID(), approvedAt: new Date().toISOString(), nodes: [{ nodeId: "repair" }] };
  const nextConfig = config(workspaceId, renewed, { executionId: runId, workspaceId, head: (await (await GitRepository.open(workspace.cwd)).inspect()).head });
  await manager.prepareExecution(nextRun, nextConfig);
  // worktree 已交接给新执行：旧执行即使已终态也不能删除它。
  await expect(manager.cleanup(workspaceId, true, runId, noWriters)).rejects.toThrow("较新Execution");
  expect(await Bun.file(join(workspace.cwd, "a.txt")).exists()).toBe(true);
  expect((await manager.inspect(workspaceId)).cleanedAt).toBeNull();
  await manager.cleanup(workspaceId, true, nextRun, noWriters);
  expect((await manager.inspect(workspaceId)).cleanedAt).not.toBeNull();
});

test("旧版工作区记录 fail closed，不做半迁移", async () => {
  const { root, manager, workspaceId, authorization } = await fixture();
  await manager.create(workspaceId, authorization);
  const path = join(root, "state", "records", `${workspaceId}.json`);
  const record = JSON.parse(await Bun.file(path).text());
  record.leases = [];
  await writeFile(path, JSON.stringify(record));
  await expect(manager.inspect(workspaceId)).rejects.toThrow("不兼容");
});
