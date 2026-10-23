import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillLibrary, readSkillLibraryDigest, SkillLibraryValidationError, skillLibraryRoot } from "../../src/skills/library";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "wave-flow-skill-library-")); roots.push(value); return value; }
async function skill(base: string, name: string, body: string, frontmatter = `name: ${name}\ndescription: ${name} 的说明\n`): Promise<void> {
  await mkdir(join(base, name), { recursive: true });
  await writeFile(join(base, name, "SKILL.md"), `---\n${frontmatter}---\n\n${body}\n`, "utf8");
}

describe("托管技能库扫描", () => {
  test("缺失目录是空库；skillLibraryRoot 默认位于状态根下", async () => {
    const base = await root();
    await expect(readSkillLibrary(join(base, "skills"))).resolves.toEqual({ root: join(base, "skills"), exists: false, digest: null, skills: [] });
    expect(skillLibraryRoot("/tmp/state")).toBe("/tmp/state/skills");
  });

  test("扫描合法 skill 并生成稳定摘要；resource 文件不参与摘要", async () => {
    const base = join(await root(), "skills");
    await skill(base, "alpha", "A 正文");
    await skill(base, "beta", "B 正文");
    await writeFile(join(base, "alpha", "notes.txt"), "ignored", "utf8");
    const first = await readSkillLibrary(base);
    const second = await readSkillLibrary(base);
    expect(first.skills.map(item => item.name)).toEqual(["alpha", "beta"]);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.digest).toBe(second.digest);
    await writeFile(join(base, "alpha", "notes.txt"), "changed", "utf8");
    expect((await readSkillLibraryDigest(base))).toBe(first.digest);
    await skill(base, "alpha", "A 新正文");
    expect(await readSkillLibraryDigest(base)).not.toBe(first.digest);
  });

  test("解析 metadata.requires.bins 的内联与块列表写法", async () => {
    const base = join(await root(), "skills");
    await skill(base, "alpha", "A", `name: alpha\ndescription: A\nmetadata:\n  requires:\n    bins: ["lark-cli", "bytedcli"]\n`);
    await skill(base, "beta", "B", `name: beta\ndescription: B\nmetadata:\n  requires:\n    bins:\n      - git\n      - rg\n`);
    const library = await readSkillLibrary(base);
    expect(library.skills.find(item => item.name === "alpha")?.requiredBins).toEqual(["lark-cli", "bytedcli"]);
    expect(library.skills.find(item => item.name === "beta")?.requiredBins).toEqual(["git", "rg"]);
  });

  test("支持 description 的折叠/字面量多行写法", async () => {
    const base = join(await root(), "skills");
    await skill(base, "folded", "x", "name: folded\ndescription: >\n  第一行说明。\n  第二行说明。\n");
    await skill(base, "literal", "x", "name: literal\ndescription: |\n  第一行。\n  第二行。\n");
    const library = await readSkillLibrary(base);
    expect(library.skills.find(item => item.name === "folded")?.description).toBe("第一行说明。 第二行说明。");
    expect(library.skills.find(item => item.name === "literal")?.description).toContain("第一行。");
  });

  test("非法 skill 只跳过自身，合法项继续可用", async () => {
    const base = join(await root(), "skills");
    await skill(base, "ok-skill", "ok");
    await mkdir(join(base, "no-file"));
    await skill(base, "name-mismatch", "x", "name: other-name\ndescription: x\n");
    await skill(base, "no-description", "x", "name: no-description\n");
    const library = await readSkillLibrary(base);
    expect(library.skills.map(item => item.name)).toEqual(["ok-skill"]);
    expect(library.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(library.invalid?.map(item => item.name)).toEqual(expect.arrayContaining(["name-mismatch", "no-description", "no-file"]));
    expect(library.invalid?.map(item => item.issue).join("\n")).toContain("缺少 SKILL.md");
    expect(library.invalid?.map(item => item.issue).join("\n")).toContain("description");
  });

  test("根目录软链仍拒绝；非法名称与嵌套软链只跳过对应 skill", async () => {
    const base = join(await root(), "skills");
    await mkdir(base, { recursive: true });
    await mkdir(join(base, "real-target"));
    await writeFile(join(base, "real-target", "SKILL.md"), "---\nname: real-target\ndescription: x\n---\n", "utf8");
    await symlink(join(base, "real-target"), join(base, "linked"));
    const linkedRoot = join(base, "linked-root");
    await symlink(base, linkedRoot);
    await expect(readSkillLibrary(linkedRoot)).rejects.toThrow("不能是软链");
    await skill(base, "Upper_Case", "x", "name: Upper_Case\ndescription: x\n");
    await skill(base, "nested-link", "x");
    await symlink(join(base, "real-target", "SKILL.md"), join(base, "nested-link", "alias.md"));
    const library = await readSkillLibrary(base);
    expect(library.skills.map(item => item.name)).toContain("real-target");
    expect(library.invalid?.map(item => item.name)).toEqual(expect.arrayContaining(["Upper_Case", "nested-link"]));
    expect(library.invalid?.find(item => item.name === "nested-link")?.issue).toContain("软链");
  });
});
