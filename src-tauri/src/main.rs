use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
use tauri::{Emitter, Manager, RunEvent, Theme, WindowEvent};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_shell::{ShellExt, process::{CommandChild, CommandEvent}};

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const ENGINE_ENV_KEYS: &[&str] = &["WAVE_FLOW_HOME"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineRequest<'a> { request_id: String, method: &'a str, action: Option<&'a str>, args: Option<serde_json::Value> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineResponse { request_id: String, ok: bool, result: Option<serde_json::Value>, error: Option<String> }

/** Tauri 是 Engine 的唯一父进程，持有私有 stdin/stdout 与请求关联表。 */
struct EngineState {
  child: Mutex<Option<CommandChild>>,
  /** 每次 spawn 的单调代号；迟到的旧 stdout/Terminated 不能影响新 Engine。 */
  generation: AtomicU64,
  ready: Mutex<bool>,
  /** 仅保留 Tauri 已登记、尚未超时的响应，迟到 JSONL 不得泄漏进内存。 */
  pending: Mutex<HashSet<String>>,
  responses: Mutex<HashMap<String, EngineResponse>>,
  startup_error: Mutex<Option<String>>,
  stdout_buffer: Mutex<Vec<u8>>,
}
struct TrayState { summary: Mutex<MenuItem<tauri::Wry>> }
struct PendingMenuAction { value: Mutex<Option<&'static str>> }
/** 仅在 Engine 已完成 durable-first 取消后允许系统真正结束应用。 */
struct ExitState { approved: AtomicBool }

#[tauri::command]
async fn ensure_engine(app: tauri::AppHandle) -> Result<(), String> { start_engine(&app).await }

/** React 的私有 Engine action 代理；不通过 TCP、HTTP 或 URL 路由。 */
#[tauri::command]
async fn engine_request(app: tauri::AppHandle, action: String, args: Option<serde_json::Value>, timeout_secs: Option<u64>) -> Result<serde_json::Value, String> {
  if action.trim().is_empty() { return Err("桌面 action 无效。".to_string()); }
  start_engine(&app).await?;
  // 个别长动作（如分配规则解析，Engine 侧允许 120 秒）由调用方显式给出更长
  // 超时；默认 60 秒，上限 600 秒防止无限悬挂。
  let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(60).clamp(1, 600));
  dispatch_with_timeout(&app, EngineRequest { request_id: request_id(), method: "engine.action", action: Some(&action), args }, timeout).await
}

#[tauri::command]
fn update_tray_summary(app: tauri::AppHandle, summary: String) -> Result<(), String> { app.state::<TrayState>().summary.lock().map_err(|_| "菜单栏状态锁不可用。".to_string())?.set_text(summary).map_err(|error| error.to_string()) }#[tauri::command]
fn take_menu_action(app: tauri::AppHandle) -> Result<Option<String>, String> { Ok(app.state::<PendingMenuAction>().value.lock().map_err(|_| "菜单栏动作锁不可用。".to_string())?.take().map(str::to_string)) }
/** 等待 Engine durable-first 取消完成后，Tauri 才回收其拥有的进程组并退出。 */
#[tauri::command]
async fn exit_desktop(app: tauri::AppHandle) -> Result<(), String> {
  // 正常路径给 Engine 一个短窗口完成 durable-first cancelled。若它已崩溃、磁盘
  // 写入异常或管道失联，绝不能把用户困在“正在退出”：强制退出会在下次启动时按
  // 异常路径收敛为 interrupted，而不是伪造 cancelled。崩溃的 Engine 不再复活，
  // 启动收敛由下次应用启动的 convergeStaleAcpWorkers 完成。
  let alive = app.state::<EngineState>().child.lock().map(|value| value.is_some()).unwrap_or(false);
  if alive {
    let request = EngineRequest { request_id: request_id(), method: "engine.shutdown", action: None, args: None };
    let _ = dispatch_with_timeout(&app, request, std::time::Duration::from_secs(3)).await;
  }
  shutdown_engine(&app);
  app.state::<ExitState>().approved.store(true, Ordering::Release);
  app.exit(0); Ok(())
}
#[tauri::command]
fn set_window_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> { let value = match theme.as_str() { "light" => Theme::Light, "dark" => Theme::Dark, _ => return Err("桌面主题只允许 light 或 dark。".to_string()) }; app.get_webview_window("main").ok_or_else(|| "主窗口不可用。".to_string())?.set_theme(Some(value)).map_err(|error| error.to_string()) }

async fn start_engine(app: &tauri::AppHandle) -> Result<(), String> {
  let state = app.state::<EngineState>();
  // 从检查到登记 child 都必须持有同一把锁。shell sidecar 的 spawn 是同步调用，
  // 因此无需跨 await 持锁；这样两个并发 invoke 不会启动两个 Engine。
  let mut child_slot = state.child.lock().map_err(|_| "Engine 状态锁不可用。".to_string())?;
  if child_slot.is_some() { return state.startup_error.lock().map_err(|_| "Engine 状态锁不可用。".to_string())?.clone().map_or(Ok(()), Err); }
  // 必须接收原始 stdout 字节；默认的按行事件会在长 JSON 响应中截断帧。
  let (mut events, child) = app.shell().sidecar("wave-flow-desktop-engine").map_err(|error| format!("无法定位 Desktop Engine：{error}"))?.envs(engine_env()).set_raw_out(true).set_process_group(true).spawn().map_err(|error| format!("无法启动 Desktop Engine：{error}"))?;
  *child_slot = Some(child);
  let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
  drop(child_slot);
  // 新 child 不得继承上一轮启动/退出残留的错误、半帧、已超时响应或就绪标志；
  // ready 不重置会让新 Engine 启动阶段的 stderr 被当成诊断噪音吞掉。
  *state.ready.lock().map_err(|_| "Engine 状态锁不可用。".to_string())? = false;
  *state.startup_error.lock().map_err(|_| "Engine 状态锁不可用。".to_string())? = None;
  state.stdout_buffer.lock().map_err(|_| "Engine 状态锁不可用。".to_string())?.clear();
  state.responses.lock().map_err(|_| "Engine 状态锁不可用。".to_string())?.clear();
  state.pending.lock().map_err(|_| "Engine 状态锁不可用。".to_string())?.clear();
  let handle = app.clone();
  tauri::async_runtime::spawn(async move {
    while let Some(event) = events.recv().await {
      // 上一次 Engine 的事件通道可能在新 child 已启动后才排空。所有这些迟到
      // 事件都必须丢弃，尤其不能把新 child slot 误设为 None。
      if handle.state::<EngineState>().generation.load(Ordering::Acquire) != generation { continue; }
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
              if let Ok(mut error) = state.startup_error.lock() { *error = Some(message); }
            }
          }
        },
        CommandEvent::Error(error) => {
          let state = handle.state::<EngineState>();
          if let Ok(mut value) = state.startup_error.lock() { *value = Some(error.clone()); }
          fail_pending(&state, format!("Desktop Engine 管道错误：{error}"));
        },
        CommandEvent::Terminated(_) => {
          let state = handle.state::<EngineState>();
          if let Ok(mut child) = state.child.lock() { *child = None; }
          fail_pending(&state, "Desktop Engine 已退出。".to_string());
        },
        _ => {}
      }
    }
  });
  // 不在 Tauri command 内阻塞等待 ready：stdout 消费同样由异步运行时调度，阻塞
  // 等待会形成“等待 ready 而无法读取 ready”的死锁。首个业务请求会等待其响应。
  Ok(())
}
/** Engine 终止后立即唤醒所有调用方，不能让它们误等常规 action 超时。 */
fn fail_pending(state: &tauri::State<'_, EngineState>, error: String) {
  let ids = match state.pending.lock() { Ok(mut pending) => pending.drain().collect::<Vec<_>>(), Err(_) => return };
  if let Ok(mut responses) = state.responses.lock() {
    for request_id in ids { responses.insert(request_id.clone(), EngineResponse { request_id, ok: false, result: None, error: Some(error.clone()) }); }
  }
}

/** Shell stdout 事件可能切在 UTF-8 字符内部，先按字节缓冲/换行分帧后再解码。 */
fn process_stdout(app: &tauri::AppHandle, bytes: &[u8]) {
  let state = app.state::<EngineState>();
  let Ok(mut buffer) = state.stdout_buffer.lock() else { return; };
  buffer.extend_from_slice(bytes);
  while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
    let frame: Vec<u8> = buffer.drain(..=index).collect();
    let Ok(line) = std::str::from_utf8(&frame[..frame.len() - 1]) else { if let Ok(mut error) = app.state::<EngineState>().startup_error.lock() { *error = Some("Desktop Engine JSONL 帧不是 UTF-8。".to_string()); } continue; };
    if !line.trim().is_empty() { process_line(app, line); }
  }
}
fn process_line(app: &tauri::AppHandle, line: &str) {
  // 先按帧形状分流：EngineReady 只有 type/protocolVersion 两个字段，serde 会忽略
  // 未知字段，若先尝试反序列化 EngineReady，事件帧（type: "event"）也会被成功解析
  // 并在这里被 return 吞掉，整条事件通道静默失效。
  let Ok(frame) = serde_json::from_str::<serde_json::Value>(line) else { return; };
  let frame_type = frame.get("type").and_then(|value| value.as_str());
  let protocol = frame.get("protocolVersion").and_then(|value| value.as_u64());
  if frame_type == Some("ready") && protocol == Some(1) { if let Ok(mut value) = app.state::<EngineState>().ready.lock() { *value = true; } return; }
  // 事件帧与请求响应分流：事件帧没有 requestId，type 恒为 "event"。Tauri 附加当前
  // Engine generation 后转发给 Web；旧 Engine 的迟到帧已在 stdout 消费层被丢弃。
  if frame_type == Some("event") && protocol == Some(1) {
    let generation = app.state::<EngineState>().generation.load(Ordering::Acquire);
    let _ = app.emit("engine-event", serde_json::json!({ "generation": generation, "frame": frame }));
    return;
  }
  if let Ok(response) = serde_json::from_str::<EngineResponse>(line) {
    let state = app.state::<EngineState>();
    let accepted = state.pending.lock().map(|mut pending| pending.remove(&response.request_id)).unwrap_or(false);
    if accepted { if let Ok(mut responses) = state.responses.lock() { responses.insert(response.request_id.clone(), response); } }
  }
}
async fn dispatch_with_timeout(app: &tauri::AppHandle, request: EngineRequest<'_>, timeout: std::time::Duration) -> Result<serde_json::Value, String> {
  let id = request.request_id.clone(); let bytes = format!("{}\n", serde_json::to_string(&request).map_err(|error| error.to_string())?).into_bytes();
  let state = app.state::<EngineState>();
  state.pending.lock().map_err(|_| "Engine 状态锁不可用。".to_string())?.insert(id.clone());
  if let Err(error) = state.child.lock().map_err(|_| "Engine 状态锁不可用。".to_string())?.as_mut().ok_or_else(|| "Desktop Engine 未运行。".to_string())?.write(&bytes) {
    let _ = state.pending.lock().map(|mut pending| pending.remove(&id));
    return Err(format!("无法发送 Engine 请求：{error}"));
  }
  // Runtime 验证与首个 ACP session 投递分别允许 15 秒和 30 秒；5 秒会把正常
  // 慢启动误报成 Engine 失联。超时后 pending 被移除，迟到 JSONL 不会占用内存。
  let deadline = tokio::time::Instant::now() + timeout;
  while tokio::time::Instant::now() < deadline {
    if let Some(response) = state.responses.lock().map_err(|_| "Engine 状态锁不可用。".to_string())?.remove(&id) {
      return if response.ok { Ok(response.result.unwrap_or(serde_json::Value::Null)) } else { Err(response.error.unwrap_or_else(|| "Desktop Engine 拒绝请求。".to_string())) };
    }
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
  }
  let _ = state.pending.lock().map(|mut pending| pending.remove(&id));
  let _ = state.responses.lock().map(|mut responses| responses.remove(&id));
  Err("Desktop Engine 请求超时。".to_string())
}
fn engine_env() -> Vec<(String, String)> { ENGINE_ENV_KEYS.iter().filter_map(|key| std::env::var(key).ok().filter(|value| !value.trim().is_empty()).map(|value| ((*key).to_string(), value))).collect() }
fn request_id() -> String { format!("engine-{}", REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)) }
fn shutdown_engine(app: &tauri::AppHandle) { if let Some(mut child) = app.state::<EngineState>().child.lock().ok().and_then(|mut value| value.take()) { let _ = child.write(b"{\"requestId\":\"desktop-exit\",\"method\":\"engine.shutdown\"}\n"); let _ = child.kill(); } }
fn show_main_window(app: &tauri::AppHandle) -> Result<(), tauri::Error> { let window = app.get_webview_window("main").ok_or(tauri::Error::AssetNotFound("main".into()))?; window.show()?; window.set_focus()?; Ok(()) }

fn main() {
  tauri::Builder::default().plugin(tauri_plugin_shell::init()).plugin(tauri_plugin_dialog::init()).setup(|app| {
    let open = MenuItem::with_id(app, "open", "打开 Wave Flow", true, None::<&str>)?; let summary = MenuItem::with_id(app, "summary", "桌面执行环境启动中…", false, None::<&str>)?; let shutdown = MenuItem::with_id(app, "shutdown", "退出 Wave Flow", true, Some("CmdOrMeta+Q"))?; let separator = PredefinedMenuItem::separator(app)?; let menu = Menu::with_items(app, &[&open, &summary, &separator, &shutdown])?;
    // macOS 主菜单的退出也只能进入应用内确认，不使用系统默认 Quit 直接终止
    // 进程，确保用户明确退出时总会先完成 Engine 的 durable-first cancelled。
    // “设置… ⌘,”与左栏按钮共用同一个 PendingMenuAction 通道，隐藏窗口也会被唤起。
    let settings = MenuItem::with_id(app, "settings", "设置…", true, Some("CmdOrMeta+,"))?;
    let app_menu = Submenu::with_items(app, "Wave Flow", true, &[&open, &settings, &separator, &shutdown])?;
    // macOS WKWebView 的 ⌘X/⌘C/⌘V/⌘A 依赖原生“编辑”菜单项存在才会派发到输入框；
    // 缺少该菜单时 WebView 内所有编辑快捷键静默失效。
    let edit_menu = Submenu::with_items(app, "编辑", true, &[
      &PredefinedMenuItem::undo(app, Some("撤销"))?,
      &PredefinedMenuItem::redo(app, Some("重做"))?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::cut(app, Some("剪切"))?,
      &PredefinedMenuItem::copy(app, Some("拷贝"))?,
      &PredefinedMenuItem::paste(app, Some("粘贴"))?,
      &PredefinedMenuItem::select_all(app, Some("全选"))?,
    ])?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit_menu])?)?;
    // 应用菜单事件统一走 PendingMenuAction 通道；Web 经 take_menu_action 轮询消费。
    app.on_menu_event(|app, event| {
      if event.id().as_ref() == "settings" {
        if let Ok(mut action) = app.state::<PendingMenuAction>().value.lock() { *action = Some("settings"); }
        let _ = show_main_window(app);
      }
    });
    app.manage(EngineState { child: Mutex::new(None), generation: AtomicU64::new(0), ready: Mutex::new(false), pending: Mutex::new(HashSet::new()), responses: Mutex::new(HashMap::new()), startup_error: Mutex::new(None), stdout_buffer: Mutex::new(Vec::new()) }); app.manage(TrayState { summary: Mutex::new(summary) }); app.manage(PendingMenuAction { value: Mutex::new(None) }); app.manage(ExitState { approved: AtomicBool::new(false) });
    let tray_icon = app.default_window_icon().cloned();
    TrayIconBuilder::with_id("wave-flow-tray").menu(&menu).tooltip("Wave Flow").icon(tray_icon.unwrap_or_else(|| tauri::image::Image::new_owned(vec![0; 4], 1, 1))).on_menu_event(|app, event| match event.id().as_ref() { "open" => { let _ = show_main_window(app); }, "shutdown" => { if let Ok(mut action) = app.state::<PendingMenuAction>().value.lock() { *action = Some("shutdown"); } let _ = show_main_window(app); }, _ => {} }).build(app)?; Ok(())
  }).on_window_event(|window, event| { if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); } }).invoke_handler(tauri::generate_handler![ensure_engine, engine_request, update_tray_summary, take_menu_action, exit_desktop, set_window_theme]).build(tauri::generate_context!()).expect("创建 Wave Flow Desktop 失败").run(|app: &tauri::AppHandle, event| {
    if let RunEvent::ExitRequested { api, .. } = event {
      if app.state::<ExitState>().approved.load(Ordering::Acquire) { return; }
      // Cmd+Q、Dock 退出等系统请求不允许绕过 durable-first 取消。保留进程、唤起
      // 工作台并复用同一个退出确认对话；仅关闭窗口仍由上面的 WindowEvent 隐藏。
      api.prevent_exit();
      if let Ok(mut action) = app.state::<PendingMenuAction>().value.lock() { *action = Some("shutdown"); }
      let _ = show_main_window(app);
    }
  });
}
