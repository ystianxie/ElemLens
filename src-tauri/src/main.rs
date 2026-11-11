#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod cdp;
mod capture_window;
mod geometry;
mod network;
mod desktop;
mod desktop_native;
mod desktop_job;
use desktop::{desktop_request, desktop_capture, desktop_highlight};
use cdp::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    process::Stdio,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::{Manager, State};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{Mutex, RwLock},
};

#[derive(Default)]
struct AppState {
    connection: RwLock<Option<Arc<Connection>>>,
    operation: Mutex<()>,
    network: network::Listener,
    desktop: desktop::Inspector,
}
#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    python: String,
    browser: String,
    #[serde(default, rename = "desktopPython")]
    desktop_python: String,
    #[serde(default = "default_hide_capture_window", rename = "hideCaptureWindow")]
    hide_capture_window: bool,
}
fn default_hide_capture_window() -> bool {
    true
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            python: String::new(),
            browser: String::new(),
            desktop_python: String::new(),
            hide_capture_window: default_hide_capture_window(),
        }
    }
}
#[derive(Clone, Serialize)]
struct Browser {
    endpoint: String,
    name: String,
    version: String,
}
#[derive(Clone, Serialize)]
struct Tab {
    id: String,
    title: String,
    url: String,
}
fn hidden(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
}
fn endpoint(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let value = if value.bytes().all(|c| c.is_ascii_digit()) {
        format!("http://127.0.0.1:{value}")
    } else if value.starts_with("http://") {
        value.into()
    } else {
        format!("http://{value}")
    };
    let url =
        reqwest::Url::parse(&value).map_err(|_| "请输入本机调试端口或 http://127.0.0.1:端口")?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("首版仅连接本机 HTTP 调试端口".into());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
async fn get_json(endpoint: &str, path: &str) -> Result<Value, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("{endpoint}{path}"))
        .send()
        .await
        .map_err(|e| format!("无法连接浏览器调试端口：{e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| format!("该端口未返回有效的 CDP 数据：{e}"))
}
#[tauri::command]
async fn inspect_browser(address: String) -> Result<Browser, String> {
    let address = endpoint(&address)?;
    let info = get_json(&address, "/json/version").await?;
    if !info["webSocketDebuggerUrl"].is_string() {
        return Err("该服务不是可连接的浏览器调试端口".into());
    }
    let version = info["Browser"].as_str().unwrap_or("Chromium").to_string();
    Ok(Browser {
        endpoint: address,
        name: if version.contains("Edg") {
            "Microsoft Edge"
        } else {
            "Chrome / Chromium"
        }
        .into(),
        version,
    })
}
#[tauri::command]
async fn discover_browsers() -> Vec<Browser> {
    let mut ports: BTreeSet<u16> = (9222..=9230).collect();
    let mut command = Command::new("powershell.exe");
    hidden(&mut command);
    command.args(["-NoProfile","-NonInteractive","-Command", "$ids = @(Get-Process chrome,msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); if ($ids.Count) { Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $ids } | Select-Object -ExpandProperty LocalPort -Unique | ConvertTo-Json -Compress }"]);
    if let Ok(Ok(output)) =
        tokio::time::timeout(Duration::from_secs(6), command.kill_on_drop(true).output()).await
    {
        if let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) {
            if let Some(port) = value.as_u64() {
                ports.insert(port as u16);
            }
            if let Some(values) = value.as_array() {
                for port in values {
                    if let Some(port) = port.as_u64() {
                        ports.insert(port as u16);
                    }
                }
            }
        }
    }
    let mut tasks = tokio::task::JoinSet::new();
    for port in ports {
        tasks.spawn(async move { inspect_browser(format!("127.0.0.1:{port}")).await });
    }
    let mut browsers = Vec::new();
    while let Some(Ok(result)) = tasks.join_next().await {
        if let Ok(browser) = result {
            browsers.push(browser);
        }
    }
    browsers.sort_by(|a, b| a.endpoint.cmp(&b.endpoint));
    browsers
}
#[tauri::command]
async fn list_tabs(address: String) -> Result<Vec<Tab>, String> {
    let value = get_json(&endpoint(&address)?, "/json/list").await?;
    let tabs = value.as_array().ok_or("浏览器未返回标签页列表")?;
    Ok(tabs
        .iter()
        .filter(|t| t["type"] == "page")
        .filter(|t| {
            let url = t["url"].as_str().unwrap_or("");
            !url.starts_with("devtools://") && !url.starts_with("chrome-devtools://")
        })
        .map(|t| Tab {
            id: t["id"].as_str().unwrap_or("").into(),
            title: t["title"].as_str().unwrap_or("未命名").into(),
            url: t["url"].as_str().unwrap_or("").into(),
        })
        .collect())
}
#[tauri::command]
async fn select_tab(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    address: String,
    target_id: String,
) -> Result<(), String> {
    let _guard = state.operation.lock().await;
    state.network.stop(None).await?;
    if let Some(previous) = state.connection.write().await.take() {
        previous.shutdown().await;
    }
    let address = endpoint(&address)?;
    let info = get_json(&address, "/json/version").await?;
    let websocket = info["webSocketDebuggerUrl"]
        .as_str()
        .ok_or("浏览器未返回 WebSocket 地址")?;
    let connection = Connection::open(app, address, target_id, websocket).await?;
    *state.connection.write().await = Some(connection);
    Ok(())
}
async fn selected(state: &AppState) -> Result<Arc<Connection>, String> {
    state
        .connection
        .read()
        .await
        .clone()
        .filter(|c| c.alive.load(Ordering::Relaxed))
        .ok_or("请先连接并选择标签页".into())
}
#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let _guard = state.operation.lock().await;
    state.network.stop(None).await?;
    if let Some(connection) = state.connection.write().await.take() {
        connection.shutdown().await;
    }
    Ok(())
}
#[tauri::command]
async fn start_network_listener(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    python: String,
    session_id: String,
    options: network::Options,
) -> Result<(), String> {
    let _guard = state.operation.lock().await;
    let connection = selected(&state).await?;
    connection.set_active(false).await?;
    state
        .network
        .start(app, connection, python, session_id, options)
        .await
}
#[tauri::command]
async fn stop_network_listener(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let _guard = state.operation.lock().await;
    state.network.stop(Some(&session_id)).await
}
#[tauri::command]
async fn set_capture(state: State<'_, AppState>, active: bool) -> Result<(), String> {
    selected(&state).await?.set_active(active).await
}
#[tauri::command]
async fn set_recording(
    state: State<'_, AppState>,
    recording_id: String,
    action: String,
) -> Result<(), String> {
    let _guard = state.operation.lock().await;
    selected(&state)
        .await?
        .set_recording(recording_id, &action)
        .await
}
#[tauri::command]
async fn root_context(state: State<'_, AppState>) -> Result<Value, String> {
    selected(&state).await?.root_context().await
}
#[tauri::command]
async fn highlight(
    state: State<'_, AppState>,
    context: Value,
    tokens: Vec<String>,
    scroll: bool,
) -> Result<(), String> {
    selected(&state)
        .await?
        .highlight(&context, tokens, scroll)
        .await
}

#[tauri::command]
async fn element_geometry(
    state: State<'_, AppState>,
    context: Value,
    token: String,
) -> Result<Value, String> {
    selected(&state)
        .await?
        .element_geometry(&context, &token)
        .await
}

async fn python_request(python: &str, request: Value) -> Result<Value, String> {
    if python.trim().is_empty() {
        return Err("请先选择 Python 虚拟环境中的 python.exe".into());
    }
    let mut command = Command::new(python);
    hidden(&mut command);
    command
        .args([
            "-u",
            "-X",
            "utf8",
            "-c",
            include_str!("../python/adapter.py"),
        ])
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Python：{e}"))?;
    let mut input = child.stdin.take().ok_or("无法打开 Python 输入流")?;
    input
        .write_all(format!("{request}\n").as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    drop(input);
    let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| "DP 校验超过 30 秒，已停止适配器".to_string())?
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err(format!(
            "Python 适配器异常退出（{}）：{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(1200)
                .collect::<String>()
        ));
    }
    let response: Value = serde_json::from_str(text.trim()).map_err(|_| {
        format!(
            "Python 适配器未返回有效 JSON：{}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(1200)
                .collect::<String>()
        )
    })?;
    if response["ok"] == true {
        Ok(response["result"].clone())
    } else {
        Err(response["error"].as_str().unwrap_or("DP 校验失败").into())
    }
}
#[tauri::command]
async fn check_python(python: String) -> Result<Value, String> {
    python_request(&python, json!({"action":"check"})).await
}
#[tauri::command]
async fn query(
    state: State<'_, AppState>,
    python: String,
    context: Value,
    mode: String,
    expression: String,
) -> Result<Value, String> {
    if expression.trim().is_empty() {
        return Err("请输入定位表达式".into());
    }
    if !matches!(mode.as_str(), "CSS" | "XPath" | "DP") {
        return Err("无效的定位模式".into());
    }
    let connection = selected(&state).await?;
    connection.check_context(&context).await?;
    let result=python_request(&python,json!({"action":"query","endpoint":connection.endpoint,"targetId":connection.target,"context":context,"mode":mode,"expression":expression})).await?;
    connection.check_context(&context).await?;
    Ok(result)
}
#[tauri::command]
async fn query_recording_step(
    state: State<'_, AppState>,
    python: String,
    endpoint: String,
    target_id: String,
    steps: Vec<Value>,
    mode: String,
    expression: String,
) -> Result<Value, String> {
    let _guard = state.operation.lock().await;
    if expression.trim().is_empty() || !matches!(mode.as_str(), "CSS" | "XPath" | "DP") {
        return Err("请填写有效的定位表达式和模式".into());
    }
    if steps.iter().any(|step| {
        !matches!(step["kind"].as_str(), Some("frame" | "shadow"))
            || step["selector"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty())
    }) {
        return Err("录制步骤的上下文路径无效".into());
    }
    let connection = selected(&state).await?;
    if connection.endpoint != endpoint || connection.target != target_id {
        return Err("请选择录制来源标签页后再校验".into());
    }
    let root = connection.root_context().await?;
    let mut scope = root.clone();
    scope["steps"] = json!(steps);
    let mut result = python_request(&python, json!({"action":"recording_query",
        "endpoint":endpoint,"targetId":target_id,"context":scope,"mode":mode,"expression":expression})).await?;
    connection.check_context(&root).await?;
    result["context"] = connection.query_context(&result["context"]).await?;
    Ok(result)
}
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json"))
}
#[tauri::command]
async fn load_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.to_string()),
    }
}
#[tauri::command]
async fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(
        path,
        serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
async fn browser_paths() -> Vec<String> {
    let mut paths = Vec::new();
    for (env, suffix) in [
        ("ProgramFiles", r"Google\Chrome\Application\chrome.exe"),
        (
            "ProgramFiles(x86)",
            r"Microsoft\Edge\Application\msedge.exe",
        ),
        ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
    ] {
        if let Some(base) = std::env::var_os(env) {
            let path = PathBuf::from(base).join(suffix);
            if path.is_file() {
                paths.push(path.to_string_lossy().into());
            }
        }
    }
    paths
}
#[tauri::command]
async fn launch_browser(app: tauri::AppHandle, browser: String) -> Result<String, String> {
    let path = PathBuf::from(&browser);
    if !path.is_file() {
        return Err("请选择 Chrome 或 Edge 的可执行文件".into());
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    let profiles = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("browser-profiles");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let profile = profiles.join(format!("session-{stamp}-{port}"));
    tokio::fs::create_dir_all(&profile)
        .await
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(path);
    hidden(&mut command);
    command
        .arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动浏览器失败：{e}"))?;
    let address = format!("http://127.0.0.1:{port}");
    for _ in 0..30 {
        if inspect_browser(address.clone()).await.is_ok() {
            return Ok(address);
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("浏览器启动后退出：{status}"));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("浏览器已启动，但调试端口未就绪，请点击发现或手动连接".into())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(capture_window::CaptureWindow::default())
        .invoke_handler(tauri::generate_handler![
            capture_window::minimize_capture_window,
            capture_window::restore_capture_window,
            desktop_request,
            desktop_capture,
            desktop_highlight,
            inspect_browser,
            discover_browsers,
            list_tabs,
            select_tab,
            disconnect,
            set_capture,
            set_recording,
            start_network_listener,
            stop_network_listener,
            root_context,
            highlight,
            element_geometry,
            check_python,
            query,
            query_recording_step,
            load_settings,
            save_settings,
            browser_paths,
            launch_browser
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    state.desktop.shutdown().await;
                    let _ = tokio::time::timeout(Duration::from_secs(3), disconnect(state)).await;
                    let _ = window.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("ElemLens 启动失败");
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_window_defaults_on_for_new_and_existing_settings() {
        assert!(Settings::default().hide_capture_window);
        let old: Settings = serde_json::from_str(r#"{"python":"python.exe","browser":""}"#).unwrap();
        assert!(old.hide_capture_window);
        let saved = Settings { hide_capture_window: false, ..Settings::default() };
        let json = serde_json::to_value(saved).unwrap();
        assert_eq!(json["hideCaptureWindow"], false);
        let loaded: Settings = serde_json::from_value(json).unwrap();
        assert!(!loaded.hide_capture_window);
    }
    #[test]
    fn local_endpoints() {
        assert_eq!(endpoint("9222").unwrap(), "http://127.0.0.1:9222");
        assert_eq!(
            endpoint("localhost:9321/").unwrap(),
            "http://localhost:9321"
        );
        assert!(endpoint("http://example.com:9222").is_err());
        assert!(endpoint("http://127.0.0.1:9222/path").is_err());
    }
    #[tokio::test]
    async fn bad_python() {
        assert!(
            python_request("this-python-does-not-exist.exe", json!({"action":"check"}))
                .await
                .unwrap_err()
                .contains("无法启动")
        );
    }
}
