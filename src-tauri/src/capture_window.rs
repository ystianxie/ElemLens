use std::time::Duration;
use tauri::{State, WebviewWindow};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct CaptureWindow {
    session: Mutex<Option<String>>,
}

#[tauri::command]
pub async fn minimize_capture_window(
    window: WebviewWindow,
    state: State<'_, CaptureWindow>,
    session: String,
) -> Result<(), String> {
    let mut owner = state.session.lock().await;
    // Only restore windows minimized by this feature, including a newer preview.
    if owner.is_none() && window.is_minimized().map_err(|e| e.to_string())? {
        return Ok(());
    }
    window.minimize().map_err(|e| e.to_string())?;
    *owner = Some(session);
    Ok(())
}

#[tauri::command]
pub async fn restore_capture_window(
    window: WebviewWindow,
    state: State<'_, CaptureWindow>,
    session: String,
    delay_ms: u64,
) -> Result<(), String> {
    // Native timing continues while the WebView is minimized.
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms.min(5000))).await;
    }
    let mut owner = state.session.lock().await;
    // An older capture or timer must not interrupt a newer capture/preview.
    if owner.as_deref() != Some(session.as_str()) {
        return Ok(());
    }
    window.unminimize().map_err(|e| e.to_string())?;
    *owner = None;
    window.set_focus().map_err(|e| e.to_string())
}
