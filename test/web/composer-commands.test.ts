import { describe, expect, test } from "bun:test";
import { buildComposerSlashCommands, mergeManagedSkillCommands } from "../../src-tauri/web/src/conversation/composer-commands";

const managed = [{ name: "imported-skill", description: "托管技能说明" }];

describe("斜线菜单合并托管技能", () => {
  test("Codex 使用 $ 前缀，原生与托管技能同组", () => {
    const available = mergeManagedSkillCommands([{ name: "$native", description: "原生", inputHint: null }], managed, "codex");
    const commands = buildComposerSlashCommands(available);
    expect(commands.map(command => [command.token, command.group])).toEqual([
      ["/wave-flow", "wave-flow"],
      ["$native", "skills"],
      ["$imported-skill", "skills"],
    ]);
    expect(commands[0]?.description).toContain("默认给 Worker");
  });

  test("已带斜杠的 ACP 技能不会被重复加斜杠", () => {
    const commands = buildComposerSlashCommands([
      { name: "/managed-skill", description: "技能", inputHint: null, groupHint: "skills" },
      { name: "plain-command", description: "命令", inputHint: null },
    ]);
    expect(commands.map((item) => item.token)).toEqual(["/wave-flow", "/managed-skill", "/plain-command"]);
  });

  test("Claude 使用 / 前缀；已广告的同名命令被标记为技能", () => {
    const available = mergeManagedSkillCommands([
      { name: "status", description: "普通命令", inputHint: null },
      { name: "imported-skill", description: "CLI 广告", inputHint: null },
    ], managed, "claude");
    const commands = buildComposerSlashCommands(available);
    expect(commands.find(command => command.token === "/imported-skill")?.group).toBe("skills");
    expect(commands.find(command => command.token === "/status")?.group).toBe("commands");
  });

  test("DSH 也提供 / 前缀的托管技能入口", () => {
    const commands = buildComposerSlashCommands(mergeManagedSkillCommands([], managed, "dsh"));
    expect(commands).toContainEqual(expect.objectContaining({ token: "/imported-skill", group: "skills", description: "托管技能说明" }));
  });
});
