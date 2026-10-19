import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoGrowTextarea } from "../../src-tauri/web/src/conversation/auto-grow-textarea";

test("自适应输入保留原生输入和可访问语义，不写入固定估算高度", () => {
  const html = renderToStaticMarkup(<AutoGrowTextarea value={"任务目标\n执行约束"} aria-label="描述任务目标" disabled onChange={() => {}} />);
  expect(html).toContain('aria-label="描述任务目标"');
  expect(html).toContain('disabled=""');
  expect(html).toContain("任务目标\n执行约束");
  expect(html).not.toContain("height:");
});

test("首页和聊天共用实际高度测量，变化与卸载均有处理", async () => {
  const home = await Bun.file("src-tauri/web/src/App.tsx").text();
  const chat = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
  const grow = await Bun.file("src-tauri/web/src/conversation/auto-grow-textarea.tsx").text();
  expect(home).toContain("<AutoGrowTextarea");
  expect(chat).toContain("<AutoGrowTextarea");
  expect(home).not.toContain('text.split("\\n").length - 1');
  expect(chat).not.toContain('draft.split("\\n").length - 1');
  expect(grow).toContain("input.scrollHeight + border");
  expect(grow).toContain('input.style.height = "0px"');
  expect(grow).toContain("observer.observe(conversation)");
  expect(grow).toContain("observer.observe(region)");
  expect(grow).toContain("observer.disconnect()");
  expect(grow).toContain("cancelAnimationFrame(frame)");
  expect(grow).toContain("layout.current?.()");
  expect(grow).not.toContain("const wasAtBottom");
  expect(chat).toContain("onLayout={maintainHistoryLayout}");
  expect(chat).toContain("el.scrollTop = stuckRef.current ? el.scrollHeight : historyTop.current");
  expect(chat).toContain("el.clientHeight !== historySize.current.height");
});

test("输入区先让历史区域缩短，极长输入仍能滚动且返回最新按钮避让", async () => {
  const css = await Bun.file("src-tauri/web/src/workbench.css").text();
  expect(css).toContain("height:100%; min-height:0; overflow:hidden;");
  expect(css).toContain("max-height:none; overflow-y:hidden;");
  expect(css).toContain("bottom:var(--wf-composer-offset,128px)");
});
