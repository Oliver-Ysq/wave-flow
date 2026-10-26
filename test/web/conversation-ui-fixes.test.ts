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

  test("无空格长 token 在消息内换行，不越过气泡或阅读列", async () => {
    const css = await Bun.file("src-tauri/web/src/workbench.css").text();
    // 用户粘贴的 prompt 里有 no_proxy 列表、URL 这类无空格长 token。消息内容列必须用
    // overflow-wrap:anywhere 参与 min-content 计算；只保证 p 内部能断词不够，
    // 气泡仍会被长 token 的 min-content 撑开，越界文字还会被 .conversation-scroll 的
    // overflow-x:hidden 裁掉，用户既看不全也滚不到。
    expect(css).toContain(".agent-workbench .chat-message > div:last-child { min-width:0; overflow-wrap:anywhere; }");
    expect(css).toContain("overflow-x:hidden");
    // 代码块保持原行为：按源码换行、内部横向滚动，不被消息级换行规则拆散。
    expect(css).toContain("white-space:pre; overflow-wrap:normal; word-break:normal;");
  });
});
