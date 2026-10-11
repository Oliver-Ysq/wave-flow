import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";

async function start(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const isDesktopBootstrap = "__TAURI_INTERNALS__" in window && query.get("desktop") !== "1";
  if (isDesktopBootstrap) {
    const connection = await invoke<{ baseUrl: string }>("ensure_daemon");
    window.location.replace(`${connection.baseUrl}/?desktop=1`);
    return;
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start().catch((error) => {
  createRoot(document.getElementById("root")!).render(
    <main style={{ padding: "32px", fontFamily: "system-ui" }}><h1>Wave Flow Desktop 无法连接 daemon</h1><pre>{error instanceof Error ? error.message : String(error)}</pre></main>,
  );
});
