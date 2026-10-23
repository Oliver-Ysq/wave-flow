import { afterEach, expect, test as bunTest } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitRepository, type GitSealRequest } from "../../src/workspace/git-repository";

// 真实Git进程验证不是内存单测，保留明确15s总预算。
const test = (name: string, run: () => Promise<void>, timeout = 15_000) => bunTest(name, run, timeout);

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(stderr); return stdout.trim();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-git-test-"))); directories.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd); await git(cwd, "init", "-b", "main");
  await writeFile(join(cwd, "a.txt"), "base\n"); await writeFile(join(cwd, "b.txt"), "base\n");
  await git(cwd, "add", "--", "a.txt", "b.txt"); await git(cwd, "commit", "-m", "fixture");
  const repo = await GitRepository.open(cwd), base = (await repo.inspect()).head;
  const request: GitSealRequest = { requestId: crypto.randomUUID(), baseCommit: base, startCommit: base };
  return { root, cwd, repo, base, request };
}

test("封存共享worktree为单父commit；应用后主工作区保持未提交、未暂存、不移动分支", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const sealed = await worker.seal(request);
  expect(sealed.commit).not.toBe(base);
  const retried = await worker.seal(request);
  expect(retried.commit).toBe(sealed.commit);
  expect(retried.paths).toEqual(sealed.paths);
  expect(retried.unchanged).toBe(true);
  expect(await git(worker.cwd, "show", "-s", "--format=%P", sealed.commit)).toBe(base);
  expect((await worker.inspect()).changedPaths).toEqual([]);
  expect(await repo.review(base, sealed.commit)).toEqual({ baseCommit: base, sourceCommit: sealed.commit, paths: ["a.txt"] });
  expect((await repo.fileDiff(base, sealed.commit, "a.txt")).patch).toContain("+result");
  await expect(repo.fileDiff(base, sealed.commit, ".git/config")).rejects.toThrow("不属于");
  expect(await repo.inspect()).toMatchObject({ head: base, changedPaths: [] });

  expect(await repo.applyCommit(sealed.commit, base)).toEqual(["a.txt"]);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("result\n");
  expect(await git(cwd, "rev-parse", "HEAD")).toBe(base);
  expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("");
  expect((await repo.inspect()).changedPaths).toEqual(["a.txt"]);
});

test("主工作区dirty、HEAD漂移或冲突时拒绝自动应用，不覆盖现场", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const sealed = await worker.seal(request);

  await writeFile(join(cwd, "user.txt"), "keep");
  await expect(repo.applyCommit(sealed.commit, base)).rejects.toThrow("未提交");
  expect(await Bun.file(join(cwd, "user.txt")).text()).toBe("keep");
  await rm(join(cwd, "user.txt"));

  await writeFile(join(cwd, "b.txt"), "staged\n"); await git(cwd, "add", "b.txt"); await writeFile(join(cwd, "b.txt"), "base\n");
  await expect(repo.applyCommit(sealed.commit, base)).rejects.toThrow("未提交");
  expect(await git(cwd, "show", ":b.txt")).toBe("staged");
  await git(cwd, "restore", "--staged", "b.txt");

  await git(cwd, "commit", "--allow-empty", "-m", "external");
  await expect(repo.applyCommit(sealed.commit, base)).rejects.toThrow("偏离");
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
});

test("应用删除文件且不覆盖ignored现场", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await rm(join(worker.cwd, "b.txt"));
  const sealed = await worker.seal(request);
  expect(sealed.paths).toEqual(["b.txt"]);
  await repo.applyCommit(sealed.commit, base);
  expect(await Bun.file(join(cwd, "b.txt")).exists()).toBe(false);
  expect((await repo.inspect()).changedPaths).toEqual(["b.txt"]);
});

test("无改动复用HEAD不生成空commit；仅暂存区有变化时拒绝空成果", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  expect(await worker.seal(request)).toEqual({ requestId: request.requestId, commit: base, unchanged: true, paths: [] });
  await writeFile(join(worker.cwd, "a.txt"), "staged\n");
  const add = Bun.spawn(["/usr/bin/git", "add", "--", "a.txt"], { cwd: worker.cwd, stdout: "ignore", stderr: "pipe" }); expect(await add.exited).toBe(0);
  await writeFile(join(worker.cwd, "a.txt"), "base\n");
  await expect(worker.seal({ ...request, requestId: crypto.randomUUID() })).rejects.toThrow("暂存区");
  expect(await git(worker.cwd, "show", ":a.txt")).toBe("staged");
});

test("tracked始终纳入，gitignored与未跟踪node_modules不收集，特殊路径通过NUL暂存", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, ".gitignore"), "*.log\n"); await writeFile(join(worker.cwd, "debug.log"), "ignored");
  await mkdir(join(worker.cwd, "node_modules")); await writeFile(join(worker.cwd, "node_modules", "dep"), "ignored dependency");
  await writeFile(join(worker.cwd, "[x] space.ts"), "new");
  const saved = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  expect(saved.paths).toEqual([".gitignore", "[x] space.ts"]);
  expect((await worker.inspect()).changedPaths).toEqual([]);
  expect(await Bun.file(join(worker.cwd, "debug.log")).text()).toBe("ignored");
  expect((await repo.inspect()).head).toBe(base);
});

test("二进制和大文本diff明确省略，成果文件仍完整保存", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "image.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(worker.cwd, "large.txt"), "line content\n".repeat(170000));
  const saved = await worker.seal(request);
  expect(saved.paths).toEqual(["image.bin", "large.txt"]);
  expect(await repo.fileDiff(base, saved.commit, "image.bin")).toMatchObject({ omitted: true, reason: "binary" });
  expect(await repo.fileDiff(base, saved.commit, "large.txt")).toMatchObject({ omitted: true, reason: "too-large", patch: "" });
  expect(Buffer.byteLength(await Bun.file(join(worker.cwd, "large.txt")).text())).toBeGreaterThan(2_000_000);
}, 20_000);

test("禁止主工作区封存、越界worktree、符号链接与Git attributes", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  await expect(repo.seal(request)).rejects.toThrow("非受管分支");
  await git(cwd, "switch", "-c", "codex/wf-user-main");
  await expect(repo.seal(request)).rejects.toThrow("主工作区");
  await expect(repo.createWorktree(join(cwd, "worker"), "codex/wf-worker", base)).rejects.toThrow("之外");
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await symlink(join(cwd, "a.txt"), join(worker.cwd, "link"));
  await expect(worker.seal({ ...request })).rejects.toThrow("符号链接");
  await rm(join(worker.cwd, "link")); await writeFile(join(worker.cwd, ".gitattributes"), "*.txt filter=evil\n");
  await expect(worker.seal({ ...request })).rejects.toThrow("attributes");
});

test("tracked .gitattributes 不再阻断仓库打开", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, ".gitattributes"), "*.txt text eol=lf\n");
  await git(cwd, "add", "--", ".gitattributes");
  await git(cwd, "commit", "-m", "tracked attributes");
  await expect(GitRepository.open(cwd)).resolves.toBeDefined();
});

test("仓库已有但未改动的 tracked symlink 不阻断封存与应用，修改 symlink 仍拒绝", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  await symlink("a.txt", join(cwd, "link"));
  await git(cwd, "add", "--", "link");
  await git(cwd, "commit", "-m", "tracked symlink");
  const reopened = await GitRepository.open(cwd);
  const trackedBase = (await reopened.inspect()).head;
  const worker = await reopened.createWorktree(join(root, "worker-link"), "codex/wf-worker-link", trackedBase);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const sealed = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: trackedBase, startCommit: trackedBase });
  expect(sealed.paths).toEqual(["a.txt"]);
  await reopened.applyCommit(sealed.commit, trackedBase);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("result\n");
  expect((await lstat(join(cwd, "link"))).isSymbolicLink()).toBe(true);

  await rm(join(worker.cwd, "link"));
  await symlink("b.txt", join(worker.cwd, "link"));
  await expect(worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: sealed.commit })).rejects.toThrow("符号链接");
});

test("封存接受worktree内已有commit并包含其全部历史", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "committed\n");
  await git(worker.cwd, "commit", "-am", "agent commit");
  await writeFile(join(worker.cwd, "b.txt"), "uncommitted\n");
  const sealed = await worker.seal({ ...request, startCommit: base });
  expect(sealed.paths).toEqual(["a.txt", "b.txt"]);
  expect(await git(worker.cwd, "rev-list", "--count", `${base}..${sealed.commit}`)).toBe("2");
  await repo.applyCommit(sealed.commit, base);
  expect(await Bun.file(join(repo.cwd, "a.txt")).text()).toBe("committed\n");
  expect(await Bun.file(join(repo.cwd, "b.txt")).text()).toBe("uncommitted\n");
});

test("本地 hooks/filters/include 不再阻断打开，Wave Flow 不执行 hooks", async () => {
  const { cwd } = await fixture();
  const marker = join(cwd, "hook-ran");
  await writeFile(join(cwd, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch '${marker}'\n`);
  await expect(GitRepository.open(cwd)).resolves.toBeDefined();
  expect(await Bun.file(marker).exists()).toBe(false);
  await rm(join(cwd, ".git", "hooks", "pre-commit"));
  await git(cwd, "config", "filter.evil.clean", "false");
  await expect(GitRepository.open(cwd)).resolves.toBeDefined();
});

test("续作自动应用能删除/回退上一Execution新增的文件，后续续作不被死锁", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "new.txt"), "e1\n");
  const c1 = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  expect(await repo.applyCommit(c1.commit, base)).toEqual(["new.txt"]);
  expect(await Bun.file(join(repo.cwd, "new.txt")).exists()).toBe(true);
  await rm(join(worker.cwd, "new.txt"));
  const c2 = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: c1.commit });
  expect(c2.paths).toEqual([]);
  expect(await repo.applyCommit(c2.commit, base, c1.commit)).toEqual([]);
  expect(await Bun.file(join(repo.cwd, "new.txt")).exists()).toBe(false);
  expect((await repo.inspect()).changedPaths).toEqual([]);
  await writeFile(join(worker.cwd, "later.txt"), "e3\n");
  const c3 = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: c2.commit });
  expect(await repo.applyCommit(c3.commit, base, c2.commit)).toEqual(["later.txt"]);
  expect((await repo.inspect()).changedPaths).toEqual(["later.txt"]);
});

test("续作应用拒绝并保留仅暂存区中的用户内容", async () => {
  const { root, cwd, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "new.txt"), "e1\n");
  const c1 = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  await repo.applyCommit(c1.commit, base);
  await writeFile(join(cwd, "a.txt"), "USER STAGED\n"); await git(cwd, "add", "--", "a.txt"); await writeFile(join(cwd, "a.txt"), "base\n");
  await writeFile(join(worker.cwd, "later.txt"), "e2\n");
  const c2 = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: c1.commit });
  await expect(repo.applyCommit(c2.commit, base, c1.commit)).rejects.toThrow("暂存区");
  expect(await git(cwd, "show", ":a.txt")).toBe("USER STAGED");
  expect(await Bun.file(join(cwd, "later.txt")).exists()).toBe(false);
});

test("自动应用中断后按目标tree幂等修复，不误报用户改动", async () => {
  const { cwd, root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const sealed = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  expect(await repo.applyCommit(sealed.commit, base)).toEqual(["a.txt"]);
  // 模拟 read-tree 已执行、reset --mixed 前中断：索引停在目标tree。
  await git(cwd, "read-tree", sealed.commit);
  expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("a.txt");
  expect(await repo.applyCommit(sealed.commit, base)).toEqual(["a.txt"]);
  expect(await git(cwd, "diff", "--cached", "--name-only")).toBe("");
  expect((await repo.inspect()).changedPaths).toEqual(["a.txt"]);
});

test("相对基准零改动时不因主工作区dirty误报未自动应用", async () => {
  const { cwd, repo, base } = await fixture();
  await writeFile(join(cwd, "user.txt"), "keep");
  expect(await repo.applyCommit(base, base)).toEqual([]);
  expect(await Bun.file(join(cwd, "user.txt")).text()).toBe("keep");
});

test("续作应用会覆盖主工作区ignored文件时拒绝并保留现场", async () => {
  const { root, cwd, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, ".gitignore"), "secret.local\n");
  const c1 = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  expect(await repo.applyCommit(c1.commit, base)).toEqual([".gitignore"]);
  // 用户在已应用现场里创建被忽略文件；续作封存同名文件时必须拒绝覆盖。
  await writeFile(join(cwd, "secret.local"), "user local\n");
  expect((await repo.inspect()).ignoredPaths).toContain("secret.local");
  await writeFile(join(worker.cwd, "secret.local"), "agent\n");
  await git(worker.cwd, "add", "-f", "--", "secret.local"); await git(worker.cwd, "commit", "-m", "track ignored file");
  const c2 = await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: c1.commit });
  expect(c2.paths).toContain("secret.local");
  await expect(repo.applyCommit(c2.commit, base, c1.commit)).rejects.toThrow("ignored");
  expect(await Bun.file(join(cwd, "secret.local")).text()).toBe("user local\n");
});

test("封存中断（update-ref后未read-tree）重试修复索引", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const request = { requestId: crypto.randomUUID(), baseCommit: base, startCommit: base };
  const sealed = await worker.seal(request);
  await git(worker.cwd, "read-tree", base);
  expect((await worker.inspect()).changedPaths).toEqual(["a.txt"]);
  const retried = await worker.seal(request);
  expect(retried.commit).toBe(sealed.commit);
  expect((await worker.inspect()).changedPaths).toEqual([]);
});

test("不得把其他Execution的封存HEAD当成本次来源", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  await worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  await expect(worker.seal({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base })).rejects.toThrow("其他封存来源");
});
