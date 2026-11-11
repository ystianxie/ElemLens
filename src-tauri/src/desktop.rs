//! Isolated desktop inspection worker; browser/CDP state is never used.
use crate::desktop_native::{Control, NativeEvent, Rectangle};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as SyncMutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

#[derive(Debug, Serialize)]
pub struct DesktopError {
    kind: String,
    message: String,
}
impl DesktopError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}
impl From<String> for DesktopError {
    fn from(message: String) -> Self {
        Self::new("WorkerError", message)
    }
}
impl From<std::io::Error> for DesktopError {
    fn from(error: std::io::Error) -> Self {
        Self::new("WorkerError", error.to_string())
    }
}
struct Worker {
    _job: crate::desktop_job::WorkerJob,
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    errors: Arc<SyncMutex<String>>,
    python: String,
    backend: String,
    generation: u64,
}
impl Worker {
    async fn start(python: &str, backend: &str, generation: u64) -> Result<Self, DesktopError> {
        if python.trim().is_empty() {
            return Err(DesktopError::new(
                "EnvironmentError",
                "请先配置桌面 Python 环境",
            ));
        }
        if !matches!(backend, "uia" | "win32") {
            return Err(DesktopError::new("LocatorError", "后端只能是 UIA 或 Win32"));
        }
        let job = crate::desktop_job::WorkerJob::new()?;
        let mut command = Command::new(python);
        job.configure(&mut command);
        crate::hidden(&mut command);
        command
            .args([
                "-u",
                "-X",
                "utf8",
                "-c",
                include_str!("../python/desktop_adapter.py"),
            ])
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| {
            DesktopError::new("EnvironmentError", format!("无法启动桌面 Python：{e}"))
        })?;
        job.assign(&child)?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| DesktopError::new("WorkerError", "无法打开桌面控制通道"))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| DesktopError::new("WorkerError", "无法读取桌面结果"))?,
        );
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| DesktopError::new("WorkerError", "无法读取桌面诊断"))?;
        let errors = Arc::new(SyncMutex::new(String::new()));
        let diagnostics = errors.clone();
        tokio::spawn(async move {
            let mut buffer = [0; 2048];
            while let Ok(count) = stderr.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                let mut text = diagnostics.lock().unwrap_or_else(|e| e.into_inner());
                text.push_str(&String::from_utf8_lossy(&buffer[..count]));
                if text.len() > 6000 {
                    let mut cut = text.len() - 4000;
                    while !text.is_char_boundary(cut) {
                        cut += 1;
                    }
                    text.drain(..cut);
                }
            }
        });
        Ok(Self {
            _job: job,
            child,
            input,
            output,
            errors,
            python: python.into(),
            backend: backend.into(),
            generation,
        })
    }
    async fn request(&mut self, mut request: Value, id: u64) -> Result<Value, DesktopError> {
        request["id"] = json!(id);
        request["backend"] = json!(self.backend);
        request["excludePid"] = json!(std::process::id());
        self.input
            .write_all(format!("{}\n", request).as_bytes())
            .await?;
        self.input.flush().await?;
        let mut line = String::new();
        if self.output.read_line(&mut line).await? == 0 {
            let detail = self
                .errors
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            return Err(DesktopError::new(
                "WorkerExited",
                format!("桌面工作进程已退出，请重新检测环境。{detail}"),
            ));
        }
        let response: Value = serde_json::from_str(&line).map_err(|e| {
            DesktopError::new(
                "WorkerProtocolError",
                format!("桌面工作进程返回无效 JSON：{e}"),
            )
        })?;
        if response["id"] != id {
            return Err(DesktopError::new(
                "WorkerProtocolError",
                "桌面响应序号不一致",
            ));
        }
        if response["ok"] == true {
            Ok(response["result"].clone())
        } else {
            Err(DesktopError::new(
                response["errorType"].as_str().unwrap_or("ProviderError"),
                response["error"].as_str().unwrap_or("桌面查询失败"),
            ))
        }
    }
}
#[derive(Default)]
pub struct Inspector {
    monitoring: AtomicBool,
    worker: Mutex<Option<Worker>>,
    native: SyncMutex<Option<Control>>,
    generation: AtomicU64,
    next_id: AtomicU64,
}
impl Inspector {
    fn monitor(&self, app: &tauri::AppHandle) {
        if self.monitoring.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_millis(500));
            loop {
                timer.tick().await;
                if app.get_webview_window("main").is_none() {
                    break;
                }
                let state = app.state::<crate::AppState>();
                let inspector = &state.desktop;
                let Ok(mut slot) = inspector.worker.try_lock() else {
                    continue;
                };
                let exited = slot
                    .as_mut()
                    .is_some_and(|worker| worker.child.try_wait().ok().flatten().is_some());
                if exited {
                    let worker = slot.take().unwrap();
                    inspector.cancel();
                    let _ = app.emit("desktop-worker-stopped", worker.generation);
                }
            }
        });
    }
    fn native(&self, app: &tauri::AppHandle) -> Result<Control, String> {
        let mut native = self.native.lock().map_err(|e| e.to_string())?;
        if native.is_none() {
            // The preview stays in native/Python code; the WebView only handles
            // explicit captures. A watch channel retains at most the newest point.
            let (sender, mut receiver) = tokio::sync::watch::channel(None::<(u64, NativeEvent)>);
            let hover_app = app.clone();
            tauri::async_runtime::spawn(async move {
                while receiver.changed().await.is_ok() {
                    let pending = receiver.borrow_and_update().clone();
                    if let Some((generation, event)) = pending {
                        let state = hover_app.state::<crate::AppState>();
                        state.desktop.hover(&hover_app, generation, event).await;
                    }
                }
            });
            let app = app.clone();
            *native = Some(Control::new(std::process::id(), move |event| {
                if event.kind == "hover" {
                    let generation = app
                        .state::<crate::AppState>()
                        .desktop
                        .generation
                        .load(Ordering::SeqCst);
                    sender.send_replace(Some((generation, event)));
                } else {
                    sender.send_replace(None);
                    let _ = app.emit("desktop-native", event);
                }
            })?);
        }
        Ok(native.as_ref().unwrap().clone())
    }
    async fn hover(&self, app: &tauri::AppHandle, generation: u64, event: NativeEvent) {
        let mut slot = self.worker.lock().await;
        if generation != self.generation.load(Ordering::SeqCst)
            || slot
                .as_ref()
                .is_none_or(|worker| worker.generation != generation)
        {
            return;
        }
        let result = self
            .worker_request(
                app,
                &mut slot,
                generation,
                json!({"action": "hover", "x": event.x, "y": event.y}),
            )
            .await;
        drop(slot);
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        // Session and sequence checks on the native thread also reject a reply
        // arriving after cancellation or after an explicit capture.
        let native = self.native.lock().ok().and_then(|slot| slot.clone());
        if let Some(native) = native {
            let rectangle = result.ok().and_then(|value| {
                if value["visible"] != true {
                    return None;
                }
                serde_json::from_value::<Rectangle>(value["rectangle"].clone()).ok()
            });
            if let Some(rectangle) = rectangle {
                if native
                    .highlight(rectangle, Some(event.session.clone()), event.sequence, 600)
                    .is_err()
                {
                    let _ = native.clear(Some(event.session), event.sequence);
                }
            } else {
                let _ = native.clear(Some(event.session), event.sequence);
            }
        }
    }
    async fn worker_request(
        &self,
        app: &tauri::AppHandle,
        slot: &mut Option<Worker>,
        generation: u64,
        request: Value,
    ) -> Result<Value, DesktopError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let result = tokio::time::timeout(
            Duration::from_secs(12),
            slot.as_mut().unwrap().request(request, id),
        )
        .await;
        let result = match result {
            Ok(result) => result,
            Err(_) => Err(DesktopError::new(
                "Timeout",
                "桌面控件提供程序响应超时，工作进程已重置，请重新检测环境",
            )),
        };
        let reset = result.as_ref().err().is_some_and(|e| {
            matches!(
                e.kind.as_str(),
                "Timeout" | "WorkerExited" | "WorkerError" | "WorkerProtocolError"
            )
        });
        if reset {
            if let Some(mut worker) = slot.take() {
                let _ = worker.child.kill().await;
            }
            self.cancel();
            let _ = app.emit("desktop-worker-stopped", generation);
        }
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err(DesktopError::new("StaleSession", "桌面会话已切换"));
        }
        result
    }
    pub fn cancel(&self) {
        if let Ok(slot) = self.native.lock() {
            if let Some(native) = slot.as_ref() {
                let _ = native.stop();
            }
        }
    }
    pub async fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.cancel();
        if let Some(mut worker) = self.worker.lock().await.take() {
            let _ = worker.child.kill().await;
        }
        if let Ok(mut slot) = self.native.lock() {
            slot.take();
        }
    }
}
#[tauri::command]
pub async fn desktop_request(
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    python: String,
    backend: String,
    generation: u64,
    request: Value,
) -> Result<Value, DesktopError> {
    let inspector = &state.desktop;
    inspector.monitor(&app);
    let action = request["action"].as_str().unwrap_or("");
    if !matches!(
        action,
        "check"
            | "windows"
            | "children"
            | "inspect"
            | "point"
            | "hover"
            | "query"
            | "validate"
            | "load"
            | "save"
    ) {
        return Err(DesktopError::new("RequestError", "不支持的桌面请求"));
    }
    if action == "check" {
        inspector.generation.fetch_max(generation, Ordering::SeqCst);
    }
    if generation != inspector.generation.load(Ordering::SeqCst) {
        return Err(DesktopError::new("StaleSession", "桌面会话已切换"));
    }
    let mut slot = inspector.worker.lock().await;
    if generation != inspector.generation.load(Ordering::SeqCst) {
        return Err(DesktopError::new("StaleSession", "桌面会话已切换"));
    }
    let replace = slot
        .as_ref()
        .is_none_or(|w| w.python != python || w.backend != backend || w.generation != generation);
    if replace {
        inspector.cancel();
        if let Some(mut old) = slot.take() {
            let _ = old.child.kill().await;
        }
        *slot = Some(Worker::start(&python, &backend, generation).await?);
    }
    inspector
        .worker_request(&app, &mut slot, generation, request)
        .await
}
#[tauri::command]
pub async fn desktop_capture(
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    active: bool,
    generation: u64,
    session: String,
    retire: Option<bool>,
) -> Result<(), String> {
    if generation != state.desktop.generation.load(Ordering::SeqCst) {
        return Err("桌面会话已切换".into());
    }
    if !active && retire.unwrap_or(false) {
        state
            .desktop
            .generation
            .compare_exchange(
                generation,
                generation.saturating_add(1),
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| "桌面会话已切换")?;
    }
    let native = state.desktop.native(&app)?;
    tokio::task::spawn_blocking(move || {
        if active {
            native.start(session)
        } else {
            native.stop()
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn desktop_highlight(
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    generation: u64,
    rectangle: Option<Rectangle>,
    session: Option<String>,
    sequence: u64,
    duration: u64,
) -> Result<(), String> {
    if generation != state.desktop.generation.load(Ordering::SeqCst) {
        return Err("桌面会话已切换".into());
    }
    let native = state.desktop.native(&app)?;
    match rectangle {
        Some(rectangle) => native.highlight(rectangle, session, sequence, duration),
        None => native.clear(session, sequence),
    }
}

#[cfg(all(test, windows))]
mod acceptance {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    #[tokio::test]
    #[ignore = "Requires ELEMLENS_DESKTOP_TEST_PYTHON with the desktop runtime installed"]
    async fn dropping_worker_stops_the_venv_interpreter_too() {
        let python =
            std::env::var("ELEMLENS_DESKTOP_TEST_PYTHON").expect("Set the test Python environment");
        let mut worker = Worker::start(&python, "uia", 1).await.unwrap();
        let info = tokio::time::timeout(
            Duration::from_secs(15),
            worker.request(json!({"action":"check"}), 1),
        )
        .await
        .unwrap()
        .unwrap();
        let pid = info["process"].as_u64().unwrap() as u32;
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!process.is_null());
        drop(worker);
        let exited = unsafe { WaitForSingleObject(process, 4000) };
        unsafe {
            CloseHandle(process);
        }
        assert_eq!(
            exited, WAIT_OBJECT_0,
            "The actual Python interpreter must exit with its launcher"
        );
    }
}
