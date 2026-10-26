import { afterEach, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macosWriteProfile } from "../../src/workspace/macos-write-sandbox";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-seatbelt-test-"))); directories.push(root);
  const workspace = join(root, "workspace"), scratch = join(root, "scratch"), main = join(root, "main"), metadata = join(root, "git");
  for (const path of [workspace, scratch, main, metadata]) await mkdir(path);
  return { root, workspace, scratch, main, metadata };
}
test.skipIf(process.platform !== "darwin")("主控shell只写scratch，绝对路径与符号链接绕路不能写主目录或Git元数据", async () => {
  const { workspace, scratch, main, metadata } = await fixture();
  await writeFile(join(main, "protected"), "user\n"); await symlink(main, join(workspace, "escape"));
  const profile = await macosWriteProfile({ workspace: null, scratch, controlFiles: [], protectedDirectories: [main, metadata] });
  // 参数通过argv传入，无用户文本shell插值；子shell同样继承Seatbelt。
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", 'printf work > "$1/ok"; printf temp > "$2/ok"; /bin/sh -c \'printf bad > "$1/protected"\' ignored "$3"; printf bad > "$1/escape/protected"; printf bad > "$4/config"', "test", workspace, scratch, main, metadata], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).not.toBe(0); expect(stderr).toContain("Operation not permitted");
  expect(await Bun.file(join(scratch, "ok")).text()).toBe("temp");
  expect(await Bun.file(join(main, "protected")).text()).toBe("user\n"); expect(await Bun.file(join(metadata, "config")).exists()).toBe(false);
});
test.skipIf(process.platform !== "darwin")("拒绝重叠、软链接及宽泛根目录写授权", async () => {
  const { root, workspace, scratch, main } = await fixture();
  await expect(macosWriteProfile({ workspace: null, scratch, controlFiles: [], protectedDirectories: [root] })).rejects.toThrow("重叠");
  await symlink(workspace, join(root, "link"));
  await expect(macosWriteProfile({ workspace: null, scratch: join(root, "link"), controlFiles: [], protectedDirectories: [main] })).rejects.toThrow("canonical");
  await expect(macosWriteProfile({ workspace: null, scratch: "/", controlFiles: [], protectedDirectories: [main] })).rejects.toThrow("路径无效");
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


test.skipIf(process.platform !== "darwin")("私有状态目录可写但配置、认证引用及其重命名删除保持只读", async () => {
  const { workspace, scratch, main } = await fixture();
  const home=join(scratch,"agent-home"),credentials=join(home,"credentials");await mkdir(home);await mkdir(credentials);
  const config=join(home,"config.toml"),secret=join(credentials,"login.json");await writeFile(config,"safe\n");await writeFile(secret,"token\n");
  const profile=await macosWriteProfile({workspace:null,scratch,controlFiles:[],readOnlyPaths:[config,credentials],protectedDirectories:[main]});
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

test.skipIf(process.platform !== "darwin")("感知模式profile先deny受保护目录再allow嵌套scratch，空保护列表拒绝", async () => {
  const { root } = await fixture();
  const project = join(root, "project"), stateHome = join(root, "state"), scratch = join(stateHome, "harness-scratch", "session-fixture");
  for (const path of [project, stateHome, join(stateHome, "harness-scratch"), scratch]) await mkdir(path);
  const profile = await macosWriteProfile({ workspace: null, mode: "perception", scratch, controlFiles: [], protectedDirectories: [project, stateHome] });
  expect(profile).toContain("(allow default)");
  const denyIndex = profile.indexOf(`(deny file-write* (subpath ${JSON.stringify(project)})`);
  const allowIndex = profile.indexOf(`(allow file-write* (subpath ${JSON.stringify(scratch)})`);
  const unlinkIndex = profile.indexOf(`(deny file-write-unlink (literal ${JSON.stringify(project)})`);
  // 顺序即语义：Seatbelt 最后匹配优先，scratch 位于被保护状态目录内必须排在其后。
  expect(denyIndex).toBeGreaterThan(0);
  expect(allowIndex).toBeGreaterThan(denyIndex);
  expect(unlinkIndex).toBeGreaterThan(allowIndex);
  expect(profile).toContain(`(subpath ${JSON.stringify(stateHome)})`);
  // 路径写权限不能阻止通过项目外硬链接别名改写项目文件，必须全局禁建硬链接。
  expect(profile).toContain("(deny file-link)");
  // 感知模式不允许退化成全盘可写：必须至少声明一个受保护目录。
  await expect(macosWriteProfile({ workspace: null, mode: "perception", scratch, controlFiles: [], protectedDirectories: [] })).rejects.toThrow("受保护目录");
  // 受保护目录落在 scratch 内时 allow 会覆盖 deny，拒绝这种边界。
  const outside = join(root, "outside"), insideScratch = join(outside, "protected"); await mkdir(outside); await mkdir(insideScratch);
  await expect(macosWriteProfile({ workspace: null, mode: "perception", scratch: outside, controlFiles: [], protectedDirectories: [insideScratch] })).rejects.toThrow("不得覆盖");
  // 受保护目录必须是 canonical 真实目录。
  await symlink(project, join(root, "project-link"));
  await expect(macosWriteProfile({ workspace: null, mode: "perception", scratch, controlFiles: [], protectedDirectories: [join(root, "project-link")] })).rejects.toThrow("canonical");
  // 感知模式不接受额外 CLI 可写根或只读例外。
  await expect(macosWriteProfile({ workspace: null, mode: "perception", scratch, controlFiles: [], protectedDirectories: [project], cliWritableRoots: [outside] })).rejects.toThrow("额外CLI可写根");
  await expect(macosWriteProfile({ workspace: null, mode: "perception", scratch, controlFiles: [], protectedDirectories: [project], readOnlyPaths: [join(project, "x")] })).rejects.toThrow("只读例外");
});

test.skipIf(process.platform !== "darwin")("感知模式真实sandbox-exec：项目与Engine状态目录不可写不可删，scratch与Home其他目录可写", async () => {
  const { root } = await fixture();
  const project = join(root, "project"), engineHome = join(root, "engine-home"), scratch = join(engineHome, "harness-scratch", "session-fixture"), home = join(root, "home");
  for (const path of [project, engineHome, join(engineHome, "harness-scratch"), scratch, home]) await mkdir(path);
  await writeFile(join(project, "existing.txt"), "original\n");
  const profile = await macosWriteProfile({ workspace: null, mode: "perception", scratch, controlFiles: [], protectedDirectories: [project, engineHome] });
  // 参数只通过 argv 传入，无用户文本 shell 插值；子进程同样继承 Seatbelt。
  const program = `
    const fs = await import("node:fs/promises");
    const [root, project, engineHome, scratch, home] = process.argv.slice(-5);
    const attempts = [];
    const attempt = async (name, operation) => { try { await operation(); attempts.push({ name, denied: false }); } catch (error) { attempts.push({ name, denied: true, code: error.code }); } };
    await attempt("project-write", () => fs.writeFile(project + "/new.txt", "bad"));
    await attempt("project-delete", () => fs.unlink(project + "/existing.txt"));
    await attempt("project-rename", () => fs.rename(project + "/existing.txt", project + "/renamed.txt"));
    await attempt("engine-home-write", () => fs.writeFile(engineHome + "/settings.json", "bad"));
    await attempt("scratch-write", () => fs.writeFile(scratch + "/tool-state", "ok"));
    await attempt("scratch-mkdir", () => fs.mkdir(scratch + "/run-dir"));
    await attempt("project-hardlink", () => fs.link(project + "/existing.txt", root + "/hard-alias"));
    await attempt("home-write", () => fs.writeFile(home + "/notes.txt", "ok"));
    await attempt("outside-write", () => fs.writeFile(root + "/other.txt", "ok"));
    // 根目录 unlink 由 tail 的 deny file-write-unlink( literal ) 保护；放在最后避免影响前序断言。
    await attempt("project-root-rename", () => fs.rename(project, root + "/moved-project"));
    await attempt("engine-home-rename", () => fs.rename(engineHome, root + "/moved-engine"));
    await attempt("project-subtree-delete", () => fs.rm(project, { recursive: true, force: false }));
    console.log(JSON.stringify(attempts));
  `;
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, process.execPath, "-e", program, root, project, engineHome, scratch, home], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", TMPDIR: scratch } });
  const [code, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const results = JSON.parse(output) as { name: string; denied: boolean }[];
  const byName = Object.fromEntries(results.map(item => [item.name, item.denied]));
  // 项目内写入/删除/重命名、Engine 状态目录写入、两个根目录重命名与项目子树删除全部拒绝。
  for (const name of ["project-write", "project-delete", "project-rename", "engine-home-write", "project-hardlink", "project-root-rename", "engine-home-rename", "project-subtree-delete"]) expect(byName[name], name).toBe(true);
  // scratch（位于被保护状态目录内）与 Home 其他目录、项目外目录可写。
  for (const name of ["scratch-write", "scratch-mkdir", "home-write", "outside-write"]) expect(byName[name], name).toBe(false);
  expect(await Bun.file(join(project, "existing.txt")).text()).toBe("original\n");
  expect(await Bun.file(join(project, "new.txt")).exists()).toBe(false);
  expect(await Bun.file(join(project, "renamed.txt")).exists()).toBe(false);
  expect(await Bun.file(join(engineHome, "settings.json")).exists()).toBe(false);
  expect(await Bun.file(join(scratch, "tool-state")).text()).toBe("ok");
  expect(await Bun.file(join(home, "notes.txt")).text()).toBe("ok");
  expect(await Bun.file(join(root, "other.txt")).text()).toBe("ok");
  expect(await Bun.file(join(root, "hard-alias")).exists()).toBe(false);
  expect(await Bun.file(join(root, "moved-project")).exists()).toBe(false);
  expect(await Bun.file(join(root, "moved-engine")).exists()).toBe(false);
}, 20_000);

test.skipIf(process.platform !== "darwin")("macOS系统/tmp别名在两种写边界中统一规范化", async () => {
  const { main } = await fixture(), scratch = join("/tmp", `wave-flow-system-tmp-${crypto.randomUUID()}`);
  await mkdir(scratch); directories.push(scratch);
  for (const mode of ["isolated", "perception"] as const) {
    const profile = await macosWriteProfile({ workspace: null, scratch, controlFiles: [], protectedDirectories: [main], mode });
    expect(profile).toContain("/private/tmp/");
  }
});
