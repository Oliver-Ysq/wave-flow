import { Component, StrictMode, useState, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import "./styles.css";
import "./workbench.css";

async function start(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const isDesktopBootstrap = "__TAURI_INTERNALS__" in window && query.get("desktop") !== "1";
  if (isDesktopBootstrap) {
    let connection: { baseUrl: string };
    try { connection = await invoke<{ baseUrl: string }>("ensure_daemon"); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // bridge 的 protocol 或 Web 构建版本不匹配都必须走升级确认，绝不能先加载
      // 旧 daemon 的 `/`；改动诊断文案时同步检查这条跨进程字符串契约。
      if (message.includes("协议版本") || message.includes("Web 构建版本")) { render(<DaemonUpgradeScreen message={message} />); return; }
      throw error;
    }
    window.location.replace(`${connection.baseUrl}/?desktop=1`);
    return;
  }
  renderWorkbench();
}

/** WebView 中任何 React 渲染错误都必须保留可恢复页面，不能退化为原生黑屏。 */
class WorkbenchErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* 错误已被可恢复 UI 接住；不向 daemon/Journals 写浏览器异常。 */ }
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

/** 脚本回调中的未捕获错误同样显示恢复入口，而不是让根节点保持空白。 */
function installGlobalRecovery(): void {
  const recover = (reason: unknown) => render(<RecoveryScreen detail={reason instanceof Error ? reason.message : String(reason)} />);
  window.addEventListener("error", event => { event.preventDefault(); recover(event.error ?? event.message); });
  window.addEventListener("unhandledrejection", event => { event.preventDefault(); recover(event.reason); });
}

function RecoveryScreen({ detail }: { readonly detail: string }) {
  return <main className="daemon-upgrade-screen"><section><span>工作台需要恢复</span><h1>页面渲染已中断</h1><p>后台服务和会话没有被停止。重新加载只会重新连接当前 loopback daemon，不会重跑 Workflow 或丢弃草案。</p><details><summary>查看诊断信息</summary><pre>{detail}</pre></details><footer><button onClick={() => window.location.reload()}>重新加载工作台</button></footer></section></main>;
}

function DaemonUpgradeScreen({ message }: { message: string }) {
  const [confirming, setConfirming] = useState(false);
  const restart = async () => {
    const connection = await invoke<{ baseUrl: string }>("restart_daemon");
    window.location.replace(`${connection.baseUrl}/?desktop=1`);
  };
  return <main className="daemon-upgrade-screen"><section><span>后台服务需要更新</span><h1>重启后即可继续使用</h1><p>Wave Flow 已更新，后台服务仍在使用旧版本。重启不会重复创建任务；已完成的历史任务仍可查看。</p><p>正在执行的任务会明确标记为已中断，稍后由你在工作台决定是否显式恢复；Wave Flow 不会自动重跑。</p><details><summary>查看调试信息</summary><pre>{message}</pre></details><footer><button onClick={() => setConfirming(true)}>重启服务</button></footer>{confirming && <div className="daemon-confirm"><section role="dialog" aria-modal="true" aria-label="确认重启服务"><span>确认操作</span><h2>现在重启服务？</h2><p>已打开的工作台会短暂重新连接。正在进行的任务不会重复执行，而是收敛为已中断状态，等待你显式恢复。</p><div><button className="secondary" onClick={() => setConfirming(false)}>暂不重启</button><button onClick={() => void restart()}>现在重启</button></div></section></div>}</section></main>;
}

installGlobalRecovery();
void start().catch((error) => {
  render(
    <main style={{ padding: "32px", fontFamily: "system-ui" }}><h1>Wave Flow Desktop 无法连接 daemon</h1><pre>{error instanceof Error ? error.message : String(error)}</pre></main>,
  );
});
