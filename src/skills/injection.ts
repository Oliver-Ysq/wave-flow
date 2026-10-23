import type { SkillInjectionCapability } from "./types";

/**
 * Codex：ACP session/new 的 `additionalDirectories` 被 codex-acp 映射为
 * `<root>/.agents/skills` 并写入 app-server 的额外 skill 根。
 *
 * 副作用：该目录同时进入 Codex sandbox 的 workspace write roots，因此投影目录必须
 * 只位于 Wave Flow 会话 scratch，不能指向用户目录。
 */
export const codexSkillInjection: SkillInjectionCapability = {
  verified: true,
  evidence: "available-commands",
  mechanism: "codex-extra-roots",
  apply: ({ launcher, projection }) => ({
    launcher,
    session: { additionalDirectories: [projection.root] },
  }),
  advertisedMatch: (skillName, advertisedName) => advertisedName.trim().replace(/^\$/, "") === skillName,
};

/**
 * Claude：ACP session/new 的 `_meta.claudeCode.options.plugins` 由 claude-agent-acp
 * 透传给 Claude Agent SDK；SDK 默认以 `--plugin-dir` 传给 Claude，仅本会话生效。
 */
export const claudeSkillInjection: SkillInjectionCapability = {
  verified: true,
  evidence: "available-commands",
  mechanism: "claude-plugin-dir",
  apply: ({ launcher, projection }) => ({
    launcher,
    session: {
      meta: {
        claudeCode: {
          options: {
            plugins: [{ type: "local", path: projection.claudePluginDir }],
          },
        },
      },
    },
  }),
  // 插件技能可能带 plugin 前缀（如 `wave-flow-skills:lark-base`）；同时接受裸名。
  advertisedMatch: (skillName, advertisedName) => {
    const normalized = advertisedName.trim().replace(/^\//, "");
    return normalized === skillName || normalized.endsWith(`:${skillName}`);
  },
};

/**
 * DSH：launcher 追加 `--patch <file>`，覆盖 `skill-filesystem` 行的
 * `customSkillDirs`。投影排 user 根之前，叠加原生 project 根与 includeDefaultRoots。
 */
export const dshSkillInjection: SkillInjectionCapability = {
  verified: true,
  evidence: "filesystem",
  mechanism: "dsh-patch",
  apply: ({ launcher, projection }) => ({
    launcher: { ...launcher, args: [...launcher.args, "--patch", projection.patchFile] },
  }),
  advertisedMatch: (skillName, advertisedName) => advertisedName.trim().replace(/^\//, "") === skillName,
};
