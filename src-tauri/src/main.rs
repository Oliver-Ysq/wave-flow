use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, Theme, WindowEvent};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_shell::ShellExt;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonConnection {
  base_url: String,
}

/** 菜单栏只保留 daemon 已计算的摘要文本，不持有 Run、Journal 或会话状态。 */
struct TrayState { summary: Mutex<MenuItem<tauri::Wry>> }

/** 菜单栏动作只保留一次性 UI 意图；不保存 daemon 或 Run 状态。 */
struct PendingMenuAction { value: Mutex<Option<&'static str>> }

/** 桌面壳可转交给 bridge 的唯一环境键；禁止以任意父进程环境替代此白名单。 */
const SIDECAR_ENV_KEYS: &[&str] = &[
  "WAVE_FLOW_HOME",
  "WAVE_FLOW_HARNESS_API_KEY",
  "WAVE_FLOW_HARNESS_BASE_URL",
  "WAVE_FLOW_HARNESS_MODEL",
];

/**
 * 通过随包 bridge 复用 Bun daemon 的 descriptor/health/PID 校验。
 * Rust 只启动 bridge 并返回结果，绝不读取 Journal 或维护 Run 状态。
 */
#[tauri::command]
async fn ensure_daemon(app: tauri::AppHandle) -> Result<DaemonConnection, String> {
  bridge_daemon(&app, false).await
}

/** 用户二次确认后才进入；bridge 会先验证旧 daemon 身份并请求优雅退出。 */
#[tauri::command]
async fn restart_daemon(app: tauri::AppHandle) -> Result<DaemonConnection, String> {
  bridge_daemon(&app, true).await
}

/** 页面从 daemon/status 读取摘要后调用；Rust 仅展示这一权威投影。 */
#[tauri::command]
fn update_tray_summary(app: tauri::AppHandle, summary: String) -> Result<(), String> {
  app.state::<TrayState>().summary.lock().map_err(|_| "菜单栏状态锁不可用。".to_string())?.set_text(summary).map_err(|error| error.to_string())
}

/** 仅在 Web 已收到 daemon 自己的关闭确认后调用，移除菜单栏伴侣。 */
#[tauri::command]
fn exit_menu_companion(app: tauri::AppHandle) {
  app.exit(0);
}

/** Web 通过窄轮询消费菜单栏意图，避免前端 event plugin ACL 异常打断整个工作台。 */
#[tauri::command]
fn take_menu_action(app: tauri::AppHandle) -> Result<Option<String>, String> {
  Ok(app.state::<PendingMenuAction>().value.lock().map_err(|_| "菜单栏动作锁不可用。".to_string())?.take().map(str::to_string))
}

/**
 * 仅同步主窗口的原生明暗外观；Web 主题仍由 React 保存和渲染。
 *
 * 允许值限定为 `light`、`dark`，拒绝任何其他值，避免将窗口配置扩大成
 * 任意桌面控制通道。窗口保留 macOS 系统可见标题栏，由系统稳定绘制
 * 关闭、最小化与全屏交通灯；此命令只同步其原生明暗外观。
 * 该命令不读取或改变 daemon、Run、Journal 与会话状态。
 */
#[tauri::command]
fn set_window_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
  let native_theme = match theme.as_str() {
    "light" => Theme::Light,
    "dark" => Theme::Dark,
    _ => return Err("桌面主题只允许 light 或 dark。".to_string()),
  };
  let window = app.get_webview_window("main").ok_or_else(|| "主窗口不可用。".to_string())?;
  window.set_theme(Some(native_theme)).map_err(|error| error.to_string())
}

async fn bridge_daemon(app: &tauri::AppHandle, restart: bool) -> Result<DaemonConnection, String> {
  let web_dist = web_dist_path(&app)?;
  if !web_dist.join("index.html").is_file() {
    return Err(format!("桌面 Web 资源缺失：{}", web_dist.display()));
  }
  let output = app
    .shell()
    .sidecar("wave-flow-desktop-bridge")
    .map_err(|error| format!("无法定位桌面 bridge：{error}"))?
    .env("WF_WEB_DIST", web_dist)
    // Harness provider 配置与受控隔离状态根仅从启动桌面应用的本机环境继承，
    // 并且只转交给本机 sidecar。它们不会进入 Web、bridge stdout、Journal 或
    // daemon API；这里不透传任意环境变量，避免桌面壳意外扩大配置边界。
    .envs(sidecar_env())
    .args(if restart { vec!["--restart"] } else { vec![] })
    .output()
    .await
    .map_err(|error| format!("无法启动桌面 bridge：{error}"))?;
  if !output.status.success() {
    return Err(format!(
      "Wave Flow daemon 启动失败：{}",
      String::from_utf8_lossy(&output.stderr).trim()
    ));
  }
  let connection = serde_json::from_slice::<DaemonConnection>(&output.stdout)
    .map_err(|error| format!("桌面 bridge 返回无效地址：{error}"))?;
  validate_loopback_url(&connection.base_url)?;
  Ok(connection)
}

/** 可安全转交给 sidecar 的明确环境白名单；secret 不记录或返回。 */
fn sidecar_env() -> Vec<(String, String)> {
  SIDECAR_ENV_KEYS
    .iter()
    .filter_map(|key| std::env::var(key).ok().filter(|value| !value.trim().is_empty()).map(|value| ((*key).to_string(), value)))
    .collect()
}

/** bridge 返回值不是授权；桌面壳仍只接受无凭据的 IPv4 loopback HTTP 地址。 */
fn validate_loopback_url(value: &str) -> Result<(), String> {
  let port = value
    .strip_prefix("http://127.0.0.1:")
    .ok_or_else(|| "桌面 bridge 未返回 IPv4 loopback daemon 地址。".to_string())?;
  if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
    return Err("桌面 bridge 返回的 daemon 地址含有无效路径、凭据或端口。".to_string());
  }
  let number = port.parse::<u16>().map_err(|_| "桌面 bridge 返回的 daemon 端口无效。".to_string())?;
  if number == 0 {
    return Err("桌面 bridge 返回的 daemon 端口无效。".to_string());
  }
  Ok(())
}

/**
 * release 必须使用 Tauri 资源目录；dev 使用 desktop:prepare 生成的项目 dist，
 * 使本地开发与正式 sidecar 的资源来源各自明确，不依赖相对 cwd。
 */
fn web_dist_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  #[cfg(debug_assertions)]
  let _ = app;
  #[cfg(debug_assertions)]
  let web_dist = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("..")
    .join("src")
    .join("web")
    .join("dist");
  #[cfg(not(debug_assertions))]
  let web_dist = app
    .path()
    .resource_dir()
    .map_err(|error| format!("无法定位桌面资源目录：{error}"))?
    .join("web-dist");
  if !web_dist.join("index.html").is_file() {
    return Err(format!("桌面 Web 资源缺失：{}", web_dist.display()));
  }
  Ok(web_dist)
}

/**
 * 专供 macOS 菜单栏的透明单色 V；不能复用带圆角背景的应用图标。
 *
 * menu bar 会将 template 图标按系统明暗色染色，所以这里仅提供黑色不透明像素和
 * 透明背景。以 4x 采样生成抗锯齿边缘，避免小尺寸下的 V 变成两条细线。
 */
fn tray_v_icon() -> Image<'static> {
  const SIZE: u32 = 44;
  const SAMPLES: u32 = 4;
  const STROKE: f32 = 5.4;
  let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);

  for y in 0..SIZE {
    for x in 0..SIZE {
      let mut covered = 0_u32;
      for sample_y in 0..SAMPLES {
        for sample_x in 0..SAMPLES {
          let px = x as f32 + (sample_x as f32 + 0.5) / SAMPLES as f32;
          let py = y as f32 + (sample_y as f32 + 0.5) / SAMPLES as f32;
          let left = distance_to_segment(px, py, 9.0, 10.0, 22.0, 34.0);
          let right = distance_to_segment(px, py, 35.0, 10.0, 22.0, 34.0);
          if left <= STROKE / 2.0 || right <= STROKE / 2.0 {
            covered += 1;
          }
        }
      }
      let alpha = (covered * 255 / (SAMPLES * SAMPLES)) as u8;
      rgba.extend_from_slice(&[0, 0, 0, alpha]);
    }
  }
  Image::new_owned(rgba, SIZE, SIZE)
}

/** 返回点到有限线段的距离，确保 V 的两个端点在小菜单栏尺寸下仍圆润可辨。 */
fn distance_to_segment(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
  let ab_x = bx - ax;
  let ab_y = by - ay;
  let projection = ((px - ax) * ab_x + (py - ay) * ab_y) / (ab_x * ab_x + ab_y * ab_y);
  let t = projection.clamp(0.0, 1.0);
  let dx = px - (ax + ab_x * t);
  let dy = py - (ay + ab_y * t);
  (dx * dx + dy * dy).sqrt()
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      // 使用 macOS 可见标题栏，由系统稳定绘制完整的关闭、最小化与全屏交通灯。
      // Web 工作台从标题栏下方开始，避免把业务控件和窗口控制区放在同一行。
      let open = MenuItem::with_id(app, "open", "打开 Wave Flow", true, None::<&str>)?;
      let summary = MenuItem::with_id(app, "summary", "正在连接后台服务…", false, None::<&str>)?;
      let restart = MenuItem::with_id(app, "restart", "重启后台服务…", true, None::<&str>)?;
      let shutdown = MenuItem::with_id(app, "shutdown", "退出后台服务…", true, None::<&str>)?;
      let quit = MenuItem::with_id(app, "quit", "退出菜单栏伴侣", true, None::<&str>)?;
      let separator = PredefinedMenuItem::separator(app)?;
      let menu = Menu::with_items(app, &[&open, &summary, &separator, &restart, &shutdown, &quit])?;
      app.manage(TrayState { summary: Mutex::new(summary) });
      app.manage(PendingMenuAction { value: Mutex::new(None) });
      TrayIconBuilder::with_id("wave-flow-tray")
        .menu(&menu)
        .tooltip("Wave Flow 后台服务")
        .icon(tray_v_icon())
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
          "open" => { let _ = show_main_window(app); }
          "restart" => { if let Ok(mut action) = app.state::<PendingMenuAction>().value.lock() { *action = Some("restart"); } let _ = show_main_window(app); }
          "shutdown" => { if let Ok(mut action) = app.state::<PendingMenuAction>().value.lock() { *action = Some("shutdown"); } let _ = show_main_window(app); }
          "quit" => app.exit(0),
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
    .invoke_handler(tauri::generate_handler![ensure_daemon, restart_daemon, update_tray_summary, exit_menu_companion, take_menu_action, set_window_theme])
    .run(tauri::generate_context!())
    .expect("运行 Wave Flow Desktop 失败");
}

fn show_main_window(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
  let window = app.get_webview_window("main").ok_or(tauri::Error::AssetNotFound("main".into()))?;
  window.show()?; window.set_focus()?; Ok(())
}

#[cfg(test)]
mod tests {
  use super::{validate_loopback_url, SIDECAR_ENV_KEYS};

  #[test]
  fn only_accepts_plain_ipv4_loopback_daemon_urls() {
    assert!(validate_loopback_url("http://127.0.0.1:4312").is_ok());
    assert!(validate_loopback_url("http://localhost:4312").is_err());
    assert!(validate_loopback_url("https://127.0.0.1:4312").is_err());
    assert!(validate_loopback_url("http://127.0.0.1:4312/path").is_err());
    assert!(validate_loopback_url("http://user@127.0.0.1:4312").is_err());
  }

  #[test]
  fn sidecar_environment_allowlist_is_narrow() {
    assert_eq!(SIDECAR_ENV_KEYS, ["WAVE_FLOW_HOME", "WAVE_FLOW_HARNESS_API_KEY", "WAVE_FLOW_HARNESS_BASE_URL", "WAVE_FLOW_HARNESS_MODEL"]);
  }
}
