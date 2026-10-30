import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, importSkillFromDirectory, importSkillZip } from "../../src/skills/import";
import { readSkillLibrary } from "../../src/skills/library";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "wave-flow-skill-import-")); roots.push(value); return value; }
async function skill(directory: string, body = "body", description = "说明"): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${directory.split("/").pop()}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
}

describe("从 CLI 技能目录导入", () => {
  test("只读发现各来源，并标注已安装关系", async () => {
    const home = await root();
    await skill(join(home, ".codex", "skills", "alpha"));
    await skill(join(home, ".claude", "skills", "beta"));
    const libraryRoot = join(home, ".wave-flow", "skills");
    await skill(join(libraryRoot, "alpha"), "different body");
    const result = await discoverSkills(libraryRoot, home);
    expect(result.sources.find(source => source.cli === "codex")?.exists).toBe(true);
    expect(result.sources.find(source => source.cli === "kimi")?.exists).toBe(false);
    expect(result.skills.map(item => [item.name, item.sourceCli, item.installed])).toEqual([
      ["alpha", "codex", "different"],
      ["beta", "claude", "none"],
    ]);
  });

  test("复制导入后再次导入同名拒绝；来源目录外拒绝", async () => {
    const home = await root();
    const source = join(home, ".codex", "skills", "alpha");
    await skill(source, "alpha body");
    await writeFile(join(source, "notes.txt"), "resource", "utf8");
    const libraryRoot = join(home, ".wave-flow", "skills");
    const imported = await importSkillFromDirectory(source, libraryRoot, home);
    expect(imported.name).toBe("alpha");
    expect(imported.path).toBe(join(libraryRoot, "alpha"));
    expect(await readFile(join(libraryRoot, "alpha", "notes.txt"), "utf8")).toBe("resource");
    await expect(importSkillFromDirectory(source, libraryRoot, home)).rejects.toThrow("已存在同名");
    const outside = join(home, "outside", "gamma"); await skill(outside);
    await expect(importSkillFromDirectory(outside, libraryRoot, home)).rejects.toThrow("只能从已识别");
  });
});

test("允许发现并导入 CLI 目录下的 symlink skill", async () => {
  const home = await root();
  const target = join(home, "external", "alpha");
  await skill(target, "linked body");
  await mkdir(join(home, ".claude", "skills"), { recursive: true });
  const link = join(home, ".claude", "skills", "linked-alpha");
  await symlink(target, link);
  const libraryRoot = join(home, ".wave-flow", "skills");
  const discovered = await discoverSkills(libraryRoot, home);
  const candidate = discovered.skills.find(item => item.name === "alpha");
  expect(candidate).toMatchObject({ valid: true, sourceCli: "claude", path: link });
  await importSkillFromDirectory(link, libraryRoot, home);
  expect((await readSkillLibrary(libraryRoot)).skills.map(item => item.name)).toEqual(["alpha"]);
});

describe("从 skill.zip 导入", () => {
  test("支持唯一顶层 skill 目录的压缩包", async () => {
    const workspace = await root();
    await skill(join(workspace, "zip-skill"), "zip body", "zip description");
    const zipPath = join(workspace, "skill.zip");
    const zipped = Bun.spawnSync(["/usr/bin/zip", "-qr", zipPath, "zip-skill"], { cwd: workspace });
    expect(zipped.exitCode).toBe(0);
    const libraryRoot = join(workspace, "library");
    const imported = await importSkillZip(zipPath, libraryRoot);
    expect(imported).toMatchObject({ name: "zip-skill", description: "zip description" });
    expect(imported.path).toBe(join(libraryRoot, "zip-skill"));
    expect((await readSkillLibrary(libraryRoot)).skills.map(item => item.name)).toEqual(["zip-skill"]);
  });

  test("支持 ZIP 根目录直接含 SKILL.md 的布局", async () => {
    const workspace = await root();
    const source = join(workspace, "root-skill");
    await skill(source, "root body", "root description");
    const zipPath = join(workspace, "root.zip");
    const zipped = Bun.spawnSync(["/usr/bin/zip", "-qr", zipPath, "."], { cwd: source });
    expect(zipped.exitCode).toBe(0);
    const imported = await importSkillZip(zipPath, join(workspace, "library"));
    expect(imported).toMatchObject({ name: "root-skill", description: "root description" });
    expect((await readSkillLibrary(join(workspace, "library"))).skills.map(item => item.name)).toEqual(["root-skill"]);
  });

  test("拒绝非 zip、多个顶层 skill 与非法 SKILL.md", async () => {
    const workspace = await root();
    const notZip = join(workspace, "file.txt"); await writeFile(notZip, "x", "utf8");
    await expect(importSkillZip(notZip, join(workspace, "library"))).rejects.toThrow(".zip");
    await skill(join(workspace, "one"));
    await skill(join(workspace, "two"));
    const multi = join(workspace, "multi.zip");
    expect(Bun.spawnSync(["/usr/bin/zip", "-qr", multi, "one", "two"], { cwd: workspace }).exitCode).toBe(0);
    await expect(importSkillZip(multi, join(workspace, "library"))).rejects.toThrow("只包含一个 skill");
    const broken = join(workspace, "broken", "bad-skill"); await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "SKILL.md"), "no frontmatter", "utf8");
    const brokenZip = join(workspace, "broken.zip");
    expect(Bun.spawnSync(["/usr/bin/zip", "-qr", brokenZip, "bad-skill"], { cwd: join(workspace, "broken") }).exitCode).toBe(0);
    await expect(importSkillZip(brokenZip, join(workspace, "library"))).rejects.toThrow("frontmatter");
  });
});
