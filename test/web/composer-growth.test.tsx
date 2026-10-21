import { expect, test } from "bun:test";

test("首页和聊天共用 mention 输入，保留最长高度与历史滚动测量", async () => {
  const home = await Bun.file("src-tauri/web/src/App.tsx").text();
  const chat = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  const composer = await Bun.file("src-tauri/web/src/conversation/mention-composer.tsx").text();
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(home).toContain("<MentionComposer");
  expect(chat).toContain("<MentionComposer");
  expect(chat).toContain("onLayout={maintainHistoryLayout}");
  expect(composer).toContain("input.scrollHeight");
  expect(composer).toContain("Math.min(input.scrollHeight, 220)");
  expect(css).toContain(".composer-mentions__input");
  expect(css).toContain("max-height:220px");
});

test("输入区仍让历史区域缩短，极长输入可滚动且返回最新按钮避让", async () => {
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain("height:100%; min-height:0; overflow:hidden;");
  expect(css).toContain("max-height:none; overflow-y:hidden;");
  expect(css).toContain("bottom:var(--wf-composer-offset,128px)");
});
