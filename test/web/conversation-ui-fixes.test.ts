import { describe, expect, test } from "bun:test";

describe("对话等待与工具输出布局", () => {
  test("等待提示在工具进展期间保持可见，只在正文流式或回合结束时收起", async () => {
    const source = await Bun.file("src-tauri/web/src/conversation/conversation-view.tsx").text();
    expect(source).toContain("const [waitingVisible, setWaitingVisible] = useState(false)");
    expect(source).toContain("if (!running || streamingBody) { setWaitingVisible(false); return; }");
    expect(source).toContain("waitingVisible && (");
    expect(source).toContain('className="wf-waiting"');
  });

  test("命令详情限制在卡片内，长命令自身横向滚动而不是撑破边框", async () => {
    const css = await Bun.file("src-tauri/web/src/workbench.css").text();
    expect(css).toContain(".wf-entry-detail { max-width:100%; overflow:hidden;");
    expect(css).toContain(".wf-command-line { display:flex; align-items:center; gap:10px; min-width:0; max-width:100%;");
    expect(css).toContain(".wf-command-line code { min-width:0; max-width:100%;");
  });
});
