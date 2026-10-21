import { expect, test } from "bun:test";
import { buildComposerSlashCommands } from "../../src-tauri/web/src/conversation/composer-commands";
import { engineTextFromMentions } from "../../src-tauri/web/src/conversation/mention-composer";

test("斜杠菜单合并 /wave-flow 与 ACP 命令，隐藏 compact 并保留技能原始 token", () => {
  const commands = buildComposerSlashCommands([
    { name: "compact", description: "压缩上下文", inputHint: null },
    { name: "autocompact", description: "自动压缩", inputHint: null },
    { name: "$brainstorming", description: "头脑风暴", inputHint: null },
    { name: "status", description: "查看状态", inputHint: "[detail]" },
  ]);
  // Codex 风格同时广告 `$` 技能与内置命令时，只保留技能和 /wave-flow。
  expect(commands.map((command) => command.token)).toEqual([
    "/wave-flow",
    "$brainstorming",
  ]);
  expect(commands.find((command) => command.token === "$brainstorming")?.group).toBe("skills");
  expect(commands.find((command) => command.token === "/wave-flow")?.group).toBe("wave-flow");
});


test("两个输入入口都使用 mention composer，命令由 react-mentions 维护为整块 mention", async () => {
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  const chat = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  const composer = await Bun.file("src-tauri/web/src/conversation/mention-composer.tsx").text();
  for (const source of [app, chat]) {
    expect(source).toContain("<MentionComposer");
    expect(source).not.toContain("useComposerSlashCommands");
    expect(source).not.toContain("<SlashCommandMenu");
  }
  expect(composer).toContain("MentionsInput");
  expect(composer).toContain("trigger=\"/\"");
  expect(composer).toContain("appendSpaceOnAdd");
  expect(app).toContain("commands_changed");
});

test("mention 显示文本去掉斜杠，但发送文本还原完整命令 token", () => {
  const plain = "wave-flow\u00A0\u00A0你好 $brainstorming\u00A0\u00A0";
  const mentions = [
    { id: "/wave-flow", display: "wave-flow\u00A0\u00A0", childIndex: 0, index: 0, plainTextIndex: 0 },
    { id: "$brainstorming", display: "$brainstorming\u00A0\u00A0", childIndex: 0, index: 0, plainTextIndex: 14 },
  ];
  expect(engineTextFromMentions(plain, mentions)).toBe("/wave-flow\u00A0\u00A0你好 $brainstorming\u00A0\u00A0");
});
