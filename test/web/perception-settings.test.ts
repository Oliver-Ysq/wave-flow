import { expect, test } from "bun:test";

test("Web 通过 Engine settings action 读写应用设置，且不引入 Engine 运行时依赖", async () => {
  const source = await Bun.file("src-tauri/web/src/api.ts").text();
  expect(source).toContain(
    'import type { AppSettings } from "../../../src/desktop/app-settings"',
  );
  expect(source).toContain('settings: () => action<AppSettings>("settings.get")');
  expect(source).toContain(
    'updateSettings: (patch: { perceptionMode?: boolean }) => action<AppSettings>("settings.update", patch)',
  );
  // 只允许 import type；值导入会把 Engine 的 node:fs 模块带进 Web 打包。
  expect(source).not.toContain("import { AppSettings }");
  expect(source).not.toContain("AppSettingsStore");
});

test("通用设置主题下方提供感知模式开关，说明默认值、权限边界与生效时机", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain("<strong>感知模式</strong>");
  expect(source).toContain("perceptionMode");
  expect(source).toContain("api.settings()");
  expect(source).toContain("api.updateSettings({ perceptionMode: enabled })");
  for (const phrase of [
    "默认开启",
    "主控可使用本机 skill/MCP/CLI 读取信息",
    "项目文件仍不可写",
    "修改项目必须走 Workflow",
    "设置对新建或空闲重开的主控会话生效",
  ]) {
    expect(source).toContain(phrase);
  }
  const general = source.slice(
    source.indexOf('{section === "general" && ('),
    source.indexOf('{section === "cli" && '),
  );
  expect(general.indexOf("外观主题")).toBeGreaterThanOrEqual(0);
  expect(general.indexOf("外观主题")).toBeLessThan(
    general.indexOf("感知模式"),
  );
});

test("感知模式读取或更新失败就地提示，读取期间禁用开关且不影响其他设置", async () => {
  const source = await Bun.file("src-tauri/web/src/App.tsx").text();
  expect(source).toContain("读取感知模式失败：");
  expect(source).toContain("更新感知模式失败：");
  expect(source).toContain(
    '<div className="manual-runtime-error" role="alert">',
  );
  expect(source).toContain("disabled={perceptionBusy !== null}");
  expect(source).toContain('setPerceptionBusy("load")');
  expect(source).toContain('setPerceptionBusy("save")');
  // 开关只调用设置 action，不触发扫描、运行或 Workflow 变更。
  const toggle = source.slice(
    source.indexOf("async function togglePerceptionMode"),
    source.indexOf("async function scan()"),
  );
  expect(toggle).not.toContain("onRuntimeState");
  expect(toggle).not.toContain("api.cliRuntimes");
});

test("感知模式只新增最小设置样式，复用设置分区与错误块", async () => {
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain(".agent-workbench .settings-perception");
  expect(css).toContain(".agent-workbench .settings-toggle");
  expect(css).toContain(
    ".agent-workbench .settings-toggle:has(input:disabled)",
  );
  expect(css).toContain(
    ".agent-workbench .settings-perception + .manual-runtime-error",
  );
});
