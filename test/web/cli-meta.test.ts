import { expect, test } from "bun:test";
import { CLI_KINDS, cliDisplayName, cliIcon } from "../../src-tauri/web/src/cli-meta";

test("每个 CLI 种类的显示名与图标字母来自查表，新增种类不回退成错名字", () => {
  expect(cliDisplayName("codex")).toBe("Codex CLI");
  expect(cliDisplayName("kimi")).toBe("Kimi CLI");
  expect(cliDisplayName("claude")).toBe("Claude Code");
  expect(cliDisplayName("dsh")).toBe("DeepSeek Harness");
  expect(cliIcon("codex")).toBe("C");
  expect(cliIcon("kimi")).toBe("K");
  expect(cliIcon("claude")).toBe("A");
  expect(cliIcon("dsh")).toBe("D");
  expect(CLI_KINDS).toEqual(["codex", "claude", "dsh"]);
});

test("展示位一律查表，不再用 codex/kimi 三元决定显示名或图标", async () => {
  for (const path of [
    "src-tauri/web/src/App.tsx",
    "src-tauri/web/src/workflow-design.tsx",
    "src-tauri/web/src/execution/team-panel.tsx",
  ]) {
    const source = await Bun.file(path).text();
    expect(source).not.toContain('"codex" ? "Codex CLI"');
    expect(source).not.toContain('"codex" ? "C" : "K"');
  }
  const app = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(app).toContain("cliDisplayName(runtime.cli)");
  expect(app).toContain("cliIcon(runtime.cli)");
});

test("手动添加下拉覆盖当前可选种类，路径猜测识别 claude/dsh 关键字", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain("CLI_KINDS.map((kind) => (");
  expect(source).toContain('if (base.includes("claude")) setManualCli("claude");');
  expect(source).toContain('else if (base.includes("dsh")) setManualCli("dsh");');
  expect(source).toContain('manualCli === "claude"');
  expect(source).toContain('manualCli === "dsh"');
});
