import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import "./styles.css";
import "./workbench.css";

async function start(): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) await invoke("ensure_engine");
  renderWorkbench();
}

/** WebView 中任何 React 渲染错误都必须保留可恢复页面，不能退化为原生黑屏。 */
class WorkbenchErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* 错误已被可恢复 UI 接住；不向 Engine/Journals 写浏览器异常。 */ }
  render() {
    if (this.state.error) return <RecoveryScreen detail={this.state.error} />;
    return this.props.children;
  }
}

function renderWorkbench(): void {
  render(<StrictMode><WorkbenchErrorBoundary><App /></WorkbenchErrorBoundary></StrictMode>);
}

/** 整个 WebView 只创建一个 React root；恢复页与正常工作台在同一 root 内切换。 */
const reactRoot = createRoot(document.getElementById("root")!);
function render(node: ReactNode): void { reactRoot.render(node); }

/**
 * 原生窗口以 `visible: false` 创建，App 首次快照提交后才显示：WKWebView 尚未
 * 绘制或状态仍是“未连接”时露出的第一帧会让用户看到一次跳变。双 rAF 等一帧
 * 布局，定时器兜底隐藏窗口下 rAF 被节流的情况；Rust 侧另有 2.5 秒兜底。
 */
let revealSent = false;
function revealFirstFrame(): void {
  if (revealSent || !("__TAURI_INTERNALS__" in window)) return;
  revealSent = true;
  const reveal = () => { void invoke("reveal_main_window").catch(() => {}); };
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  setTimeout(reveal, 120);
}
window.addEventListener("wave-flow:first-frame", () => revealFirstFrame());
// Engine 启动或快照请求悬挂时也要让占位/错误页可见，不能永久隐藏窗口。
setTimeout(() => revealFirstFrame(), 1800);

/** 脚本回调中的未捕获错误同样显示恢复入口，而不是让根节点保持空白。 */
function installGlobalRecovery(): void {
  const recover = (reason: unknown) => { render(<RecoveryScreen detail={reason instanceof Error ? reason.message : String(reason)} />); revealFirstFrame(); };
  window.addEventListener("error", event => { event.preventDefault(); recover(event.error ?? event.message); });
  window.addEventListener("unhandledrejection", event => { event.preventDefault(); recover(event.reason); });
}

function RecoveryScreen({ detail }: { readonly detail: string }) {
  return <main className="recovery-screen"><section><span>工作台需要恢复</span><h1>页面渲染已中断</h1><p>Desktop Execution Engine 和会话没有被停止。重新加载只会重新连接当前桌面执行环境，不会重跑 Workflow 或丢弃草案。</p><details><summary>查看诊断信息</summary><pre>{detail}</pre></details><footer><button onClick={() => window.location.reload()}>重新加载工作台</button></footer></section></main>;
}

installGlobalRecovery();
void start().catch((error) => {
  render(
    <main style={{ padding: "32px", fontFamily: "system-ui" }}><h1>Wave Flow Desktop 无法启动执行环境</h1><pre>{error instanceof Error ? error.message : String(error)}</pre></main>,
  );
  revealFirstFrame();
});
