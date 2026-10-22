import { describe, expect, test } from "bun:test";
import { access, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 源码断言忽略空白：格式化工具不应让语义相同的实现断言失败。 */
const compact = (text: string) => text.replace(/\s+/g, "");

/** 架构规定的职责目录；目录是后续实现的唯一落点，而非能力已经可用的声明。 */
const requiredDirectories = [
  "src/workflow",
  "src/runtime",
  "src/adapters",
  "src/control",
  "src/journal",
  "src/desktop",
  "src-tauri",
  "src/shared",
] as const;

describe("新架构目录与历史实现边界", () => {
  test("关窗只隐藏，托盘打开复用原窗口而不创建第二Engine", async () => {
    const desktop = await Bun.file(join(projectRoot, "src-tauri/src/main.rs")).text();
    const show = desktop.slice(desktop.indexOf("fn show_main_window("), desktop.indexOf("fn main()"));
    expect(show).toContain('get_webview_window("main")');
    expect(show).toContain("window.show()?");
    expect(show).toContain("window.set_focus()?");
    expect(show).not.toContain("ensure_engine");
    const onWindowEvent = desktop.indexOf(".on_window_event");
    const tray = desktop.slice(desktop.indexOf('TrayIconBuilder::with_id("wave-flow-tray")'), onWindowEvent);
    expect(compact(tray)).toContain(compact('"open" => { let _ = show_main_window(app); }'));
    const close = desktop.slice(onWindowEvent, desktop.indexOf(".invoke_handler"));
    expect(close).toContain("api.prevent_close()");
    expect(close).toContain("window.hide()");
    expect(close).not.toContain("shutdown_engine");
  });
  test("为每个职责提供唯一且可追踪的目录落点", async () => {
    await Promise.all(requiredDirectories.map(async (directory) => {
      const path = join(projectRoot, directory);
      const entry = await stat(path);
      expect(entry.isDirectory()).toBe(true);
      await expect(access(join(path, "README.md")).catch(() => access(join(path, ".gitkeep")))).resolves.toBeDefined();
    }));
  });

  test("源码树不再包含一次性 exec Runtime、Fake Adapter 或旧事件层", async () => {
    const sourceEntries = await readdir(join(projectRoot, "src"));
    expect(sourceEntries).not.toContain("events");

    await expect(access(join(projectRoot, "src/adapters/codex-cli"))).rejects.toThrow();
    await expect(access(join(projectRoot, "src/adapters/testing"))).rejects.toThrow();
    await expect(access(join(projectRoot, "src/runtime/runner.ts"))).rejects.toThrow();
    await expect(access(join(projectRoot, "src/cli"))).rejects.toThrow();
  });

  test("桌面端通过私有 Engine 管道而非全局 Engine 控制任务", async () => {
    const cargo = await Bun.file(join(projectRoot, "src-tauri", "Cargo.toml")).text();
    const tauriConfig = await Bun.file(join(projectRoot, "src-tauri", "tauri.conf.json")).text();
    const desktop = await Bun.file(join(projectRoot, "src-tauri", "src", "main.rs")).text();
    const engine = await Bun.file(join(projectRoot, "src", "desktop", "engine-main.ts")).text();
    const dispatch = await Bun.file(join(projectRoot, "src", "desktop", "engine-dispatch.ts")).text();
    expect(cargo).toContain('name = "wave-flow-desktop"');
    expect(JSON.parse(tauriConfig).bundle.externalBin).toEqual(["binaries/wave-flow-desktop-engine"]);
    expect(JSON.parse(tauriConfig).identifier).toBe("com.wave-flow.desktop");
    expect(desktop).toContain('sidecar("wave-flow-desktop-engine")');
    expect(desktop).toContain("generation.fetch_add(1, Ordering::AcqRel)");
    expect(compact(desktop)).toContain(compact("generation.load(Ordering::Acquire) != generation"));
    expect(desktop).toContain('.set_process_group(true)');
    expect(desktop).toContain('engine_write');
    expect(desktop).toContain('exit_desktop');
    // 协议配对/超时在 Web；Rust 只保留退出握手。
    expect(desktop).toContain("shutdown_ack");
    expect(compact(desktop)).toContain(compact("tokio::time::timeout(std::time::Duration::from_secs(3), receiver)"));
    expect(desktop).toContain('RunEvent::ExitRequested');
    expect(desktop).toContain('api.prevent_exit()');
    expect(desktop).toContain('app.set_menu');
    expect(compact(desktop)).toContain(compact('Submenu::with_items(app, "Wave Flow"'));
    expect(desktop).not.toContain('ensure_daemon');
    expect(desktop).not.toContain('restart_daemon');
    expect(desktop).toContain('"WAVE_FLOW_HOME"');
    const desktopEntry = await Bun.file(join(projectRoot, "src-tauri", "web", "src", "main.tsx")).text();
    expect(desktopEntry).toContain('invoke("ensure_engine")');
    expect(desktopEntry).not.toContain("ensure_daemon");
    expect(desktopEntry).not.toContain("restart_daemon");
    expect(desktopEntry).toContain("WorkbenchErrorBoundary");
    expect(desktopEntry).toContain("重新加载工作台");
    expect(engine).toContain("serveEngineRequests");
    expect(dispatch).toContain('method: "engine.status"');
    expect(dispatch).toContain('"engine.shutdown"');
    expect(dispatch).toContain('engine.action');
    expect(dispatch).not.toContain(`engine.${"http"}`);
    expect(dispatch).not.toContain("Bun.serve");
    expect(dispatch).not.toContain("Request(`http");
    expect(dispatch).not.toContain(`engine.${"http"}`);
    const webApi = await Bun.file(join(projectRoot, "src-tauri", "web", "src", "api.ts")).text();
    expect(webApi).toContain('action<T>');
    expect(webApi).not.toContain("fetch(");
    expect(webApi).not.toContain("httpMethod");
    await expect(access(join(projectRoot, "src-tauri", "web", "mock-api.ts"))).rejects.toThrow();
    const workbench = await Bun.file(join(projectRoot, "src-tauri", "web", "src", "App.tsx")).text();
    expect(workbench).not.toContain("EventSource(");
    expect(workbench).not.toContain("/harness-runs/");
    const workerMcp = await Bun.file(join(projectRoot, "src", "runtime", "worker-mcp-server.ts")).text();
    expect(workerMcp).not.toContain("WF_WORKER_MCP_BASE_URL");
    expect(workerMcp).toContain("WF_WORKER_MCP_REQUEST_FIFO");
    const workerPipe = await Bun.file(join(projectRoot, "src", "runtime", "worker-control-pipe.ts")).text();
    expect(workerPipe).toContain('"/usr/bin/mkfifo"');
    const harnessMcp = await Bun.file(join(projectRoot, "src", "harness", "mcp-server.ts")).text();
    expect(harnessMcp).not.toContain("WF_HARNESS_MCP_BASE_URL");
    expect(harnessMcp).toContain("WF_HARNESS_MCP_REQUEST_FIFO");
    const acpSession = await Bun.file(join(projectRoot, "src", "adapters", "acp-session.ts")).text();
    expect(acpSession).toContain("detached: true");
    expect(acpSession).toContain('signalGroup("SIGTERM")');
    expect(acpSession).toContain('signalGroup("SIGKILL")');
    expect(acpSession).toContain('process.once("exit", onParentExit)');
    expect(desktop).not.toContain("RunJournal");
    expect(desktop).not.toContain("shell:allow-execute");
    const capability = await Bun.file(join(projectRoot, "src-tauri", "capabilities", "default.json")).text();
    expect(capability).not.toContain('"core:event:default"');
    expect(desktop).toContain("take_menu_action");
    expect(workbench).toContain('invoke<string | null>("take_menu_action")');
    expect(workbench).toContain('invoke("exit_desktop")');
    await expect(access(join(projectRoot, "src/control/control-http.ts"))).rejects.toThrow();
    await expect(access(join(projectRoot, "src/control/block-http.ts"))).rejects.toThrow();
    // Web 工作台源码收敛在 src-tauri/web/，旧顶层 web/ 与 src/web/ 产物目录不得复活。
    await expect(access(join(projectRoot, "web"))).rejects.toThrow();
    await expect(access(join(projectRoot, "src/web"))).rejects.toThrow();
  });
});
