import { expect, test } from "bun:test";

test("设置为独立视图：铺满窗口，内容独立滚动", async () => {
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  const panel = css.match(/\.agent-workbench \.settings-panel \{([^}]+)\}/)?.[1] ?? "";
  expect(panel).toContain("width:100%");
  expect(panel).toContain("height:100dvh");
  expect(panel).toContain("max-height:none");
  expect(panel).toContain("border-radius:0");
  expect(panel).toContain("overflow:hidden");
  expect(css).toContain(".settings-backdrop { padding:0; place-items:stretch;");
  expect(css).toContain(".settings-panel > .connection-panel-head { flex-shrink:0;");
  expect(css).toContain(".settings-content { min-height:0; overflow-y:auto; scrollbar-gutter:stable;");
});
