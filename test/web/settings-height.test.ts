import { expect, test } from "bun:test";

test("设置高度随窗口比例变化，最低640px且不超过可用窗口，内容独立滚动", async () => {
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  const panel = css.match(/\.agent-workbench \.settings-panel \{([^}]+)\}/)?.[1] ?? "";
  expect(panel).toContain("height:max(640px, 80dvh)");
  expect(panel).toContain("max-height:calc(100dvh - var(--settings-window-gap))");
  expect(panel).toContain("--settings-window-gap:56px");
  expect(panel).toContain("overflow:hidden");
  expect(panel).not.toContain("min-height:640px");
  expect(css).toContain(".settings-panel > .connection-panel-head { flex-shrink:0; }");
  expect(css).toContain(".settings-content { min-height:0; overflow-y:auto; scrollbar-gutter:stable;");
  expect(css).toContain("@media(max-width:640px){\n  .agent-workbench .settings-panel { --settings-window-gap:28px; }");
});
