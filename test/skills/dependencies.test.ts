import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingRequiredBins, skillDependencyPath } from "../../src/skills/dependencies";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function binDirectory(bin: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wave-flow-skill-deps-")); roots.push(root);
  const path = join(root, bin); await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(path, 0o700);
  return root;
}

describe("技能依赖只读诊断", () => {
  test("按给定 PATH 找到可执行文件，缺失与非法名称如实报告", async () => {
    const directory = await binDirectory("probe-bin");
    await expect(missingRequiredBins(["probe-bin"], directory)).resolves.toEqual([]);
    await expect(missingRequiredBins(["probe-bin", "missing-bin"], directory)).resolves.toEqual(["missing-bin"]);
    await expect(missingRequiredBins(["../escape"], directory)).resolves.toEqual(["../escape"]);
    await expect(missingRequiredBins([], directory)).resolves.toEqual([]);
  });

  test("诊断 PATH 保留 Engine PATH 并补系统目录", () => {
    const path = skillDependencyPath("/custom/bin:/usr/bin");
    expect(path).toContain("/custom/bin");
    expect(path).toContain("/opt/homebrew/bin");
    expect(new Set(path.split(":")).size).toBe(path.split(":").length);
  });
});
