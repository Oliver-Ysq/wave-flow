import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSkillInjection, codexSkillInjection, dshSkillInjection } from "../../src/skills/injection";
import { prepareSessionSkills } from "../../src/skills/session";
import { readSkillLibrary } from "../../src/skills/library";
import { createSkillProjection } from "../../src/skills/projection";
import type { AcpLauncher } from "../../src/adapters/acp-session";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(withSkill = true): Promise<{ libraryRoot: string; scratch: string; launcher: AcpLauncher }> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-skill-session-")); roots.push(root);
  const libraryRoot = join(root, "skills");
  if (withSkill) {
    await mkdir(join(libraryRoot, "alpha"), { recursive: true });
    await writeFile(join(libraryRoot, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\n", "utf8");
  }
  const scratch = join(root, "scratch"); await mkdir(scratch);
  return { libraryRoot, scratch, launcher: { id: "test-acp", command: "/bin/false", args: ["acp"] } };
}

describe("执行期技能注入", () => {
  test("空库是 no-op，不需要能力声明", async () => {
    const { libraryRoot, scratch, launcher } = await setup(false);
    await expect(prepareSessionSkills({ scratch, launcher, libraryRoot })).resolves.toEqual({ launcher, evidence: null });
  });

  test("库非空但 CLI 无已验证能力时 fail closed", async () => {
    const { libraryRoot, scratch, launcher } = await setup();
    await expect(prepareSessionSkills({ scratch, launcher, libraryRoot })).rejects.toThrow("尚未通过执行期技能注入验证");
    await expect(prepareSessionSkills({ scratch, launcher, libraryRoot, capability: { ...codexSkillInjection, verified: false } })).rejects.toThrow("尚未通过执行期技能注入验证");
  });

  test("Codex 通过 additionalDirectories 注入并记录证据", async () => {
    const { libraryRoot, scratch, launcher } = await setup();
    const prepared = await prepareSessionSkills({ scratch, launcher, capability: codexSkillInjection, libraryRoot });
    expect(prepared.launcher).toEqual(launcher);
    expect(prepared.session?.additionalDirectories).toHaveLength(1);
    expect(prepared.session?.additionalDirectories?.[0]).toBe(join(scratch, "skills"));
    expect(prepared.evidence).toMatchObject({ mechanism: "codex-extra-roots", count: 1, names: ["alpha"] });
    expect(prepared.evidence?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(codexSkillInjection.advertisedMatch("alpha", "$alpha")).toBe(true);
  });

  test("Claude 通过 _meta 本地插件注入", async () => {
    const { libraryRoot, scratch, launcher } = await setup();
    const prepared = await prepareSessionSkills({ scratch, launcher, capability: claudeSkillInjection, libraryRoot });
    const options = prepared.session?.meta as { claudeCode: { options: { plugins: Array<{ type: string; path: string }> } } };
    expect(options.claudeCode.options.plugins).toEqual([{ type: "local", path: join(scratch, "skills", "claude-plugin") }]);
    expect(prepared.evidence?.mechanism).toBe("claude-plugin-dir");
    expect(claudeSkillInjection.advertisedMatch("alpha", "wave-flow-skills:alpha")).toBe(true);
  });

  test("DSH 追加 --patch 且 patch 指定 customSkillDirs", async () => {
    const { libraryRoot, scratch, launcher } = await setup();
    const prepared = await prepareSessionSkills({ scratch, launcher, capability: dshSkillInjection, libraryRoot });
    expect(prepared.launcher.args).toEqual(["acp", "--patch", join(scratch, "skills.patch.yml")]);
    expect(prepared.session).toBeUndefined();
    expect(await readFile(join(scratch, "skills.patch.yml"), "utf8")).toContain(join(scratch, "skills", ".agents", "skills"));
    expect(prepared.evidence?.mechanism).toBe("dsh-patch");
  });

  test("投影只写 scratch，不修改技能库", async () => {
    const { libraryRoot, scratch, launcher } = await setup();
    const before = await readSkillLibrary(libraryRoot);
    await prepareSessionSkills({ scratch, launcher, capability: codexSkillInjection, libraryRoot });
    const after = await readSkillLibrary(libraryRoot);
    expect(after.digest).toBe(before.digest);
    const otherScratch = join(scratch, "second"); await mkdir(otherScratch);
    const projection = await createSkillProjection(otherScratch, after);
    expect(projection?.claudePluginDir.startsWith(otherScratch)).toBe(true);
  });
});
