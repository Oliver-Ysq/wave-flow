import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillLibrary } from "../../src/skills/library";
import { createSkillProjection } from "../../src/skills/projection";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(): Promise<{ libraryRoot: string; scratch: string }> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-skill-projection-")); roots.push(root);
  const libraryRoot = join(root, "skills");
  await mkdir(join(libraryRoot, "alpha"), { recursive: true });
  await writeFile(join(libraryRoot, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\n", "utf8");
  const scratch = join(root, "scratch"); await mkdir(scratch);
  return { libraryRoot, scratch };
}

describe("技能投影", () => {
  test("空库不创建投影", async () => {
    const { scratch } = await setup();
    const library = await readSkillLibrary(join(scratch, "missing-library"));
    expect(await createSkillProjection(scratch, library)).toBeNull();
  });

  test("生成 agents 根、Claude 插件与 DSH patch，全部指向库内真实目录", async () => {
    const { libraryRoot, scratch } = await setup();
    const library = await readSkillLibrary(libraryRoot);
    const nativeBefore = await readdir(libraryRoot);
    const projection = (await createSkillProjection(scratch, library))!;
    expect(projection.agentsSkillsDir).toBe(join(scratch, "skills", ".agents", "skills"));
    expect(await readlink(join(projection.agentsSkillsDir, "alpha"))).toBe(await realpath(join(libraryRoot, "alpha")));
    expect(await readlink(join(projection.claudePluginDir, "skills", "alpha"))).toBe(await realpath(join(libraryRoot, "alpha")));
    const manifest = JSON.parse(await readFile(join(projection.claudePluginDir, ".claude-plugin", "plugin.json"), "utf8")) as { name: string };
    expect(manifest.name).toBe("wave-flow-skills");
    const patch = await readFile(projection.patchFile, "utf8");
    expect(patch).toContain("- id: skill-filesystem");
    expect(patch).toContain("customSkillDirs:");
    expect(patch).toContain(projection.agentsSkillsDir);
    // 投影只读库：库目录内容与条目不变。
    expect(await readdir(libraryRoot)).toEqual(nativeBefore);
    expect((await lstat(join(libraryRoot, "alpha", "SKILL.md"))).isFile()).toBe(true);
  });

  test("库内 skill 在投影前被替换为软链时拒绝注入", async () => {
    const { libraryRoot, scratch } = await setup();
    const library = await readSkillLibrary(libraryRoot);
    // 模拟扫描后目录被替换：投影只信任库根下的真实目录。
    const elsewhere = join(scratch, "elsewhere"); await mkdir(elsewhere);
    await rm(join(libraryRoot, "alpha"), { recursive: true, force: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(elsewhere, join(libraryRoot, "alpha"));
    await expect(createSkillProjection(scratch, library)).rejects.toThrow("越出技能库或身份变化");
  });
});
