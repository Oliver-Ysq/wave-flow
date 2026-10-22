use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent, Theme, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;

const ENGINE_ENV_KEYS: &[&str] = &["WAVE_FLOW_HOME"];
/** 退出握手的固定 requestId；其余请求身份由 Web 生成并经 engine-line 配对。 */
const EXIT_REQUEST_ID: &str = "desktop-exit";

/** Tauri 是 Engine 的唯一父进程：持有 child、原始 stdout 缓冲、就绪状态与退出握手。 */
struct EngineState {
    child: Mutex<Option<CommandChild>>,
    /** 每次 spawn 的单调代号；迟到的旧 stdout/Terminated 不能影响新 Engine。 */
    generation: AtomicU64,
    ready: Mutex<bool>,
    startup_error: Mutex<Option<String>>,
    stdout_buffer: Mutex<Vec<u8>>,
    /** 退出握手唤醒器：收到 engine.shutdown 响应或子进程终止时唤醒 exit_desktop。 */
    shutdown_ack: Mutex<Option<oneshot::Sender<()>>>,
}
struct TrayState {
    summary: Mutex<MenuItem<tauri::Wry>>,
}
struct PendingMenuAction {
    value: Mutex<Option<&'static str>>,
}
/** 仅在 Engine 已完成 durable-first 取消后允许系统真正结束应用。 */
struct ExitState {
    approved: AtomicBool,
    /** 退出流程去重：并发或重复确认时只允许一个流程写 shutdown / kill / exit。 */
    exiting: AtomicBool,
}

#[tauri::command]
async fn ensure_engine(app: tauri::AppHandle) -> Result<(), String> {
    start_engine(&app).await
}

/**
 * Web 在首帧内容提交后调用；窗口以 `visible: false` 创建，避免 WKWebView
 * 尚未绘制时先露出一帧空白再跳到工作台。重复调用只做 show/focus。
 */
#[tauri::command]
fn reveal_main_window(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window(&app).map_err(|error| error.to_string())
}

/** 校验并规整 Web 传来的 JSONL 行：非空、单行、不超过 8 MiB。 */
fn validate_engine_line(line: &str) -> Result<&str, String> {
    let line = line.trim();
    // JSONL 协议要求单行；含换行会把一条请求拆成两条，必须拒绝而不是静默截断语义。
    if line.is_empty()
        || line.contains('\n')
        || line.contains('\r')
        || line.len() > 8 * 1024 * 1024
    {
        return Err("Engine 请求行无效。".to_string());
    }
    Ok(line)
}

/**
 * 把 Web 生成的一整行 JSONL 原样写入 Engine stdin，并返回本次写入所属的
 * Engine generation。
 *
 * generation 让 Web 在 `engine-exited` 到达时只拒绝发给已退出 Engine 的请求，
 * 不会误伤新 Engine 的在途请求。Tauri 本身不解析 action、不配对响应。
 */
#[tauri::command]
async fn engine_write(app: tauri::AppHandle, line: String) -> Result<u64, String> {
    let line = validate_engine_line(&line)?;
    start_engine(&app).await?;
    let state = app.state::<EngineState>();
    // 启动阶段 stderr 仍是 Rust 侧诊断；仅就绪前把原因带回给首个请求。就绪后残留的
    // 启动噪音不能永久毒化后续请求（例如非致命 warning 写入过一次 startup_error）。
    let ready = state
        .ready
        .lock()
        .map_err(|_| "Engine 状态锁不可用。".to_string())?
        .to_owned();
    if !ready {
        if let Some(message) = state
            .startup_error
            .lock()
            .map_err(|_| "Engine 状态锁不可用。".to_string())?
            .clone()
        {
            return Err(message);
        }
    }
    // 持有 child 锁读取 generation：spawn 在同一把锁内递增，保证返回的代号与本次
    // 实际写入的 Engine 一致（Web 用它过滤已退出 Engine 的迟到请求）。
    let mut child_slot = state
        .child
        .lock()
        .map_err(|_| "Engine 状态锁不可用。".to_string())?;
    let process = child_slot
        .as_mut()
        .ok_or_else(|| "Desktop Engine 未运行。".to_string())?;
    let generation = state.generation.load(Ordering::Acquire);
    process
        .write(format!("{line}\n").as_bytes())
        .map_err(|error| format!("无法发送 Engine 请求：{error}"))?;
    Ok(generation)
}

#[tauri::command]
fn update_tray_summary(app: tauri::AppHandle, summary: String) -> Result<(), String> {
    app.state::<TrayState>()
        .summary
        .lock()
        .map_err(|_| "菜单栏状态锁不可用。".to_string())?
        .set_text(summary)
        .map_err(|error| error.to_string())
}
#[tauri::command]
fn take_menu_action(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .state::<PendingMenuAction>()
        .value
        .lock()
        .map_err(|_| "菜单栏动作锁不可用。".to_string())?
        .take()
        .map(str::to_string))
}
/** 等待 Engine durable-first 取消完成后，Tauri 才回收其拥有的进程组并退出。 */
#[tauri::command]
async fn exit_desktop(app: tauri::AppHandle) -> Result<(), String> {
    // 正常路径给 Engine 一个短窗口完成 durable-first cancelled。若它已崩溃、磁盘
    // 写入异常或管道失联，绝不能把用户困在“正在退出”：强制退出会在下次启动时按
    // 异常路径收敛为 interrupted，而不是伪造 cancelled。崩溃的 Engine 不再复活，
    // 启动收敛由下次应用启动的 convergeStaleAcpWorkers 完成。
    if app
        .state::<ExitState>()
        .exiting
        .swap(true, Ordering::AcqRel)
    {
        // 并发/重复确认：已有退出流程在收尾，直接返回，避免二次 shutdown/kill。
        return Ok(());
    }
    let (sender, receiver) = oneshot::channel();
    let state = app.state::<EngineState>();
    let waiting = {
        let mut child_slot = match state.child.lock() {
            Ok(child_slot) => child_slot,
            Err(_) => {
                app.state::<ExitState>()
                    .exiting
                    .store(false, Ordering::Release);
                return Err("Engine 状态锁不可用。".to_string());
            }
        };
        match child_slot.as_mut() {
            Some(process) => {
                if let Ok(mut slot) = state.shutdown_ack.lock() {
                    *slot = Some(sender);
                }
                let line = format!(
                    "{{\"requestId\":\"{EXIT_REQUEST_ID}\",\"method\":\"engine.shutdown\"}}\n"
                );
                process.write(line.as_bytes()).is_ok()
            }
            None => false,
        }
    };
    if waiting {
        // 最多等 3 秒确认 Engine 已耐久写入 cancelled；超时仍强制退出。
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), receiver).await;
    }
    if let Ok(mut slot) = app.state::<EngineState>().shutdown_ack.lock() {
        *slot = None;
    }
    shutdown_engine(&app);
    app.state::<ExitState>()
        .approved
        .store(true, Ordering::Release);
    app.exit(0);
    Ok(())
}
#[tauri::command]
fn set_window_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    let value = match theme.as_str() {
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        _ => return Err("桌面主题只允许 light 或 dark。".to_string()),
    };
    app.get_webview_window("main")
        .ok_or_else(|| "主窗口不可用。".to_string())?
        .set_theme(Some(value))
        .map_err(|error| error.to_string())
}

async fn start_engine(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<EngineState>();
    // 从检查到登记 child 都必须持有同一把锁。shell sidecar 的 spawn 是同步调用，
    // 因此无需跨 await 持锁；这样两个并发 invoke 不会启动两个 Engine。
    let mut child_slot = state
        .child
        .lock()
        .map_err(|_| "Engine 状态锁不可用。".to_string())?;
    if child_slot.is_some() {
        return state
            .startup_error
            .lock()
            .map_err(|_| "Engine 状态锁不可用。".to_string())?
            .clone()
            .map_or(Ok(()), Err);
    }
    // 必须接收原始 stdout 字节；默认的按行事件会在长 JSON 响应中截断帧。
    let (mut events, child) = app
        .shell()
        .sidecar("wave-flow-desktop-engine")
        .map_err(|error| format!("无法定位 Desktop Engine：{error}"))?
        .envs(engine_env())
        .set_raw_out(true)
        .set_process_group(true)
        .spawn()
        .map_err(|error| format!("无法启动 Desktop Engine：{error}"))?;
    *child_slot = Some(child);
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    drop(child_slot);
    // 新 child 不得继承上一轮启动/退出残留的错误、半帧、已超时响应或就绪标志；
    // ready 不重置会让新 Engine 启动阶段的 stderr 被当成诊断噪音吞掉。
    *state
        .ready
        .lock()
        .map_err(|_| "Engine 状态锁不可用。".to_string())? = false;
    *state
        .startup_error
        .lock()
        .map_err(|_| "Engine 状态锁不可用。".to_string())? = None;
    state
        .stdout_buffer
        .lock()
        .map_err(|_| "Engine 状态锁不可用。".to_string())?
        .clear();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            // 上一次 Engine 的事件通道可能在新 child 已启动后才排空。所有这些迟到
            // 事件都必须丢弃，尤其不能把新 child slot 误设为 None。
            if handle
                .state::<EngineState>()
                .generation
                .load(Ordering::Acquire)
                != generation
            {
                continue;
            }
            match event {
                CommandEvent::Stdout(bytes) => process_stdout(&handle, &bytes),
                CommandEvent::Stderr(bytes) => {
                    let message = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !message.is_empty() {
                        let state = handle.state::<EngineState>();
                        // ready 之后的 stderr 只是诊断噪音（Bun/库级警告），绝不能毒化后续
                        // command；只有启动阶段的 stderr 才是启动错误。
                        let ready = state.ready.lock().map(|value| *value).unwrap_or(false);
                        if !ready {
                            if let Ok(mut error) = state.startup_error.lock() {
                                *error = Some(message);
                            }
                        }
                    }
                }
                CommandEvent::Error(error) => {
                    let state = handle.state::<EngineState>();
                    if let Ok(mut value) = state.startup_error.lock() {
                        *value = Some(format!("Desktop Engine 管道错误：{error}"));
                    }
                    // 唤醒正在等待退出握手的调用，避免退出流程被失联管道卡住。
                    let ack = state.shutdown_ack.lock();
                    if let Ok(mut ack) = ack {
                        ack.take();
                    }
                }
                CommandEvent::Terminated(_) => {
                    let state = handle.state::<EngineState>();
                    if let Ok(mut child) = state.child.lock() {
                        *child = None;
                    }
                    let ack = state.shutdown_ack.lock();
                    if let Ok(mut ack) = ack {
                        ack.take();
                    }
                    let ready = state.ready.lock().map(|value| *value).unwrap_or(false);
                    if !ready {
                        if let Ok(mut value) = state.startup_error.lock() {
                            *value = Some("Desktop Engine 在就绪前退出。".to_string());
                        }
                    }
                    let generation = state.generation.load(Ordering::Acquire);
                    // Web 用该事件立即拒绝所有在途请求，不必等到各自超时。
                    let _ = handle.emit(
                        "engine-exited",
                        serde_json::json!({ "generation": generation }),
                    );
                }
                _ => {}
            }
        }
    });
    // 不在 Tauri command 内阻塞等待 ready：stdout 消费同样由异步运行时调度，阻塞
    // 等待会形成“等待 ready 而无法读取 ready”的死锁。首个业务请求会等待其响应。
    Ok(())
}
/** Shell stdout 事件可能切在 UTF-8 字符内部，先按字节缓冲/换行分帧后再解码。 */
fn process_stdout(app: &tauri::AppHandle, bytes: &[u8]) {
    let state = app.state::<EngineState>();
    let Ok(mut buffer) = state.stdout_buffer.lock() else {
        return;
    };
    buffer.extend_from_slice(bytes);
    while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
        let frame: Vec<u8> = buffer.drain(..=index).collect();
        let Ok(line) = std::str::from_utf8(&frame[..frame.len() - 1]) else {
            if let Ok(mut error) = app.state::<EngineState>().startup_error.lock() {
                *error = Some("Desktop Engine JSONL 帧不是 UTF-8。".to_string());
            }
            continue;
        };
        if !line.trim().is_empty() {
            process_line(app, line);
        }
    }
}
/**
 * 只做两件事：置 ready 标志，把非事件 JSONL 行原样转发给 Web。
 *
 * 请求配对、超时与错误翻译全部在 Web 侧完成；Tauri 不保存请求表。
 */
fn process_line(app: &tauri::AppHandle, line: &str) {
    let Ok(frame) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let frame_type = frame.get("type").and_then(|value| value.as_str());
    let protocol = frame
        .get("protocolVersion")
        .and_then(|value| value.as_u64());
    if frame_type == Some("ready") && protocol == Some(1) {
        if let Ok(mut value) = app.state::<EngineState>().ready.lock() {
            *value = true;
        }
        return;
    }
    let generation = app
        .state::<EngineState>()
        .generation
        .load(Ordering::Acquire);
    // 事件帧保持既有 engine-event 通道，事件消费者不需要改动。
    if frame_type == Some("event") && protocol == Some(1) {
        let _ = app.emit(
            "engine-event",
            serde_json::json!({ "generation": generation, "frame": frame }),
        );
        return;
    }
    // 退出握手由 Rust 独占（Web 不参与该响应配对）；其余响应行交给 Web。
    if frame.get("requestId").and_then(|value| value.as_str()) == Some(EXIT_REQUEST_ID) {
        if let Ok(mut slot) = app.state::<EngineState>().shutdown_ack.lock() {
            slot.take();
        }
    }
    let _ = app.emit(
        "engine-line",
        serde_json::json!({ "generation": generation, "line": line }),
    );
}
fn engine_env() -> Vec<(String, String)> {
    ENGINE_ENV_KEYS
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| ((*key).to_string(), value))
        })
        .collect()
}
fn shutdown_engine(app: &tauri::AppHandle) {
    if let Some(mut child) = app
        .state::<EngineState>()
        .child
        .lock()
        .ok()
        .and_then(|mut value| value.take())
    {
        let _ = child.write(b"{\"requestId\":\"desktop-exit\",\"method\":\"engine.shutdown\"}\n");
        let _ = child.kill();
    }
}
fn show_main_window(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let window = app
        .get_webview_window("main")
        .ok_or(tauri::Error::AssetNotFound("main".into()))?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "打开 Wave Flow", true, None::<&str>)?;
            let summary =
                MenuItem::with_id(app, "summary", "桌面执行环境启动中…", false, None::<&str>)?;
            let shutdown =
                MenuItem::with_id(app, "shutdown", "退出 Wave Flow", true, Some("CmdOrCtrl+Q"))?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &summary, &separator, &shutdown])?;
            // macOS 主菜单的退出也只能进入应用内确认，不使用系统默认 Quit 直接终止
            // 进程，确保用户明确退出时总会先完成 Engine 的 durable-first cancelled。
            // “设置… ⌘,”与左栏按钮共用同一个 PendingMenuAction 通道，隐藏窗口也会被唤起。
            let settings = MenuItem::with_id(app, "settings", "设置…", true, Some("CmdOrCtrl+,"))?;
            let app_menu = Submenu::with_items(
                app,
                "Wave Flow",
                true,
                &[&open, &settings, &separator, &shutdown],
            )?;
            // macOS WKWebView 的 ⌘X/⌘C/⌘V/⌘A 依赖原生“编辑”菜单项存在才会派发到输入框；
            // 缺少该菜单时 WebView 内所有编辑快捷键静默失效。
            let edit_menu = Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some("撤销"))?,
                    &PredefinedMenuItem::redo(app, Some("重做"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some("剪切"))?,
                    &PredefinedMenuItem::copy(app, Some("拷贝"))?,
                    &PredefinedMenuItem::paste(app, Some("粘贴"))?,
                    &PredefinedMenuItem::select_all(app, Some("全选"))?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&app_menu, &edit_menu])?)?;
            // 应用菜单事件统一走 PendingMenuAction 通道；Web 经 take_menu_action 轮询消费。
            app.on_menu_event(|app, event| {
                if matches!(event.id().as_ref(), "settings" | "shutdown") {
                    if let Ok(mut action) = app.state::<PendingMenuAction>().value.lock() {
                        *action = Some(if event.id().as_ref() == "settings" {
                            "settings"
                        } else {
                            "shutdown"
                        });
                    }
                    let _ = show_main_window(app);
                }
            });
            app.manage(EngineState {
                child: Mutex::new(None),
                generation: AtomicU64::new(0),
                ready: Mutex::new(false),
                startup_error: Mutex::new(None),
                stdout_buffer: Mutex::new(Vec::new()),
                shutdown_ack: Mutex::new(None),
            });
            app.manage(TrayState {
                summary: Mutex::new(summary),
            });
            app.manage(PendingMenuAction {
                value: Mutex::new(None),
            });
            app.manage(ExitState {
                approved: AtomicBool::new(false),
                exiting: AtomicBool::new(false),
            });
            // 兜底：Web 因脚本错误或 Engine 握手悬挂没有调用 reveal 时，2.5 秒后仍显示窗口，
            // 让恢复页/错误页可见，绝不把应用永久留在不可见状态。
            let fallback = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2500));
                if let Some(window) = fallback.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(false) {
                        let _ = show_main_window(&fallback);
                    }
                }
            });
            let tray_icon = app.default_window_icon().cloned();
            TrayIconBuilder::with_id("wave-flow-tray")
                .menu(&menu)
                .tooltip("Wave Flow")
                .icon(tray_icon.unwrap_or_else(|| tauri::image::Image::new_owned(vec![0; 4], 1, 1)))
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        let _ = show_main_window(app);
                    }
                    "shutdown" => {
                        if let Ok(mut action) = app.state::<PendingMenuAction>().value.lock() {
                            *action = Some("shutdown");
                        }
                        let _ = show_main_window(app);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            ensure_engine,
            engine_write,
            update_tray_summary,
            take_menu_action,
            exit_desktop,
            set_window_theme,
            reveal_main_window
        ])
        .build(tauri::generate_context!())
        .expect("创建 Wave Flow Desktop 失败")
        .run(|app: &tauri::AppHandle, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                if app.state::<ExitState>().approved.load(Ordering::Acquire) {
                    return;
                }
                // Cmd+Q、Dock 退出等系统请求不允许绕过 durable-first 取消。保留进程、唤起
                // 工作台并复用同一个退出确认对话；仅关闭窗口仍由上面的 WindowEvent 隐藏。
                api.prevent_exit();
                if let Ok(mut action) = app.state::<PendingMenuAction>().value.lock() {
                    *action = Some("shutdown");
                }
                let _ = show_main_window(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::validate_engine_line;

    /** 正常请求：外围空白被规整，内容原样保留。 */
    #[test]
    fn accepts_single_line_json() {
        assert_eq!(
            validate_engine_line("  {\"requestId\":\"a\",\"method\":\"engine.action\"}\n")
                .expect("单行 JSON 应通过"),
            "{\"requestId\":\"a\",\"method\":\"engine.action\"}"
        );
    }

    /** 空行、纯空白与多行都会被拒绝；多行不能静默拆成两条 JSONL。 */
    #[test]
    fn rejects_empty_and_multiline() {
        assert!(validate_engine_line("").is_err());
        assert!(validate_engine_line("   ").is_err());
        assert!(validate_engine_line("{\"a\":1}\n{\"b\":2}").is_err());
        assert!(validate_engine_line("{\r\n}").is_err());
    }

    /** 超限请求拒绝，避免无界内存/管道写入。 */
    #[test]
    fn rejects_oversized_line() {
        let oversized = format!("{{\"x\":\"{}\"}}", "a".repeat(8 * 1024 * 1024));
        assert!(validate_engine_line(&oversized).is_err());
    }
}
