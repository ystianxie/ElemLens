use crate::cdp::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    process::Stdio,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::Emitter;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, watch, Mutex},
    time::Instant,
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub targets: Vec<String>,
    pub count: Option<u32>,
    pub timeout: Option<f64>,
    pub fit_count: bool,
    pub method: String,
}
impl Options {
    fn validate(&self) -> Result<(), String> {
        if self.targets.is_empty() || self.targets.iter().any(|s| s.trim().is_empty()) {
            return Err("请至少填写一个非空 URL 关键词".into());
        }
        if self.count == Some(0) {
            return Err("捕获条数必须为正整数".into());
        }
        if self.timeout.is_some_and(|t| !t.is_finite() || t <= 0.0) {
            return Err("超时必须为正数，留空表示不限".into());
        }
        if !matches!(
            self.method.as_str(),
            "ALL" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
        ) {
            return Err("无效的请求方法".into());
        }
        Ok(())
    }
}
struct Session {
    id: String,
    stop: mpsc::Sender<()>,
    done: watch::Receiver<bool>,
}
#[derive(Default)]
pub struct Listener {
    active: Mutex<Option<Session>>,
}
impl Listener {
    pub async fn stop(&self, expected: Option<&str>) -> Result<(), String> {
        let session = {
            let mut active = self.active.lock().await;
            if expected.is_some_and(|id| active.as_ref().is_some_and(|s| s.id != id)) {
                return Ok(());
            }
            active.take()
        };
        if let Some(mut session) = session {
            if !*session.done.borrow() {
                let _ = session.stop.send(()).await;
                tokio::time::timeout(Duration::from_secs(4), session.done.wait_for(|done| *done))
                    .await
                    .map_err(|_| "结束监听超时".to_string())?
                    .map_err(|_| "监听会话已退出".to_string())?;
            }
        }
        Ok(())
    }
    pub async fn start(
        &self,
        app: tauri::AppHandle,
        connection: Arc<Connection>,
        python: String,
        id: String,
        options: Options,
    ) -> Result<(), String> {
        options.validate()?;
        if python.trim().is_empty() {
            return Err("请先配置 Python 环境".into());
        }
        if id.is_empty() || id.len() > 128 {
            return Err("无效的监听会话".into());
        }
        self.stop(None).await?;
        let mut command = Command::new(python);
        crate::hidden(&mut command);
        command
            .args([
                "-u",
                "-X",
                "utf8",
                "-c",
                include_str!("../python/network_listener.py"),
            ])
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| format!("无法启动监听：{e}"))?;
        let mut input = child.stdin.take().ok_or("无法打开监听控制通道")?;
        let request = json!({"endpoint":connection.endpoint,"targetId":connection.target,"options":{
            "targets":options.targets,"count":options.count,"timeout":options.timeout,"fitCount":options.fit_count,"method":options.method
        }});
        input
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut lines = BufReader::new(child.stdout.take().ok_or("无法打开监听输出")?).lines();
        let mut stderr = child.stderr.take().ok_or("无法打开监听错误输出")?;
        let errors = tokio::spawn(async move {
            let mut saved = Vec::new();
            let mut buffer = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                saved.extend_from_slice(&buffer[..n.min(4000usize.saturating_sub(saved.len()))]);
            }
            String::from_utf8_lossy(&saved).into_owned()
        });
        let (stop, mut stop_rx) = mpsc::channel(1);
        let (done_tx, done) = watch::channel(false);
        *self.active.lock().await = Some(Session {
            id: id.clone(),
            stop,
            done,
        });
        tokio::spawn(async move {
            let send = |kind: &str, data: Value| {
                let _ = app.emit("network-event", json!({"sessionId":id,"endpoint":connection.endpoint,"targetId":connection.target,"kind":kind,"data":data}));
            };
            let mut tick = tokio::time::interval(Duration::from_millis(200));
            let startup_deadline = Instant::now() + Duration::from_secs(20);
            let mut stop_deadline = None;
            let mut ready = false;
            let mut terminal = false;
            let mut failure = None;
            loop {
                tokio::select! {
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                            Ok(event) => {
                                let kind = event["kind"].as_str().unwrap_or("");
                                if kind == "ready" { ready = true; }
                                if kind == "finished" || kind == "error" { terminal = true; }
                                if matches!(kind, "ready" | "packet" | "finished" | "error") { send(kind, event["data"].clone()); }
                            }
                            Err(_) => { failure = Some("监听器返回了无效数据".to_string()); break; }
                        },
                        Ok(None) => break,
                        Err(e) => { failure = Some(format!("读取监听结果失败：{e}")); break; }
                    },
                    _ = stop_rx.recv(), if stop_deadline.is_none() => {
                        let _ = input.write_all(b"stop\n").await;
                        stop_deadline = Some(Instant::now() + Duration::from_secs(2));
                    },
                    _ = tick.tick() => {
                        if !connection.alive.load(Ordering::Relaxed) && stop_deadline.is_none() {
                            let _ = input.write_all(b"stop\n").await;
                            stop_deadline = Some(Instant::now() + Duration::from_secs(2));
                        }
                        if stop_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                            if !terminal { send("finished", json!({"reason":"stopped"})); terminal = true; }
                            break;
                        }
                        if !ready && stop_deadline.is_none() && Instant::now() >= startup_deadline {
                            failure = Some("启动监听超过 20 秒，请检查 Python 环境和目标标签页".into());
                            break;
                        }
                    }
                }
            }
            if tokio::time::timeout(Duration::from_secs(1), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
            let details = errors.await.unwrap_or_default();
            if !terminal {
                let message = failure.unwrap_or_else(|| {
                    if details.trim().is_empty() {
                        "监听器意外退出".into()
                    } else {
                        details.chars().take(1200).collect()
                    }
                });
                send("error", json!({"message":message}));
            }
            let _ = done_tx.send(true);
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_listener_options() {
        let mut options = Options {
            targets: vec!["api/user".into(), "api/order".into()],
            count: Some(1),
            timeout: None,
            fit_count: true,
            method: "ALL".into(),
        };
        assert!(options.validate().is_ok());
        options.count = Some(0);
        assert!(options.validate().is_err());
        options.count = None;
        options.timeout = Some(0.0);
        assert!(options.validate().is_err());
        options.timeout = None;
        options.targets.clear();
        assert!(options.validate().is_err());
    }
}
