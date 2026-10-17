import { afterEach, expect, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitRepository, type GitSaveRequest } from "../../src/workspace/git-repository";

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
  const request: GitSaveRequest = { requestId: crypto.randomUUID(), baseCommit: base, startCommit: base, allowedPaths: ["a.txt"] };
  return { root, cwd, repo, base, request };
}
test("独立worktree不复制主工作区dirty内容，白名单成果保存与同请求重试只创建一个commit", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  await writeFile(join(cwd, "a.txt"), "user dirty\n");
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  expect(await Bun.file(join(worker.cwd, "a.txt")).text()).toBe("base\n");
  await writeFile(join(worker.cwd, "a.txt"), "worker result\n");
  const saved = await worker.save(request);
  expect(saved.paths).toEqual(["a.txt"]); expect(saved.commit).not.toBe(base);
  expect(await worker.save(request)).toEqual(saved);
  expect(await git(worker.cwd, "rev-list", "--count", `${base}..HEAD`)).toBe("1");
  expect((await worker.inspect()).changedPaths).toEqual([]);
  expect(await git(cwd, "rev-parse", "HEAD")).toBe(base);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("user dirty\n");
});
test("单父squash交付只创建新ref，重试幂等且不改主HEAD/index/dirty内容", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "delivery\n");
  const saved = await worker.save(request);
  await writeFile(join(cwd, "b.txt"), "user dirty\n");
  await git(cwd, "add", "b.txt");
  const index = await git(cwd, "write-tree"), executionId = crypto.randomUUID();
  const input = { requestId: executionId, baseCommit: base, sourceCommit: saved.commit, allowedPaths: ["a.txt"], branch: `codex/delivery-${executionId}` };
  await expect(repo.deliverSquash({ ...input, allowedPaths: ["b.txt"] })).rejects.toThrow("未授权");
  const delivery = await repo.deliverSquash(input);
  expect(await repo.deliverSquash(input)).toEqual(delivery);
  expect(await git(cwd, "show", "-s", "--format=%P", delivery.commit)).toBe(base);
  expect(await git(cwd, "rev-parse", `${delivery.commit}^{tree}`)).toBe(await git(cwd, "rev-parse", `${saved.commit}^{tree}`));
  expect(await git(cwd, "rev-list", "--count", `${base}..${delivery.commit}`)).toBe("1");
  expect(await git(cwd, "rev-parse", "HEAD")).toBe(base);
  expect(await git(cwd, "write-tree")).toBe(index);
  expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("user dirty\n");
  await expect(repo.deliverSquash({ ...input, requestId: crypto.randomUUID() })).rejects.toThrow("冲突");
  await expect(repo.deliverSquash({ ...input, sourceCommit: base })).rejects.toThrow("冲突");
  await expect(repo.deliverSquash({ ...input, allowedPaths: ["a.txt", "b.txt"] })).rejects.toThrow("冲突");
  await expect(repo.deliverSquash({ ...input, branch: "main" })).rejects.toThrow("安全命名");
});

test("无改动复用HEAD，不生成空commit", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  expect(await worker.save(request)).toEqual({ requestId: request.requestId, commit: base, unchanged: true, paths: [] });
});
test("未授权untracked内容拒绝保存，保留文件与HEAD", async () => {
  const { root, repo, base, request } = await fixture(); const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "secret.env"), "secret");
  await expect(worker.save(request)).rejects.toThrow("未授权文件");
  expect((await worker.inspect()).head).toBe(base); expect(await Bun.file(join(worker.cwd, "secret.env")).text()).toBe("secret");
});
test("禁止主工作区保存、越界路径、符号链接与Git attributes", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  await expect(repo.save(request)).rejects.toThrow("非受管分支");
  await git(cwd, "switch", "-c", "codex/wf-user-main");
  await expect(repo.save(request)).rejects.toThrow("主工作区");
  await expect(repo.createWorktree(join(cwd, "worker"), "codex/wf-worker", base)).rejects.toThrow("之外");
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await expect(worker.save({ ...request, allowedPaths: ["../secret"] })).rejects.toThrow("安全仓库相对");
  await symlink(join(cwd, "a.txt"), join(worker.cwd, "link"));
  await expect(worker.save({ ...request, allowedPaths: ["link"] })).rejects.toThrow("符号链接");
  await rm(join(worker.cwd, "link")); await writeFile(join(worker.cwd, ".gitattributes"), "*.txt filter=evil\n");
  await expect(worker.save({ ...request, allowedPaths: [".gitattributes"] })).rejects.toThrow("attributes");
});
test("保存后现场变化不能冒充原成果补关联，既有commit保留", async () => {
  const { root, repo, request } = await fixture(); const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", request.baseCommit);
  await writeFile(join(worker.cwd, "a.txt"), "first\n"); const saved = await worker.save(request);
  await writeFile(join(worker.cwd, "a.txt"), "changed\n");
  await expect(worker.save(request)).rejects.toThrow("现场已改变");
  expect((await worker.inspect()).head).toBe(saved.commit);
});
test("hooks及本地filters拒绝打开且不执行外部程序", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  await expect(GitRepository.open(cwd)).rejects.toThrow("hook");
  await rm(join(cwd, ".git", "hooks", "pre-commit")); await git(cwd, "config", "filter.evil.clean", "false");
  await expect(GitRepository.open(cwd)).rejects.toThrow("filters");
});

test("两个独立成果用标准Git显式合并，主分支不变化；冲突现场不允许ready保存", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  const a = await repo.createWorktree(join(root, "writer-a"), "codex/wf-a", base);
  const b = await repo.createWorktree(join(root, "writer-b"), "codex/wf-b", base);
  const integration = await repo.createWorktree(join(root, "integration"), "codex/wf-integration", base);
  await writeFile(join(a.cwd, "a.txt"), "a result\n"); await writeFile(join(b.cwd, "b.txt"), "b result\n");
  const first = await a.save(request), second = await b.save({ ...request, requestId: crypto.randomUUID(), allowedPaths: ["b.txt"] });
  await git(integration.cwd, "merge", "--no-edit", first.commit);
  await git(integration.cwd, "merge", "--no-edit", second.commit);
  expect(await Bun.file(join(integration.cwd, "a.txt")).text()).toBe("a result\n"); expect(await Bun.file(join(integration.cwd, "b.txt")).text()).toBe("b result\n");
  expect((await integration.inspect()).changedPaths).toEqual([]); expect((await repo.inspect()).head).toBe(base);
  const conflict = await repo.createWorktree(join(root, "conflict-source"), "codex/wf-conflict", base);
  await writeFile(join(conflict.cwd, "a.txt"), "different\n");
  const conflicting = await conflict.save({ ...request, requestId: crypto.randomUUID() });
  await expect(git(integration.cwd, "merge", "--no-edit", conflicting.commit)).rejects.toThrow();
  expect((await integration.inspect()).conflicts).toEqual(["a.txt"]);
  await expect(integration.save({ ...request, startCommit: (await integration.inspect()).head })).rejects.toThrow("merge 冲突");
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
}, 15_000);

test("宿主保存集成成果保留真实多父Git关系，重试不生成第二merge commit", async () => {
  const { root, repo, base, request } = await fixture();
  const source = await repo.createWorktree(join(root, "source"), "codex/wf-source", base);
  const integration = await repo.createWorktree(join(root, "integration"), "codex/wf-merge", base);
  await writeFile(join(source.cwd, "a.txt"), "merged\n"); const saved = await source.save(request);
  await git(integration.cwd, "merge", "--no-commit", "--no-ff", saved.commit);
  const mergeRequest = { ...request, requestId: crypto.randomUUID(), mergeParents: [saved.commit] };
  const merged = await integration.save(mergeRequest);
  expect(await git(integration.cwd, "show", "-s", "--format=%P", merged.commit)).toBe(`${base} ${saved.commit}`);
  expect(await integration.save(mergeRequest)).toEqual(merged);
  const state = await integration.inspect(); expect(await Bun.file(join(state.gitDirectory, "MERGE_HEAD")).exists()).toBe(false);
  expect(await Bun.file(join(integration.cwd, "a.txt")).text()).toBe("merged\n");
  expect((await repo.inspect()).head).toBe(base);
});
