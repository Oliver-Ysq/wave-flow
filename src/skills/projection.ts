import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SkillLibrary, SkillProjection } from "./types";

/**
 * 在会话私有 scratch 下生成技能投影。
 *
 * 只创建软链与最小描述文件；不复制 skill 内容、不写技能库、不写任何原生 CLI 目录。
 * 软链目标先经 realpath 校验必须直接位于库根下，拒绝越界与名称错配。
 */
export async function createSkillProjection(scratch: string, library: SkillLibrary): Promise<SkillProjection | null> {
  if (library.skills.length === 0) return null;
  const libraryRoot = await realpath(library.root);
  const root = join(scratch, "skills");
  const agentsSkillsDir = join(root, ".agents", "skills");
  const claudePluginDir = join(root, "claude-plugin");
  const claudeSkillsDir = join(claudePluginDir, "skills");
  await mkdir(agentsSkillsDir, { recursive: true, mode: 0o700 });
  await mkdir(join(claudePluginDir, ".claude-plugin"), { recursive: true, mode: 0o700 });
  await mkdir(claudeSkillsDir, { recursive: true, mode: 0o700 });
  for (const skill of library.skills) {
    const target = await realpath(skill.path);
    if (dirname(target) !== libraryRoot || basename(target) !== skill.name) throw new Error(`技能 ${skill.name} 的投影目标已越出技能库或身份变化，拒绝注入。`);
    await symlink(target, join(agentsSkillsDir, skill.name));
    await symlink(target, join(claudeSkillsDir, skill.name));
  }
  // Claude 本地插件必须带最小 manifest；即使某些版本可省略，也不依赖未文档化的宽松行为。
  await writeFile(join(claudePluginDir, ".claude-plugin", "plugin.json"), `${JSON.stringify({
    name: "wave-flow-skills",
    description: "Wave Flow 托管技能库的会话级投影；仅本次会话可见。",
    version: "0.1.0",
    author: { name: "Wave Flow" },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const patchFile = join(scratch, "skills.patch.yml");
  await writeFile(patchFile, [
    "# Wave Flow 会话级技能投影：只给 skill-filesystem 追加 customSkillDirs。",
    "- id: skill-filesystem",
    "  config:",
    "    customSkillDirs:",
    `      - ${yamlScalar(agentsSkillsDir)}`,
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return { root, agentsSkillsDir, claudePluginDir, patchFile };
}

/** 最小 YAML 标量转义；输出单引号风格，避免绝对路径中的空格/冒号改变结构。 */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
