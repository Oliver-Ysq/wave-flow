import { expect, test } from "bun:test";

test("首页和聊天共用 mention 输入，高度跟随内容但有上限", async () => {
  const home = await Bun.file("src-tauri/web/src/App.tsx").text();
  const chat = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  const composer = await Bun.file("src-tauri/web/src/conversation/mention-composer.tsx").text();
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(home).toContain("<MentionComposer");
  expect(chat).toContain("<MentionComposer");
  expect(chat).toContain("onLayout={maintainHistoryLayout}");
  expect(composer).toContain("input.scrollHeight");
  // 高度上限只在 CSS 一处决定；JS 再写死一个数字会和限高打架，超出部分直接不可见。
  expect(composer).not.toContain("Math.min(input.scrollHeight, 220)");
  expect(css).toContain(".composer-mentions__control");
  expect(css).toContain("max-height:clamp(160px,34vh,320px)");
});

test("滚动发生在 control 层，回弹时 mention 不会与正文错行", async () => {
  const composer = await Bun.file("src-tauri/web/src/conversation/mention-composer.tsx").text();
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain("height:100%; min-height:0; overflow:hidden;");
  // 高亮层是覆盖层：react-mentions 内联了 position:relative，必须用 !important 拉出文档流，
  // 否则它会按完整文本高度撑大输入区，把发送按钮和草稿页标题顶出视口。
  expect(css).toContain("position:absolute !important");
  // textarea 自己永不滚动；滚动容器是 control，图层与文本一起位移，橡皮筋回弹不会让两层错位。
  expect(css).toContain("overflow-y:hidden !important");
  expect(css).toContain("overflow-y:auto; overflow-x:hidden; overscroll-behavior:none");
  // 覆盖层的宽高必须由 JS 跟随 textarea，否则换行与 mention 位置对不上。
  expect(composer).toContain("highlighter.style.width");
  expect(composer).toContain("highlighter.style.height");
  expect(css).toContain("bottom:var(--wf-composer-offset,128px)");
});
