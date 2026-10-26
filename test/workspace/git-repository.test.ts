import { afterEach, expect, test as bunTest } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundedExit, GitCommandError, GitRepository, type GitEvidenceRequest } from "../../src/workspace/git-repository";
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
  const request: GitEvidenceRequest = { requestId: crypto.randomUUID(), baseCommit: base, startCommit: base };
  return { root, cwd, repo, base, request };
}

test("采集现场为tree并写证据ref；HEAD/索引/主工作区不变，重试幂等", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const evidence = await worker.captureEvidence(request);
  expect(evidence.tree).toMatch(/^[a-f0-9]{40}$/);
  expect(evidence.evidenceRef).toBe(`refs/wave-flow/evidence/${request.requestId}`);
  expect(evidence.paths).toEqual(["a.txt"]);
  expect(await git(worker.cwd, "rev-parse", evidence.evidenceRef)).toBe(evidence.tree);
  // 不创建commit、不移动HEAD、不触碰真实索引：现场仍保持未提交可见。
  expect((await worker.inspect()).head).toBe(base);
  expect((await worker.inspect()).changedPaths).toEqual(["a.txt"]);
  expect(await git(worker.cwd, "diff", "--cached", "--name-only")).toBe("");
  expect(await git(worker.cwd, "rev-list", "--count", "HEAD")).toBe("1");
  expect(await repo.inspect()).toMatchObject({ head: base, changedPaths: [] });
  expect(await git(cwd, "rev-parse", "HEAD")).toBe(base);

  const retried = await worker.captureEvidence(request);
  expect(retried).toEqual(evidence);
});

test("证据tree支持review diff与fileDiff patch；非法路径拒绝", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const evidence = await worker.captureEvidence(request);
  expect(await repo.review(base, evidence.tree)).toEqual({ baseCommit: base, sourceTree: evidence.tree, paths: ["a.txt"] });
  expect((await repo.fileDiff(base, evidence.tree, "a.txt")).patch).toContain("+result");
  await expect(repo.fileDiff(base, evidence.tree, ".git/config")).rejects.toThrow("不属于");
});

test("无改动时tree等于HEAD tree、paths为空，仍写证据ref", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const evidence = await worker.captureEvidence(request);
  expect(evidence.paths).toEqual([]);
  expect(evidence.tree).toBe(await git(worker.cwd, "rev-parse", "HEAD^{tree}"));
  expect(await worker.verifyEvidenceExists(evidence.evidenceRef, evidence.tree)).toBe(evidence.tree);
});

test("tracked始终纳入，gitignored内容不收集，特殊路径通过NUL暂存", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, ".gitignore"), "*.log\nnode_modules/\n"); await writeFile(join(worker.cwd, "debug.log"), "ignored");
  await mkdir(join(worker.cwd, "node_modules")); await writeFile(join(worker.cwd, "node_modules", "dep"), "ignored dependency");
  await writeFile(join(worker.cwd, "[x] space.ts"), "new");
  const evidence = await worker.captureEvidence({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  expect(evidence.paths).toEqual([".gitignore", "[x] space.ts"]);
  expect(await git(worker.cwd, "ls-tree", "-r", "--name-only", evidence.tree)).not.toContain("debug.log");
  expect(await git(worker.cwd, "ls-tree", "-r", "--name-only", evidence.tree)).not.toContain("node_modules");
  expect(await Bun.file(join(worker.cwd, "debug.log")).text()).toBe("ignored");
  expect((await repo.inspect()).head).toBe(base);
});

test("未ignored的node_modules按普通成果收集，不按目录名静默排除", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await mkdir(join(worker.cwd, "node_modules", "local-package"), { recursive: true });
  await writeFile(join(worker.cwd, "node_modules", "local-package", "index.js"), "module.exports = 1;\n");
  const evidence = await worker.captureEvidence({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  expect(evidence.paths).toEqual(["node_modules/local-package/index.js"]);
  expect(await git(worker.cwd, "show", `${evidence.tree}:node_modules/local-package/index.js`)).toBe("module.exports = 1;");
});

test("二进制和大文本diff明确省略，证据tree仍完整保存文件", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "image.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(worker.cwd, "large.txt"), "line content\n".repeat(170000));
  const evidence = await worker.captureEvidence(request);
  expect(evidence.paths).toEqual(["image.bin", "large.txt"]);
  expect(await repo.fileDiff(base, evidence.tree, "image.bin")).toMatchObject({ omitted: true, reason: "binary" });
  expect(await repo.fileDiff(base, evidence.tree, "large.txt")).toMatchObject({ omitted: true, reason: "too-large", patch: "" });
  expect(Buffer.byteLength(await git(worker.cwd, "show", `${evidence.tree}:large.txt`))).toBeGreaterThan(2_000_000);
}, 20_000);

test("禁止主工作区采集、越界worktree、符号链接与Git attributes", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  await expect(repo.captureEvidence(request)).rejects.toThrow("非受管分支");
  await git(cwd, "switch", "-c", "codex/wf-user-main");
  await expect(repo.captureEvidence(request)).rejects.toThrow("主工作区");
  await git(cwd, "switch", "main");
  await expect(repo.createWorktree(join(cwd, "worker"), "codex/wf-worker", base)).rejects.toThrow("之外");
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await symlink(join(cwd, "a.txt"), join(worker.cwd, "link"));
  await expect(worker.captureEvidence({ ...request })).rejects.toThrow("符号链接");
  await rm(join(worker.cwd, "link")); await writeFile(join(worker.cwd, ".gitattributes"), "*.txt filter=evil\n");
  await expect(worker.captureEvidence({ ...request })).rejects.toThrow("attributes");
});

test("tracked .gitattributes 不再阻断仓库打开", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, ".gitattributes"), "*.txt text eol=lf\n");
  await git(cwd, "add", "--", ".gitattributes");
  await git(cwd, "commit", "-m", "tracked attributes");
  await expect(GitRepository.open(cwd)).resolves.toBeDefined();
});

test("仓库已有但未改动的 tracked symlink 不阻断采集，修改 symlink 仍拒绝", async () => {
  const { root, cwd, repo, base } = await fixture();
  await symlink("a.txt", join(cwd, "link"));
  await git(cwd, "add", "--", "link");
  await git(cwd, "commit", "-m", "tracked symlink");
  const reopened = await GitRepository.open(cwd);
  const trackedBase = (await reopened.inspect()).head;
  const worker = await reopened.createWorktree(join(root, "worker-link"), "codex/wf-worker-link", trackedBase);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const evidence = await worker.captureEvidence({ requestId: crypto.randomUUID(), baseCommit: trackedBase, startCommit: trackedBase });
  expect(evidence.paths).toEqual(["a.txt"]);
  expect(await git(worker.cwd, "ls-tree", evidence.tree, "link")).toContain("120000");

  await rm(join(worker.cwd, "link"));
  await symlink("b.txt", join(worker.cwd, "link"));
  await expect(worker.captureEvidence({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: trackedBase })).rejects.toThrow("符号链接");
});

test("续作已有commit纳入证据且不新增宿主commit", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "committed\n");
  await git(worker.cwd, "commit", "-am", "agent commit");
  await writeFile(join(worker.cwd, "b.txt"), "uncommitted\n");
  const head = (await worker.inspect()).head;
  const evidence = await worker.captureEvidence({ ...request, startCommit: base });
  expect(evidence.paths).toEqual(["a.txt", "b.txt"]);
  // 宿主不制造任何新commit：HEAD仍是agent自己的commit，ref只指向tree。
  expect((await worker.inspect()).head).toBe(head);
  expect(await git(worker.cwd, "rev-list", "--count", `${base}..HEAD`)).toBe("1");
  expect(await git(worker.cwd, "cat-file", "-t", evidence.tree)).toBe("tree");
  expect(await repo.containsCommit(head, base)).toBe(true);
});

test("verifyEvidenceExists 兼容历史commit tree-ish，tree不一致时拒绝", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const evidence = await worker.captureEvidence(request);
  // 用tree、证据ref与手工commit-tree产生的历史commit三种tree-ish核验同一tree。
  const commit = await git(worker.cwd, "commit-tree", evidence.tree, "-p", base, "-m", "legacy");
  expect(await repo.verifyEvidenceExists(evidence.evidenceRef, evidence.tree)).toBe(evidence.tree);
  expect(await repo.verifyEvidenceExists(evidence.evidenceRef, commit)).toBe(evidence.tree);
  expect(await repo.verifyEvidenceExists(evidence.tree, evidence.evidenceRef)).toBe(evidence.tree);
  await expect(repo.verifyEvidenceExists(evidence.evidenceRef, base)).rejects.toThrow("不一致");
  await expect(repo.verifyEvidenceExists("refs/wave-flow/evidence/00000000-0000-0000-0000-000000000000", evidence.tree)).rejects.toThrow();
});

test("清理仅在现场tree一致且无冲突时执行，ignored内容允许随checkout删除", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const identity = await worker.inspect();
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const evidence = await worker.captureEvidence(request);
  // 现场变化后拒绝清理。
  await writeFile(join(worker.cwd, "a.txt"), "changed after evidence\n");
  await expect(repo.removeWorktree(worker.cwd, evidence.tree, identity)).rejects.toThrow("偏离");
  expect(await Bun.file(join(worker.cwd, "a.txt")).exists()).toBe(true);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  await writeFile(join(worker.cwd, ".gitignore"), "local.tmp\n");
  await git(worker.cwd, "add", "--", ".gitignore"); await git(worker.cwd, "commit", "-m", "ignore rule");
  const committed = await worker.captureEvidence({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  await writeFile(join(worker.cwd, "local.tmp"), "x");
  // tree一致后允许清理；ignored内容按Orca模式随checkout删除。
  await repo.removeWorktree(worker.cwd, committed.tree, identity);
  expect(await Bun.file(join(root, "worker", "a.txt")).exists()).toBe(false);
  expect(await Bun.file(join(root, "worker", "local.tmp")).exists()).toBe(false);
});

test("清理复核冻结身份，同仓库其他branch不能冒充原worktree", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const identity = await worker.inspect(), evidence = await worker.captureEvidence(request);
  await expect(repo.removeWorktree(worker.cwd, evidence.tree, { ...identity, branch: "refs/heads/codex/wf-other" })).rejects.toThrow("身份");
  expect(await Bun.file(join(worker.cwd, "a.txt")).exists()).toBe(true);
});

test("Git lock不被force清理绕过，人工解锁后才允许删除", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const identity = await worker.inspect(), evidence = await worker.captureEvidence(request);
  await git(cwd, "worktree", "lock", worker.cwd);
  await expect(repo.removeWorktree(worker.cwd, evidence.tree, identity)).rejects.toThrow("锁定");
  expect(await Bun.file(join(worker.cwd, "a.txt")).exists()).toBe(true);
  await git(cwd, "worktree", "unlock", worker.cwd);
  await repo.removeWorktree(worker.cwd, evidence.tree, identity);
  expect(await Bun.file(worker.cwd).exists()).toBe(false);
});

test("父worktree清理拒绝吞掉嵌套注册checkout", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  const identity = await worker.inspect(), evidence = await worker.captureEvidence(request);
  const nested = join(worker.cwd, "nested"), aliasNested = join(worker.cwd.replace(/^\/private\//, "/"), "nested");
  await git(worker.cwd, "worktree", "add", "--no-track", "-b", "codex/wf-nested", aliasNested, base);
  await expect(repo.removeWorktree(worker.cwd, evidence.tree, identity)).rejects.toThrow("嵌套");
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
  const evidence = await worker.captureEvidence({ requestId: crypto.randomUUID(), baseCommit: submoduleBase, startCommit: submoduleBase });
  await expect(reopened.removeWorktree(worker.cwd, evidence.tree, await worker.inspect())).rejects.toThrow("submodule");
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

test("ignored文件列表超过旧2MiB上限时不枚举，检查与tree一致清理成功", async () => {
  const { root, cwd, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-ignored", base);
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  await worker.captureEvidence(request);
  await writeFile(join(cwd, ".gitignore"), "mass/\n");
  await mkdir(join(cwd, "mass"));
  const name = "n".repeat(200), writes: Promise<unknown>[] = [];
  for (let i = 0; i < 11_000; i++) {
    writes.push(writeFile(join(cwd, "mass", `${name}${i}`), ""));
    if (writes.length === 500) { await Promise.all(writes); writes.length = 0; }
  }
  await Promise.all(writes);
  const state = await repo.inspect();
  // 检查与现场指纹继续可用；changed 等完整列表语义不变。
  expect(state.changedPaths).toEqual([".gitignore"]);
  expect((await repo.sceneFingerprint()).hash).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(worker.cwd, ".gitignore"), "mass/\n");
  await mkdir(join(worker.cwd, "mass"));
  for (let i = 0; i < 11_000; i++) {
    writes.push(writeFile(join(worker.cwd, "mass", `${name}${i}`), ""));
    if (writes.length === 500) { await Promise.all(writes); writes.length = 0; }
  }
  await Promise.all(writes);
  const finalEvidence = await worker.captureEvidence({ ...request, requestId: crypto.randomUUID() });
  await repo.removeWorktree(worker.cwd, finalEvidence.tree, await worker.inspect());
  expect(await Bun.file(worker.cwd).exists()).toBe(false);
  // 预先删除主仓库的海量fixture，避免 afterEach 清理超时。
  await rm(join(cwd, "mass"), { recursive: true, force: true });
}, 60_000);

test("大仓库索引与tree条目超过2MiB时，现场指纹、证据收集与cleanup完整可用", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-git-big-"))); directories.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd);
  await git(cwd, "init", "-b", "main");
  const name = "f".repeat(200);
  const mass = join(root, "mass"); // 不在仓库内，避免清理压力
  try {
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 8_500; i++) {
      writes.push(writeFile(join(cwd, `${name}${i}`), "x\n"));
      if (writes.length === 500) { await Promise.all(writes); writes.length = 0; }
    }
    await Promise.all(writes);
    await git(cwd, "add", "-A"); await git(cwd, "commit", "-m", "big");
    const repo = await GitRepository.open(cwd), base = (await repo.inspect()).head;
    // 索引列表 >2MiB：修复前 sceneFingerprint 会报“Git 证据超过读取上限”。
    expect((await repo.sceneFingerprint()).hash).toMatch(/^[a-f0-9]{64}$/);
    // 完整 tree 条目 >2MiB：修复前 captureEvidence 会在 ls-tree 阶段失败。
    const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-big", base);
    await writeFile(join(worker.cwd, `${name}0`), "changed\n");
    const evidence = await worker.captureEvidence({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
    expect(evidence.paths).toEqual([`${name}0`]);
    // cleanup的submodule/gitlink预检同样流式，不因完整HEAD tree超过2MiB而拒绝。
    await repo.removeWorktree(worker.cwd, evidence.tree, await worker.inspect());
    expect(await Bun.file(worker.cwd).exists()).toBe(false);
  } finally {
    await rm(mass, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(join(root, "worker"), { recursive: true, force: true });
  }
}, 120_000);

test("merge-base --is-ancestor 的 exit 1 是确定性契约拒绝，不按 GitCommandError 重试", async () => {
  const { root, repo, base, request } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  // 与当前 HEAD 无祖先关系的孤儿 commit 冒充冻结基准。
  const orphan = await git(worker.cwd, "commit-tree", `${base}^{tree}`, "-m", "orphan");
  await writeFile(join(worker.cwd, "a.txt"), "result\n");
  const failure = await worker.captureEvidence({ ...request, baseCommit: orphan }).catch((error: unknown) => error) as Error;
  expect(failure).toBeInstanceOf(WorkflowContractError);
  expect(failure).not.toBeInstanceOf(GitCommandError);
  expect(failure.message).toContain("祖先");
});

test("非法 UTF-8 文件名明确拒绝且不可重试，不产生 U+FFFD 误路径", async () => {
  const { root, repo, base } = await fixture();
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-worker", base);
  // macOS APFS 拒绝创建非法 UTF-8 文件名（EILSEQ），但 Git 索引可携带原始字节路径：
  // 经 update-index --index-info 写入非法字节路径，diff/ls-files 的 -z 输出即含非法 UTF-8。
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
  // 核验现场不被误写：索引中的非法路径仍在，等待人工处理而不是被替代字符覆盖。
  expect(await git(worker.cwd, "ls-files", "--stage")).toContain(blob);
});

test("超过2MiB的合法未忽略路径列表完整交付：untracked、changedPaths 与 changedBetween 均无截断", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-git-wide-"))); directories.push(root);
  const cwd = join(root, "repo"); await mkdir(cwd);
  await git(cwd, "init", "-b", "main"); await git(cwd, "commit", "--allow-empty", "-m", "init");
  // 用长路径压低文件数：单条约810字节，2600条合计超过2MiB。
  const seg = "s".repeat(200), name = "f".repeat(200), count = 2_600, dir = join(cwd, seg, seg, seg);
  await mkdir(dir, { recursive: true });
  const writes: Promise<unknown>[] = [];
  for (let i = 0; i < count; i++) {
    writes.push(writeFile(join(dir, `${name}${i}`), "x\n"));
    if (writes.length === 500) { await Promise.all(writes); writes.length = 0; }
  }
  await Promise.all(writes);
  const repo = await GitRepository.open(cwd);
  // >2MiB 的 untracked 列表：修复前 inspect 报“Git 证据超过读取上限”，合法现场永久无法交付。
  expect((await repo.inspect()).changedPaths).toHaveLength(count);
  await git(cwd, "add", "-A"); await git(cwd, "commit", "-m", "wide");
  const base = (await repo.inspect()).head;
  const worker = await repo.createWorktree(join(root, "worker"), "codex/wf-wide", base);
  const modify: Promise<unknown>[] = [];
  for (let i = 0; i < count; i++) {
    modify.push(writeFile(join(worker.cwd, seg, seg, seg, `${name}${i}`), "y\n"));
    if (modify.length === 500) { await Promise.all(modify); modify.length = 0; }
  }
  await Promise.all(modify);
  // >2MiB 的 tracked 变更列表：inspect 与 evidence.paths（changedBetween）都完整。
  expect((await worker.inspect()).changedPaths).toHaveLength(count);
  const evidence = await worker.captureEvidence({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base });
  expect(evidence.paths).toHaveLength(count);
  expect(Buffer.byteLength(evidence.paths.join("\0"))).toBeGreaterThan(2_000_000);
}, 120_000);

test("boundedExit：忽略 SIGTERM 的进程在短窗口后升级 SIGKILL，promise 有界 settle", async () => {
  const child = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; while true; do sleep 1; done"], { stdout: "ignore", stderr: "ignore" });
  try {
    const started = Date.now();
    const code = await boundedExit(child.exited, signal => child.kill(signal), 100, 150, 1_000);
    // SIGKILL 后进程退出，以真实非零退出码 settle（由调用方按非零码报错）。
    expect(code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
});

test("boundedExit：exited 永不 settle 时仍在有界预算内 reject", async () => {
  const started = Date.now();
  await expect(boundedExit(new Promise<number>(() => {}), () => {}, 30, 30, 60)).rejects.toThrow("有界拒绝");
  expect(Date.now() - started).toBeLessThan(5_000);
});
