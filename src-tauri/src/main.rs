use serde::{Deserialize, Serialize};
#[cfg(not(debug_assertions))]
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonConnection {
  base_url: String,
}

/**
 * 通过随包 bridge 复用 Bun daemon 的 descriptor/health/PID 校验。
 * Rust 只启动 bridge 并返回结果，绝不读取 Journal 或维护 Run 状态。
 */
#[tauri::command]
async fn ensure_daemon(app: tauri::AppHandle) -> Result<DaemonConnection, String> {
  let web_dist = web_dist_path(&app)?;
  if !web_dist.join("index.html").is_file() {
    return Err(format!("桌面 Web 资源缺失：{}", web_dist.display()));
  }
  let output = app
    .shell()
    .sidecar("wave-flow-desktop-bridge")
    .map_err(|error| format!("无法定位桌面 bridge：{error}"))?
    .env("WF_WEB_DIST", web_dist)
    // Harness provider 配置仅从启动桌面应用的本机环境继承，并且只转交给
    // 本机 sidecar。它不会进入 Web、bridge stdout、Journal 或 daemon API。
    // 这里不把任意环境变量透传给子进程，避免桌面壳意外扩大配置边界。
    .envs(harness_env())
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

/** 可由桌面应用安全继承的 Harness 本机模型配置；value 是 secret 时不记录或返回。 */
fn harness_env() -> Vec<(String, String)> {
  ["WAVE_FLOW_HARNESS_API_KEY", "WAVE_FLOW_HARNESS_BASE_URL", "WAVE_FLOW_HARNESS_MODEL"]
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

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![ensure_daemon])
    .run(tauri::generate_context!())
    .expect("运行 Wave Flow Desktop 失败");
}

#[cfg(test)]
mod tests {
  use super::{harness_env, validate_loopback_url};

  #[test]
  fn only_accepts_plain_ipv4_loopback_daemon_urls() {
    assert!(validate_loopback_url("http://127.0.0.1:4312").is_ok());
    assert!(validate_loopback_url("http://localhost:4312").is_err());
    assert!(validate_loopback_url("https://127.0.0.1:4312").is_err());
    assert!(validate_loopback_url("http://127.0.0.1:4312/path").is_err());
    assert!(validate_loopback_url("http://user@127.0.0.1:4312").is_err());
  }

  #[test]
  fn harness_environment_allowlist_is_narrow() {
    let names = harness_env().into_iter().map(|(key, _)| key).collect::<Vec<_>>();
    assert!(names.iter().all(|key| ["WAVE_FLOW_HARNESS_API_KEY", "WAVE_FLOW_HARNESS_BASE_URL", "WAVE_FLOW_HARNESS_MODEL"].contains(&key.as_str())));
  }
}
