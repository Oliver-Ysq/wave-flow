import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macosWriteProfile } from "../../src/workspace/macos-write-sandbox";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "wave-flow-seatbelt-test-"))); directories.push(root);
  const scratch = join(root, "scratch"), main = join(root, "main"), state = join(root, "state");
  for (const path of [scratch, main, state]) await mkdir(path);
  return { root, scratch, main, state };
}

test.skipIf(process.platform !== "darwin")("拒绝重叠、软链接及宽泛根目录写授权", async () => {
  const { root, scratch, main } = await fixture();
  await symlink(scratch, join(root, "link"));
  await expect(macosWriteProfile({ scratch: join(root, "link"), controlFiles: [], protectedDirectories: [main] })).rejects.toThrow("canonical");
  await expect(macosWriteProfile({ scratch: "/", controlFiles: [], protectedDirectories: [main] })).rejects.toThrow("路径无效");
  await expect(macosWriteProfile({ scratch, controlFiles: [], protectedDirectories: [] })).rejects.toThrow("受保护目录");
});

test.skipIf(process.platform !== "darwin")("写边界先 deny 受保护目录再 allow 嵌套 scratch，拒绝非 canonical 受保护目录", async () => {
  const { root, scratch: base } = await fixture();
  const project = join(root, "project"), stateHome = join(root, "state-home"), scratch = join(stateHome, "lead-scratch", "session-fixture");
  for (const path of [project, stateHome, join(stateHome, "lead-scratch"), scratch]) await mkdir(path);
  const profile = await macosWriteProfile({ scratch, controlFiles: [], protectedDirectories: [project, stateHome] });
  expect(profile).toContain("(allow default)");
  const denyIndex = profile.indexOf(`(deny file-write* (subpath ${JSON.stringify(project)})`);
  const allowIndex = profile.indexOf(`(allow file-write* (subpath ${JSON.stringify(scratch)})`);
  const unlinkIndex = profile.indexOf(`(deny file-write-unlink (literal ${JSON.stringify(project)})`);
  // 顺序即语义：Seatbelt 最后匹配优先，scratch 位于被保护状态目录内必须排在其后。
  expect(denyIndex).toBeGreaterThan(0);
  expect(allowIndex).toBeGreaterThan(denyIndex);
  expect(unlinkIndex).toBeGreaterThan(allowIndex);
  expect(profile).toContain(`(subpath ${JSON.stringify(stateHome)})`);
  expect(profile).toContain("(deny file-link)");
  // 受保护目录落在 scratch 内时 allow 会覆盖 deny，拒绝这种边界。
  const outside = join(root, "outside"), insideScratch = join(outside, "protected");
  await mkdir(outside); await mkdir(insideScratch);
  await expect(macosWriteProfile({ scratch: outside, controlFiles: [], protectedDirectories: [insideScratch] })).rejects.toThrow("不得覆盖");
  // 受保护目录必须是 canonical 真实目录。
  await symlink(project, join(root, "project-link"));
  await expect(macosWriteProfile({ scratch: base, controlFiles: [], protectedDirectories: [join(root, "project-link")] })).rejects.toThrow("canonical");
});

test.skipIf(process.platform !== "darwin")("真实 sandbox-exec：项目与 Engine 状态目录不可写不可删，scratch 与 Home 其他目录可写", async () => {
  const { root, main, state } = await fixture();
  const project = join(root, "project"), engineHome = join(root, "engine-home"), scratch = join(engineHome, "lead-scratch", "session-fixture"), home = join(root, "home");
  for (const path of [project, engineHome, join(engineHome, "lead-scratch"), scratch, home]) await mkdir(path);
  await writeFile(join(project, "existing.txt"), "original\n");
  const profile = await macosWriteProfile({ scratch, controlFiles: [], protectedDirectories: [project, engineHome] });
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
  for (const name of ["project-write", "project-delete", "project-rename", "engine-home-write", "project-hardlink", "project-root-rename", "engine-home-rename", "project-subtree-delete"]) expect(byName[name], name).toBe(true);
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

test.skipIf(process.platform !== "darwin")("macOS系统/tmp别名在写边界中统一规范化", async () => {
  const { main } = await fixture(), scratch = join("/tmp", `wave-flow-system-tmp-${crypto.randomUUID()}`);
  await mkdir(scratch); directories.push(scratch);
  const profile = await macosWriteProfile({ scratch, controlFiles: [], protectedDirectories: [main] });
  expect(profile).toContain("/private/tmp/");
});
