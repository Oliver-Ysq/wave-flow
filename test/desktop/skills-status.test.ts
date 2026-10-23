import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopExecutionEngine, type SkillLibraryStatus } from "../../src/desktop/desktop-execution-engine";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function engineWithSkills(skillsRoot: string, homeDir?: string): DesktopExecutionEngine {
  const root = join(skillsRoot, "..");
  return new DesktopExecutionEngine({ harnessRoot: join(root, "harness-runs"), storeRoot: join(root, "runs"), skillsRoot, homeDir, deterministicForTest: true });
}

async function writeSkill(skillsRoot: string, name: string, frontmatter = `name: ${name}\ndescription: ${name}\n`): Promise<void> {
  await mkdir(join(skillsRoot, name), { recursive: true });
  await writeFile(join(skillsRoot, name, "SKILL.md"), `---\n${frontmatter}---\n`, "utf8");
}

describe("Engine 技能库状态", () => {
  test("空库、合法库与每个可选 CLI 的注入能力", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-skills-")); roots.push(root);
    const skillsRoot = join(root, "skills");
    const engine = engineWithSkills(skillsRoot);
    try {
      await expect(engine.handleDesktopAction("skills.status")).resolves.toMatchObject({
        root: skillsRoot, exists: false, count: 0, digest: null,
        capabilities: [
          { cli: "codex", injection: "verified" },
          { cli: "claude", injection: "verified" },
          { cli: "dsh", injection: "verified" },
        ],
        unavailable: [{ cli: "kimi" }],
      });
      await writeSkill(skillsRoot, "alpha");
      const status = await engine.handleDesktopAction("skills.status") as SkillLibraryStatus;
      expect(status).toMatchObject({ exists: true, count: 1, skills: [{ name: "alpha", requiredBins: [], missingBins: [] }], missingDependencies: [] });
      expect(status.digest).toMatch(/^[0-9a-f]{64}$/);
      await writeSkill(skillsRoot, "needs-tool", "name: needs-tool\ndescription: needs-tool\nmetadata:\n  requires:\n    bins: [\"wave-flow-definitely-missing-bin\", \"sh\"]\n");
      const withDeps = await engine.handleDesktopAction("skills.status") as SkillLibraryStatus;
      expect(withDeps.missingDependencies).toEqual(["wave-flow-definitely-missing-bin"]);
      expect(withDeps.skills.find(item => item.name === "needs-tool")?.missingBins).toEqual(["wave-flow-definitely-missing-bin"]);
    } finally { engine.shutdown(); }
  });

  test("skills.discover 只读发现 CLI 技能，skills.import 复制入托管库", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-skill-import-")); roots.push(root);
    const home = join(root, "home"); await writeSkill(join(home, ".codex", "skills"), "alpha");
    const skillsRoot = join(root, "skills");
    const engine = engineWithSkills(skillsRoot, home);
    try {
      const discovered = await engine.handleDesktopAction("skills.discover") as import("../../src/skills/import").SkillDiscoverResult;
      expect(discovered.sources.find(source => source.cli === "codex")?.exists).toBe(true);
      expect(discovered.skills).toMatchObject([{ name: "alpha", sourceCli: "codex", installed: "none", valid: true }]);
      await expect(engine.handleDesktopAction("skills.import", { path: discovered.skills[0]!.path })).resolves.toEqual({ name: "alpha" });
      const status = await engine.handleDesktopAction("skills.status") as SkillLibraryStatus;
      expect(status).toMatchObject({ count: 1, skills: [{ name: "alpha", description: "alpha" }] });
      await expect(engine.handleDesktopAction("skills.import", { path: join(home, "outside") })).rejects.toMatchObject({ status: 400 });
    } finally { engine.shutdown(); }
  });

  test("非法 skill 只跳过并报告，不阻断合法库与设置页", async () => {
    const root = await mkdtemp(join(tmpdir(), "wave-flow-engine-skills-bad-")); roots.push(root);
    const skillsRoot = join(root, "skills"); await mkdir(join(skillsRoot, "broken"), { recursive: true });
    const engine = engineWithSkills(skillsRoot);
    try {
      const status = await engine.handleDesktopAction("skills.status") as SkillLibraryStatus;
      expect(status).toMatchObject({ count: 0, invalid: [{ name: "broken", issue: expect.stringContaining("缺少 SKILL.md") }] });
      await writeSkill(skillsRoot, "alpha");
      const mixed = await engine.handleDesktopAction("skills.status") as SkillLibraryStatus;
      expect(mixed.count).toBe(1);
      expect(mixed.invalid?.map(item => item.name)).toContain("broken");
    } finally { engine.shutdown(); }
  });
});
