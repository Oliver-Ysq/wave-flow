import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { App } from "./App";
import "./styles.css";
import "./workbench.css";
import "@xterm/xterm/css/xterm.css";

async function start(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const isDesktopBootstrap = "__TAURI_INTERNALS__" in window && query.get("desktop") !== "1";
  if (isDesktopBootstrap) {
    let connection: { baseUrl: string };
    try { connection = await invoke<{ baseUrl: string }>("ensure_daemon"); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("协议版本")) { createRoot(document.getElementById("root")!).render(<DaemonUpgradeScreen message={message} />); return; }
      throw error;
    }
    window.location.replace(`${connection.baseUrl}/?desktop=1`);
    return;
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

function DaemonUpgradeScreen({ message }: { message: string }) {
  const [confirming, setConfirming] = useState(false);
  const restart = async () => {
    const connection = await invoke<{ baseUrl: string }>("restart_daemon");
    window.location.replace(`${connection.baseUrl}/?desktop=1`);
  };
  return <main className="daemon-upgrade-screen"><section><span>后台服务需要更新</span><h1>重启后即可继续使用</h1><p>Wave Flow 已更新，后台服务仍在使用旧版本。重启不会重复创建任务；能继续查看的任务会自动重新连接。</p><p>少数正在执行的任务可能需要你稍后在工作台点击“继续”。</p><details><summary>查看调试信息</summary><pre>{message}</pre></details><footer><button onClick={() => setConfirming(true)}>重启服务</button></footer>{confirming && <div className="daemon-confirm"><section role="dialog" aria-modal="true" aria-label="确认重启服务"><span>确认操作</span><h2>现在重启服务？</h2><p>已打开的工作台会短暂重新连接。正在进行的任务不会重复执行；完成重启后，Wave Flow 会尽力恢复任务现场。</p><div><button className="secondary" onClick={() => setConfirming(false)}>暂不重启</button><button onClick={() => void restart()}>现在重启</button></div></section></div>}</section></main>;
}

void start().catch((error) => {
  createRoot(document.getElementById("root")!).render(
    <main style={{ padding: "32px", fontFamily: "system-ui" }}><h1>Wave Flow Desktop 无法连接 daemon</h1><pre>{error instanceof Error ? error.message : String(error)}</pre></main>,
  );
});
