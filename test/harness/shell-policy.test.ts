import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeReadOnlyProjectQuery, readProjectFile } from "../../src/harness/shell-policy";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

/** rg 是可选加速器而不是产品依赖：没装它的机器上只跳过"真实搜索"，不因此判失败。 */
const rgInstalled = Bun.which("rg") !== null;

describe("Harness Shell Policy", () => {
  test.skipIf(!rgInstalled)("允许结构化的项目只读查询，不经 shell 解释", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-policy-")); directories.push(cwd);
    await writeFile(join(cwd, "needle.txt"), "needle\n", "utf8");
    await expect(executeReadOnlyProjectQuery(cwd, { command: "rg", args: ["-n", "needle"] })).resolves.toContain("needle.txt:1:needle");
  });

  /**
   * 本机没有 rg 时必须给出可执行的诊断，而不是让 spawn 抛底层 ENOENT：
   * 前者能让调用方退回读取文件或 CLI 原生搜索，后者只是一句看不出原因的失败。
   * 通过把 PATH 指向空目录来模拟"未安装"，不依赖测试机是否装了 rg。
   */
  test("本机没有 rg 时明确报不可用，不尝试 spawn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-policy-no-rg-")); directories.push(cwd);
    const emptyPath = await mkdtemp(join(tmpdir(), "wave-flow-empty-path-")); directories.push(emptyPath);
    const previous = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      await writeFile(join(cwd, "needle.txt"), "needle\n", "utf8");
      await expect(executeReadOnlyProjectQuery(cwd, { command: "rg", args: ["-n", "needle"] })).rejects.toThrow("需要 ripgrep（rg），但本机未安装");
    } finally { process.env.PATH = previous; }
    // git 缺失同样只报不可用，绝不回退到任意二进制或 shell。
    process.env.PATH = emptyPath;
    try { await expect(executeReadOnlyProjectQuery(cwd, { command: "git", args: ["status", "--short"] })).rejects.toThrow("在本机不可用"); }
    finally { process.env.PATH = previous; }
  });

  test("拒绝写命令、shell 语法和未知 flag", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-policy-reject-")); directories.push(cwd);
    await expect(executeReadOnlyProjectQuery(cwd, { command: "git", args: ["reset", "--hard"] })).rejects.toThrow("白名单");
    await expect(executeReadOnlyProjectQuery(cwd, { command: "rg", args: ["needle;", "rm", "-rf", "."] })).rejects.toThrow("白名单");
    await expect(executeReadOnlyProjectQuery(cwd, { command: "rg", args: ["--replace", "x", "needle"] })).rejects.toThrow("白名单");
    await expect(executeReadOnlyProjectQuery(cwd, { command: "git", args: ["diff", "--stat"] })).rejects.toThrow("白名单");
  });

  test.skipIf(!rgInstalled)("忽略 ripgrep 注入配置与 Git 外部执行配置", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-policy-env-")); directories.push(cwd);
    const config = join(cwd, "rg-config");
    await writeFile(config, "--pre=touch should-not-exist\n", "utf8");
    const previous = process.env.RIPGREP_CONFIG_PATH; process.env.RIPGREP_CONFIG_PATH = config;
    try {
      await writeFile(join(cwd, "needle.txt"), "needle\n", "utf8");
      await expect(executeReadOnlyProjectQuery(cwd, { command: "rg", args: ["-n", "needle"] })).resolves.toContain("needle.txt");
      await expect(Bun.file(join(cwd, "should-not-exist")).exists()).resolves.toBe(false);
    } finally { if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = previous; }
  });

  test("git status 禁用项目本地 fsmonitor 外部程序", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-policy-git-fsmonitor-")); directories.push(cwd);
    const marker = join(cwd, "fsmonitor-ran");
    await Bun.write(join(cwd, "fsmonitor.sh"), `#!/bin/sh\ntouch "${marker}"\n`);
    const init = Bun.spawn(["git", "init", "-q"], { cwd, stdout: "ignore", stderr: "pipe" }); expect(await init.exited).toBe(0);
    const configure = Bun.spawn(["git", "config", "core.fsmonitor", "./fsmonitor.sh"], { cwd, stdout: "ignore", stderr: "pipe" }); expect(await configure.exited).toBe(0);
    await expect(executeReadOnlyProjectQuery(cwd, { command: "git", args: ["status", "--short"] })).resolves.toContain("fsmonitor.sh");
    await expect(Bun.file(marker).exists()).resolves.toBe(false);
  });

  test("只读取 cwd 内常规文件，拒绝逃逸与软链接", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-policy-file-")); directories.push(cwd);
    const outside = await mkdtemp(join(tmpdir(), "wave-flow-policy-outside-")); directories.push(outside);
    await writeFile(join(cwd, "inside.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(cwd, "escape.txt"));
    await expect(readProjectFile(cwd, { path: "inside.txt", startLine: 2, endLine: 2 })).resolves.toContain("2  two");
    await expect(readProjectFile(cwd, { path: "../secret.txt" })).rejects.toThrow("项目目录");
    await expect(readProjectFile(cwd, { path: "escape.txt" })).rejects.toThrow("链接逃出");
    await expect(executeReadOnlyProjectQuery(cwd, { command: "rg", args: ["needle", "escape.txt"] })).rejects.toThrow("白名单");
    await expect(executeReadOnlyProjectQuery(cwd, { command: "ls", args: ["escape.txt"] })).rejects.toThrow("白名单");
  });

  test("读取目录和过大文件均 fail closed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wave-flow-policy-bounds-")); directories.push(cwd);
    await mkdir(join(cwd, "folder"));
    await writeFile(join(cwd, "large.txt"), "x".repeat(256 * 1024 + 1), "utf8");
    await expect(readProjectFile(cwd, { path: "folder" })).rejects.toThrow("常规文件");
    await expect(readProjectFile(cwd, { path: "large.txt" })).rejects.toThrow("超过");
  });
});
