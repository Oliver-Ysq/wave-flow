import type { HarnessAvailableCommand } from "../types";

/** 主控输入框斜杠菜单中的一条命令；token 是最终进入纯文本消息的精确文本。 */
export type ComposerSlashCommand = {
  /** 菜单稳定身份；静态命令与 ACP 命令不冲突。 */
  readonly key: string;
  /** 插入消息的 token；Codex 技能保持 `$name`，其他 ACP 命令使用 `/name`。 */
  readonly token: string;
  /** 菜单主标签。 */
  readonly label: string;
  /** 一行说明。 */
  readonly description: string;
  /** 菜单分组：Wave Flow 命令、技能、其他 ACP 命令。 */
  readonly group: "wave-flow" | "skills" | "commands";
  /** 参数提示；有值时插入后补一个空格供继续输入。 */
  readonly inputHint: string | null;
};

/** 显式要求主控生成 Workflow 的静态命令；不依赖任何 CLI 广告。 */
const WAVE_FLOW_COMMAND: ComposerSlashCommand = {
  key: "wave-flow",
  token: "/wave-flow",
  label: "/wave-flow",
  description: "设计由 Worker 执行的 Workflow；点名的技能默认给 Worker",
  group: "wave-flow",
  inputHint: "目标与 Worker 技能",
};

/** 不进入菜单的 ACP 命令：不提供上下文压缩。 */
const HIDDEN_ACP_COMMANDS = new Set(["compact", "autocompact"]);

/**
 * 合并 Wave Flow 静态命令与当前 ACP 会话广告的命令。
 * 只展示 ACP 实际提供的内容；Codex 技能以 `$` 开头，其他 CLI 的命令按 `/name` 发送。
 */
export function mergeManagedSkillCommands(
  available: readonly HarnessAvailableCommand[],
  skills: readonly { readonly name: string; readonly description: string }[],
  cli: "codex" | "claude" | "dsh",
): readonly HarnessAvailableCommand[] {
  const merged: HarnessAvailableCommand[] = available.map(command => ({ ...command }));
  const normalized = (name: string) => name.trim().replace(/^\$/, "").replace(/^\//, "");
  for (const skill of skills) {
    const index = merged.findIndex(command => {
      const name = normalized(command.name);
      return name === skill.name || name.endsWith(`:${skill.name}`) || name.endsWith(`__${skill.name}`);
    });
    if (index >= 0) { merged[index] = { ...merged[index]!, groupHint: "skills" }; continue; }
    const token = cli === "codex" ? `$${skill.name}` : skill.name;
    merged.push({ name: token, description: skill.description, inputHint: null, groupHint: "skills" });
  }
  return merged;
}

export function buildComposerSlashCommands(
  available: readonly HarnessAvailableCommand[],
): readonly ComposerSlashCommand[] {
  const seen = new Set([WAVE_FLOW_COMMAND.token]);
  // Codex 同时广告内置命令与 `$` 技能；菜单只保留技能，避免把 /plan、/status 等
  // 非技能入口混入主控输入。Claude 等没有 `$` 标记的 CLI 无法区分，保留全部非 compact 命令。
  const hasDollarSkills = available.some((item) => item.name.trim().startsWith("$"));
  const commands: ComposerSlashCommand[] = [WAVE_FLOW_COMMAND];
  for (const item of available) {
    const name = item.name.trim();
    if (!name || HIDDEN_ACP_COMMANDS.has(name)) continue;
    const isSkill = name.startsWith("$") || item.groupHint === "skills";
    if (hasDollarSkills && !isSkill) continue;
    // ACP 不同 CLI 可能广告 `/name` 或裸 `name`；避免已带斜杠时生成 `//name`。
    const token = name.startsWith("$") ? name : name.startsWith("/") ? name : `/${name}`;
    if (seen.has(token)) continue;
    seen.add(token);
    commands.push({
      key: `acp:${name}`,
      token,
      label: token,
      description: item.description.trim(),
      group: isSkill ? "skills" : "commands",
      inputHint: item.inputHint?.trim() || null,
    });
  }
  const groupOrder = { "wave-flow": 0, skills: 1, commands: 2 } as const;
  return commands.sort((a, b) => groupOrder[a.group] - groupOrder[b.group]);
}
