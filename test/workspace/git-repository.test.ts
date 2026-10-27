import { afterEach, expect, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundedExit, GitCommandError, GitRepository } from "../../src/workspace/git-repository";
import { WorkflowContractError } from "../../src/workflow/errors";

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
  return { root, cwd, repo, base };
}

test("创建受管worktree不修改主工作区；inspect完整读取tracked与未ignored改动", async () => {
  const { root, cwd, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  expect((await worker.inspect())).toMatchObject({ head: base, branch: "refs/heads/codex/wf-worker", changedPaths: [] });
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  await writeFile(join(worker.cwd, "new.txt"), "new\n");
  await writeFile(join(worker.cwd, ".gitignore"), "*.log\n");
  await writeFile(join(worker.cwd, "debug.log"), "ignored\n");
  expect((await worker.inspect()).changedPaths).toEqual([".gitignore", "a.txt", "new.txt"]);
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
  expect(await git(cwd, "rev-parse", "HEAD")).toBe(base);
});

test("未ignored的node_modules按普通改动报告，不按目录名静默排除", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await mkdir(join(worker.cwd, "node_modules", "local-package"), { recursive: true });
  await writeFile(join(worker.cwd, "node_modules", "local-package", "index.js"), "module.exports = 1;\n");
  expect((await worker.inspect()).changedPaths).toEqual(["node_modules/local-package/index.js"]);
  expect(await Bun.file(join(worker.cwd, "node_modules/local-package/index.js")).text()).toBe("module.exports = 1;\n");
});

test("tracked .gitattributes 不再阻断仓库打开", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, ".gitattributes"), "*.txt text eol=lf\n");
  await git(cwd, "add", "--", ".gitattributes");
  await git(cwd, "commit", "-m", "tracked attributes");
  await expect(GitRepository.open(cwd)).resolves.toBeDefined();
});

test("清理删除当前checkout（含未提交与ignored内容），身份不一致时拒绝", async () => {
  const { root, cwd, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const identity = await worker.inspect();
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  await writeFile(join(cwd, ".git", "info", "exclude"), "local.cache\n");
  await writeFile(join(worker.cwd, "local.cache"), "ignored content");
  await expect(repo.removeWorktree(worker.cwd, { ...identity, branch: "refs/heads/codex/wf-other" })).rejects.toThrow("身份");
  expect(await Bun.file(join(worker.cwd, "a.txt")).exists()).toBe(true);
  await repo.removeWorktree(worker.cwd, identity);
  expect(await Bun.file(worker.cwd).exists()).toBe(false);
  // 主工作区与分支引用不受清理影响。
  expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("base\n");
  expect(await git(cwd, "rev-parse", "refs/heads/codex/wf-worker")).toBe(base);
});

test("清理拒绝仍含未解决冲突的worktree", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const wgit = async (input: string | undefined, ...args: string[]) => {
    const child = Bun.spawn(["/usr/bin/git", ...args], { cwd: worker.cwd, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (input !== undefined) { child.stdin!.write(input); child.stdin!.end(); }
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err); return out.trim();
  };
  const blobA = await wgit("conflict-a\n", "hash-object", "-w", "--stdin");
  const blobB = await wgit("conflict-b\n", "hash-object", "-w", "--stdin");
  await wgit(`100644 ${blobA} 1\ta.txt\n100644 ${blobB} 2\ta.txt\n`, "update-index", "--index-info");
  await expect(repo.removeWorktree(worker.cwd, await worker.inspect())).rejects.toThrow("冲突");
  expect(await Bun.file(join(worker.cwd, "a.txt")).exists()).toBe(true);
});

test("Git lock不被force清理绕过，人工解锁后才允许删除", async () => {
  const { root, cwd, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const identity = await worker.inspect();
  await git(cwd, "worktree", "lock", worker.cwd);
  await expect(repo.removeWorktree(worker.cwd, identity)).rejects.toThrow("锁定");
  expect(await Bun.file(join(worker.cwd, "a.txt")).exists()).toBe(true);
  await git(cwd, "worktree", "unlock", worker.cwd);
  await repo.removeWorktree(worker.cwd, identity);
  expect(await Bun.file(worker.cwd).exists()).toBe(false);
});

test("父worktree清理拒绝吞掉嵌套注册checkout", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const identity = await worker.inspect();
  const nested = join(worker.cwd, "nested"), aliasNested = join(worker.cwd.replace(/^\/private\//, "/"), "nested");
  await git(worker.cwd, "worktree", "add", "--no-track", "-b", "codex/wf-nested", aliasNested, base);
  await expect(repo.removeWorktree(worker.cwd, identity)).rejects.toThrow("嵌套");
  expect(await Bun.file(join(nested, "a.txt")).exists()).toBe(true);
  expect(await Bun.file(join(worker.cwd, "a.txt")).exists()).toBe(true);
});

test("submodule配置不能隐藏gitlink变化，配置删除后仍拒绝清理并保留内部commit", async () => {
  const { root, cwd } = await fixture();
  const origin = join(root, "origin"); await mkdir(origin); await git(origin, "init", "-b", "main");
  await writeFile(join(origin, "vendor.txt"), "vendor\n"); await git(origin, "add", "--", "vendor.txt"); await git(origin, "commit", "-m", "vendor");
  await git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", origin, "vendor"); await git(cwd, "commit", "-m", "add submodule");
  const reopened = await GitRepository.open(cwd), submoduleBase = (await reopened.inspect()).head;
  const worker = await reopened.createWorktree(join(root, "worker"), "codex/wf-worker", submoduleBase);
  await git(worker.cwd, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
  await git(worker.cwd, "config", "diff.ignoreSubmodules", "all");
  const vendor = join(worker.cwd, "vendor");
  await git(vendor, "commit", "--allow-empty", "-m", "local only");
  const localCommit = await git(vendor, "rev-parse", "HEAD");
  expect((await worker.inspect()).changedPaths).toContain("vendor");
  await git(worker.cwd, "add", "--", "vendor"); await git(worker.cwd, "commit", "-m", "record submodule");
  await rm(join(worker.cwd, ".gitmodules")); await git(worker.cwd, "add", "--", ".gitmodules"); await git(worker.cwd, "commit", "-m", "remove submodule config");
  await expect(reopened.removeWorktree(worker.cwd, await worker.inspect())).rejects.toThrow("submodule");
  expect(await git(vendor, "rev-parse", "HEAD")).toBe(localCommit);
}, 20_000);

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

test("ignored文件列表超过旧2MiB上限时不枚举，inspect与清理仍可用", async () => {
  const { root, cwd, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-ignored", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  await writeFile(join(cwd, ".gitignore"), "mass/\n");
  await mkdir(join(cwd, "mass"));
  const name = "n".repeat(200), writes: Promise<unknown>[] = [];
  for (let i = 0; i < 11_000; i++) {
    writes.push(writeFile(join(cwd, "mass", `${name}${i}`), ""));
    if (writes.length === 500) { await Promise.all(writes); writes.length = 0; }
  }
  await Promise.all(writes);
  const state = await repo.inspect();
  expect(state.changedPaths).toEqual([".gitignore"]);
  expect((await repo.sceneFingerprint()).hash).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(worker.cwd, ".gitignore"), "mass/\n");
  await mkdir(join(worker.cwd, "mass"));
  for (let i = 0; i < 11_000; i++) {
    writes.push(writeFile(join(worker.cwd, "mass", `${name}${i}`), ""));
    if (writes.length === 500) { await Promise.all(writes); writes.length = 0; }
  }
  await Promise.all(writes);
  await repo.removeWorktree(worker.cwd, await worker.inspect());
  expect(await Bun.file(worker.cwd).exists()).toBe(false);
  // 预先删除主仓库的海量fixture，避免 afterEach 清理超时。
  await rm(join(cwd, "mass"), { recursive: true, force: true });
}, 60_000);

test("大仓库索引与tree条目超过2MiB时，现场指纹与清理完整可用", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-git-big-"))); directories.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd);
  await git(cwd, "init", "-b", "main");
  const name = "f".repeat(200);
  try {
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 8_500; i++) {
      writes.push(writeFile(join(cwd, `${name}${i}`), "x\n"));
      if (writes.length === 500) { await Promise.all(writes); writes.length = 0; }
    }
    await Promise.all(writes);
    await git(cwd, "add", "-A"); await git(cwd, "commit", "-m", "big");
    const repo = await GitRepository.open(cwd), base = (await repo.inspect()).head;
    // 索引列表 >2MiB：流式摘要，不报“读取上限”。
    expect((await repo.sceneFingerprint()).hash).toMatch(/^[a-f0-9]{64}$/);
    const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-big", base);
    await writeFile(join(worker.cwd, `${name}0`), "changed\n");
    expect((await worker.inspect()).changedPaths).toEqual([`${name}0`]);
    // cleanup的submodule/gitlink预检同样流式，不因完整HEAD tree超过2MiB而拒绝。
    await repo.removeWorktree(worker.cwd, await worker.inspect());
    expect(await Bun.file(worker.cwd).exists()).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(join(root, "worker"), { recursive: true, force: true });
  }
}, 120_000);

test("非法 UTF-8 文件名明确拒绝且不可重试，不产生 U+FFFD 误路径", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const hash = Bun.spawn(["/usr/bin/git", "hash-object", "-w", "--stdin"], { cwd: worker.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  hash.stdin.write("x"); hash.stdin.end();
  const blob = (await new Response(hash.stdout).text()).trim(); expect(await hash.exited).toBe(0);
  const update = Bun.spawn(["/usr/bin/git", "update-index", "--index-info"], { cwd: worker.cwd, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  update.stdin.write(Buffer.concat([Buffer.from(`100644 ${blob} 0\tbad-`), Buffer.from([0xff, 0xfe]), Buffer.from("\n")])); update.stdin.end();
  expect(await update.exited).toBe(0);
  const failure = await worker.inspect().catch((error: unknown) => error) as Error;
  expect(failure).toBeInstanceOf(WorkflowContractError);
  expect(failure).not.toBeInstanceOf(GitCommandError);
  expect(failure.message).toContain("UTF-8");
  expect(await git(worker.cwd, "ls-files", "--stage")).toContain(blob);
});

test("超过2MiB的合法未忽略路径列表完整读取，changedPaths 无截断", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-git-wide-"))); directories.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd);
  await git(cwd, "init", "-b", "main"); await git(cwd, "commit", "--allow-empty", "-m", "init");
  const seg = "s".repeat(200), name = "f".repeat(200), count = 2_600, dir = join(cwd, seg, seg, seg);
  await mkdir(dir, { recursive: true });
  const writes: Promise<unknown>[] = [];
  for (let i = 0; i < count; i++) {
    writes.push(writeFile(join(dir, `${name}${i}`), "x\n"));
    if (writes.length === 500) { await Promise.all(writes); writes.length = 0; }
  }
  await Promise.all(writes);
  const repo = await GitRepository.open(cwd);
  expect((await repo.inspect()).changedPaths).toHaveLength(count);
  expect(Buffer.byteLength((await repo.inspect()).changedPaths.join("\0"))).toBeGreaterThan(2_000_000);
}, 120_000);

test("boundedExit：忽略 SIGTERM 的进程在短窗口后升级 SIGKILL，promise 有界 settle", async () => {
  const child = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; while true; do sleep 1; done"], { stdout: "ignore", stderr: "ignore" });
  try {
    const started = Date.now();
    const code = await boundedExit(child.exited, signal => child.kill(signal), 100, 150, 1_000);
    expect(code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
});

test("boundedExit：exited 永不 settle 时仍在有界预算内 reject", async () => {
  const started = Date.now();
  await expect(boundedExit(new Promise<number>(() => {}), () => {}, 30, 30, 60)).rejects.toThrow("有界拒绝");
  expect(Date.now() - started).toBeLessThan(5_000);
});
