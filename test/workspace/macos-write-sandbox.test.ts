import { afterEach, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macosWriteProfile } from "../../src/workspace/macos-write-sandbox";
import { GitRepository, importGitObjects } from "../../src/workspace/git-repository";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-seatbelt-test-"))); directories.push(root);
  const workspace = join(root, "workspace"), scratch = join(root, "scratch"), main = join(root, "main"), metadata = join(root, "git");
  for (const path of [workspace, scratch, main, metadata]) await mkdir(path);
  return { root, workspace, scratch, main, metadata };
}
test.skipIf(process.platform !== "darwin")("真实shell只写worktree/scratch，绝对路径与符号链接绕路不能写主目录或Git元数据", async () => {
  const { workspace, scratch, main, metadata } = await fixture();
  await writeFile(join(main, "protected"), "user\n"); await symlink(main, join(workspace, "escape"));
  const profile = await macosWriteProfile({ workspace, scratch, controlFiles: [], protectedDirectories: [main, metadata] });
  // 参数通过argv传入，无用户文本shell插值；子shell同样继承Seatbelt。
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", 'printf work > "$1/ok"; printf temp > "$2/ok"; /bin/sh -c \'printf bad > "$1/protected"\' ignored "$3"; printf bad > "$1/escape/protected"; printf bad > "$4/config"', "test", workspace, scratch, main, metadata], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).not.toBe(0); expect(stderr).toContain("Operation not permitted");
  expect(await Bun.file(join(workspace, "ok")).text()).toBe("work"); expect(await Bun.file(join(scratch, "ok")).text()).toBe("temp");
  expect(await Bun.file(join(main, "protected")).text()).toBe("user\n"); expect(await Bun.file(join(metadata, "config")).exists()).toBe(false);
});
test.skipIf(process.platform !== "darwin")("拒绝重叠、软链接及宽泛根目录写授权", async () => {
  const { root, workspace, scratch, main } = await fixture();
  await expect(macosWriteProfile({ workspace, scratch, controlFiles: [], protectedDirectories: [root] })).rejects.toThrow("重叠");
  await symlink(workspace, join(root, "link"));
  await expect(macosWriteProfile({ workspace: join(root, "link"), scratch, controlFiles: [], protectedDirectories: [main] })).rejects.toThrow("canonical");
  await expect(macosWriteProfile({ workspace: "/", scratch, controlFiles: [], protectedDirectories: [main] })).rejects.toThrow("路径无效");
});

test.skipIf(process.platform !== "darwin")("CLI原生目录可写和原子刷新，另一个CLI及业务目录仍拒绝，生成配置仍只读", async () => {
  const { root, scratch, main } = await fixture();
  const native = join(root, "native-cli"), other = join(root, "other-cli"); await mkdir(native); await mkdir(other);
  await mkdir(join(native, "credentials")); await symlink(join(native, "credentials"), join(scratch, "credentials"));
  const config = join(scratch, "config.toml"); await writeFile(config, "fixed");
  const profile = await macosWriteProfile({ workspace: null, scratch, cliWritableRoots: [native], controlFiles: [], readOnlyPaths: [config], protectedDirectories: [main] });
  const p = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", 'printf refreshed > "$1/credentials/new.tmp" && mv "$1/credentials/new.tmp" "$1/credentials/token.json" && printf setting > "$2/config.toml"; printf bad > "$3/config"; printf bad > "$4/file"; printf bad > "$1/config.toml"', "test", scratch, native, other, main], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  expect(code).not.toBe(0); expect(stderr).toContain("Operation not permitted");
  expect(await Bun.file(join(native, "credentials", "token.json")).text()).toBe("refreshed");
  expect(await Bun.file(join(native, "config.toml")).text()).toBe("setting");
  expect(await Bun.file(config).text()).toBe("fixed"); expect(await Bun.file(join(other, "config")).exists()).toBe(false); expect(await Bun.file(join(main, "file")).exists()).toBe(false);
  await expect(macosWriteProfile({ workspace: null, scratch, cliWritableRoots: [root], controlFiles: [], protectedDirectories: [main] })).rejects.toThrow();
});

test.skipIf(process.platform !== "darwin")("主控只读边界阻止解释器、后代进程、硬链接及文件元数据绕路", async () => {
  const { scratch, main } = await fixture();
  const target = join(main, "protected"), home = join(scratch, "private-home"), config = join(home, "config.toml");
  await mkdir(home); await writeFile(target, "user-original\n", { mode: 0o600 }); await writeFile(config, "fixed-config\n", { mode: 0o600 });
  await symlink(target, join(scratch, "escape"));
  const before = await lstat(target), configBefore = await lstat(config);
  const profile = await macosWriteProfile({ workspace: null, scratch, controlFiles: [], readOnlyPaths: [config], protectedDirectories: [main] });
  // 固定解释器程序；路径只通过argv传入。此处证明真实OS拒绝，不解析CLI文本或推断节点状态。
  const program = `
    const fs = await import("node:fs/promises");
    const [target, scratch, config] = process.argv.slice(-3);
    const denied = [];
    const attempt = async (name, operation) => { try { await operation(); denied.push({name, denied:false}); } catch(error) { denied.push({name, denied:true, code:error.code}); } };
    await fs.writeFile(scratch + "/runtime-state", "allowed");
    await attempt("absolute-write", () => fs.writeFile(target, "bad"));
    await attempt("symlink-write", () => fs.writeFile(scratch + "/escape", "bad"));
    await attempt("chmod", () => fs.chmod(target, 0o777));
    await attempt("unlink", () => fs.unlink(target));
    await attempt("rename", () => fs.rename(target, scratch + "/moved"));
    await attempt("hardlink-write", async () => { await fs.link(target, scratch + "/alias"); await fs.writeFile(scratch + "/alias", "bad"); });
    await attempt("config-hardlink-write", async () => { await fs.link(config, scratch + "/config-alias"); await fs.writeFile(scratch + "/config-alias", "bad"); });
    const child = Bun.spawn([process.execPath, "-e", 'await Bun.write(process.argv.at(-1), "bad")', target], { stdout:"ignore", stderr:"pipe" });
    const [code] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    denied.push({name:"child-write", denied:code !== 0});
    console.log(JSON.stringify(denied));
  `;
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, process.execPath, "-e", program, target, scratch, config], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", TMPDIR: scratch } });
  const [code, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const results = JSON.parse(output) as { name: string; denied: boolean }[];
  expect(results).toHaveLength(8); expect(results.every(item => item.denied), JSON.stringify(results)).toBe(true);
  expect(await Bun.file(target).text()).toBe("user-original\n"); expect(await Bun.file(config).text()).toBe("fixed-config\n");
  const after = await lstat(target), configAfter = await lstat(config);
  expect([after.ino, after.mode, after.nlink]).toEqual([before.ino, before.mode, before.nlink]);
  expect([configAfter.ino, configAfter.mode, configAfter.nlink]).toEqual([configBefore.ino, configBefore.mode, configBefore.nlink]);
  expect(await Bun.file(join(scratch, "runtime-state")).text()).toBe("allowed");
}, 15_000);

test.skipIf(process.platform !== "darwin")("启动前已有硬链接别名不能绕过私有配置只读", async () => {
  const { scratch, main } = await fixture();
  const home = join(scratch, "home"); await mkdir(home);
  const config = join(home, "config.toml"), alias = join(scratch, "existing-alias");
  await writeFile(config, "fixed\n"); await link(config, alias);
  await expect(macosWriteProfile({ workspace: null, scratch, controlFiles: [], readOnlyPaths: [config], protectedDirectories: [main] })).rejects.toThrow("硬链接别名");
  await expect(macosWriteProfile({ workspace: null, scratch, controlFiles: [], readOnlyPaths: [home], protectedDirectories: [main] })).rejects.toThrow("硬链接别名");
  expect(await Bun.file(config).text()).toBe("fixed\n");
});

test.skipIf(process.platform !== "darwin")("只读认证引用不能指向本会话可写目录", async () => {
  const { scratch, main } = await fixture(); const home = join(scratch, "home"); await mkdir(home);
  const writableToken = join(scratch, "token"), reference = join(home, "auth.json");
  await writeFile(writableToken, "fixture-token\n"); await symlink(writableToken, reference);
  for (const readOnlyPaths of [[reference], [home]]) {
    await expect(macosWriteProfile({ workspace: null, scratch, controlFiles: [], readOnlyPaths, protectedDirectories: [main] })).rejects.toThrow("只读引用指向可写");
  }
  expect(await Bun.file(writableToken).text()).toBe("fixture-token\n");
});

test.skipIf(process.platform !== "darwin")("worktree专属Git index可写，共享refs及主工作区仍拒绝", async () => {
  const { workspace, scratch, main, metadata } = await fixture();
  const gitDirectory = join(metadata, "worktrees", "worker"); await mkdir(gitDirectory, { recursive: true });
  await mkdir(join(metadata, "refs"));
  const profile = await macosWriteProfile({ workspace, scratch, gitDirectory, controlFiles: [], protectedDirectories: [main, metadata] });
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", 'printf index > "$1/index"; printf bad > "$2/refs/main"; printf bad > "$3/file"', "test", gitDirectory, metadata, main], { stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).not.toBe(0); expect(await Bun.file(join(gitDirectory, "index")).text()).toBe("index");
  expect(await Bun.file(join(metadata, "refs", "main")).exists()).toBe(false); expect(await Bun.file(join(main, "file")).exists()).toBe(false);
  await expect(macosWriteProfile({ workspace, scratch, gitDirectory: join(metadata, "refs"), controlFiles: [], protectedDirectories: [main, metadata] })).rejects.toThrow("单一受管目录");
});

test.skipIf(process.platform !== "darwin")("私有状态目录可写但配置、认证引用及其重命名删除保持只读", async () => {
  const { workspace, scratch, main } = await fixture();
  const home=join(scratch,"agent-home"),credentials=join(home,"credentials");await mkdir(home);await mkdir(credentials);
  const config=join(home,"config.toml"),secret=join(credentials,"login.json");await writeFile(config,"safe\n");await writeFile(secret,"token\n");
  const profile=await macosWriteProfile({workspace,scratch,controlFiles:[],readOnlyPaths:[config,credentials],protectedDirectories:[main]});
  const child=Bun.spawn(["/usr/bin/sandbox-exec","-p",profile,"/bin/sh","-c",'printf ok > "$1/state"; printf bad > "$2"; rm "$3"; mv "$4" "$4.moved"; mv "$1" "$1.moved"',"test",home,config,secret,credentials],{stdout:"ignore",stderr:"pipe"});
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(code).not.toBe(0);expect(stderr).toContain("Operation not permitted");expect(await Bun.file(join(home,"state")).text()).toBe("ok");expect(await Bun.file(config).text()).toBe("safe\n");expect(await Bun.file(secret).text()).toBe("token\n");expect(await Bun.file(`${credentials}.moved`).exists()).toBe(false);
});

test.skipIf(process.platform!=="darwin")("未创建插件及MCP路径同样受保护，普通运行状态仍可创建",async()=>{
 const {scratch,main}=await fixture(),home=join(scratch,"home");await mkdir(home);
 const profile=await macosWriteProfile({workspace:null,scratch,controlFiles:[],protectedDirectories:[main],readOnlyPaths:[join(home,"mcp.json"),join(home,"plugins"),join(home,"nested","hooks")]});
 const child=Bun.spawn(["/usr/bin/sandbox-exec","-p",profile,"/bin/sh","-c",'printf state > "$1/state"; printf bad > "$1/mcp.json"; mkdir "$1/plugins"; mkdir -p "$1/nested/hooks"',"test",home],{stdout:"ignore",stderr:"pipe"});
 expect(await child.exited).not.toBe(0);expect(await Bun.file(join(home,"state")).text()).toBe("state");expect(await Bun.file(join(home,"mcp.json")).exists()).toBe(false);await expect(lstat(join(home,"plugins"))).rejects.toMatchObject({code:"ENOENT"});await expect(lstat(join(home,"nested","hooks"))).rejects.toMatchObject({code:"ENOENT"});
});

test.skipIf(process.platform !== "darwin")("最小权限下标准git merge --no-commit可运行，不能更新共享分支ref", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-seatbelt-merge-"))); directories.push(root);
  const main = join(root, "repo"); await mkdir(main);
  const git = async (cwd: string, ...args: string[]) => { const child = Bun.spawn(["/usr/bin/git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (code) throw new Error(err); return out.trim(); };
  await git(main, "init", "-b", "main"); await writeFile(join(main, "a.txt"), "base\n"); await writeFile(join(main, "b.txt"), "base\n"); await git(main, "add", "--", "a.txt", "b.txt"); await git(main, "commit", "-m", "base");
  const repo = await GitRepository.open(main), base = (await repo.inspect()).head;
  const source = await repo.createWorktree(join(root, "source"), "codex/wf-source", base), integration = await repo.createWorktree(join(root, "integration"), "codex/wf-integration", base);
  await writeFile(join(source.cwd, "a.txt"), "source\n"); const saved = await source.save({ requestId: crypto.randomUUID(), baseCommit: base, startCommit: base, allowedPaths: ["a.txt"] });
  const state = await integration.inspect(), scratch = join(root, "scratch"); await mkdir(scratch);
  const profile = await macosWriteProfile({ workspace: integration.cwd, scratch, gitDirectory: state.gitDirectory, controlFiles: [], protectedDirectories: [main, state.commonDirectory] });
  const gitArgs = ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Wave Flow", "-c", "user.email=workspace@wave-flow.local"];
  const objects = join(scratch, "objects"); await mkdir(objects);
  const sandboxEnv = { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(state.commonDirectory, "objects") };
  const merge = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/usr/bin/git", ...gitArgs, "merge", "--no-commit", "--no-ff", saved.commit], { cwd: integration.cwd, env: sandboxEnv, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([merge.exited, new Response(merge.stderr).text()]); expect(code, stderr).toBe(0);
  expect(await Bun.file(join(integration.cwd, "a.txt")).text()).toBe("source\n"); expect(await Bun.file(join(state.gitDirectory, "MERGE_HEAD")).text()).toContain(saved.commit);
  const update = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/usr/bin/git", ...gitArgs, "update-ref", "refs/heads/main", saved.commit, base], { cwd: integration.cwd, env: sandboxEnv, stdout: "ignore", stderr: "ignore" });
  expect(await update.exited).not.toBe(0); expect(await git(main, "rev-parse", "main")).toBe(base);
  const tree = await git(integration.cwd, "write-tree");
  await importGitObjects(integration.cwd, tree, { GIT_INDEX_FILE: join(state.gitDirectory, "index"), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects });
  expect(await git(main, "cat-file", "-t", tree)).toBe("tree");
}, 15_000);
