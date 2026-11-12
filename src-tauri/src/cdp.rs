use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Emitter;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

type Reply = oneshot::Sender<Result<Value, String>>;
const AGENT: &str = include_str!("../../src/agent.js");

pub struct Client {
    sender: mpsc::Sender<Message>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    next: AtomicU64,
    pub events: broadcast::Sender<Value>,
}
impl Client {
    pub async fn connect(url: &str) -> Result<Arc<Self>, String> {
        let (socket, _) = tokio::time::timeout(Duration::from_secs(5), connect_async(url))
            .await
            .map_err(|_| "CDP 连接超时")?
            .map_err(|e| format!("CDP 连接失败：{e}"))?;
        let (mut writer, mut reader) = socket.split();
        let (sender, mut outgoing) = mpsc::channel::<Message>(128);
        let (events, _) = broadcast::channel(2048);
        let pending = Arc::new(Mutex::new(HashMap::<u64, Reply>::new()));
        let client = Arc::new(Self {
            sender,
            pending: pending.clone(),
            next: AtomicU64::new(1),
            events: events.clone(),
        });
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    outgoing = outgoing.recv() => match outgoing {
                        Some(message) => {let close = matches!(&message, Message::Close(_)); if writer.send(message).await.is_err() || close { break; }},
                        None => break,
                    },
                    incoming = reader.next() => match incoming {
                        Some(Ok(Message::Text(text))) => if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            if let Some(id) = value["id"].as_u64() {
                                if let Some(reply) = pending.lock().await.remove(&id) {
                                    let result = if let Some(error) = value.get("error") {Err(error["message"].as_str().unwrap_or("CDP 请求失败").into())} else {Ok(value["result"].clone())};
                                    let _ = reply.send(result);
                                }
                            } else {let _ = events.send(value);}
                        },
                        Some(Ok(Message::Ping(bytes))) => {let _ = writer.send(Message::Pong(bytes)).await;},
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {},
                    }
                }
            }
            for (_, reply) in pending.lock().await.drain() {
                let _ = reply.send(Err("浏览器调试连接已断开".into()));
            }
            let _ = events.send(json!({"method":"ElemLens.disconnected"}));
        });
        Ok(client)
    }
    pub async fn call(&self, session: &str, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        let mut command = json!({"id":id,"method":method,"params":params});
        if !session.is_empty() {
            command["sessionId"] = json!(session);
        }
        if self
            .sender
            .send(Message::Text(command.to_string().into()))
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err("CDP 连接已关闭".into());
        }
        let result = tokio::time::timeout(Duration::from_secs(8), receiver).await;
        self.pending.lock().await.remove(&id);
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("CDP 响应已中断".into()),
            Err(_) => Err(format!("CDP 请求超时：{method}")),
        }
    }
    pub async fn close(&self) {
        let _ = self.sender.send(Message::Close(None)).await;
    }
}

mod freeze;

#[derive(Clone)]
struct Context {
    session: String,
    id: i64,
    frame: String,
}
#[derive(Default)]
struct Inner {
    root: String,
    contexts: HashMap<(String, i64), Context>,
    parents: HashMap<String, String>,
    scripts: HashMap<String, String>,
}
pub struct Connection {
    pub client: Arc<Client>,
    inner: RwLock<Inner>,
    active: AtomicBool,
    capture_scope: RwLock<Option<Value>>,
    freeze_armed: AtomicBool,
    frozen: AtomicBool,
    freeze: Mutex<freeze::FreezeState>,
    recording: AtomicBool,
    recording_receiving: AtomicBool,
    recording_id: Mutex<String>,
    recording_version: AtomicU64,
    recording_operation: Mutex<()>,
    recording_barriers: Mutex<HashMap<String, oneshot::Sender<()>>>,
    pub alive: AtomicBool,
    pub endpoint: String,
    pub target: String,
    app: tauri::AppHandle,
}
impl Connection {
    pub async fn open(
        app: tauri::AppHandle,
        endpoint: String,
        target: String,
        websocket: &str,
    ) -> Result<Arc<Self>, String> {
        let client = Client::connect(websocket).await?;
        let mut events = client.events.subscribe();
        let connection = Arc::new(Self {
            client,
            inner: RwLock::new(Inner::default()),
            active: AtomicBool::new(false),
            capture_scope: RwLock::new(None),
            freeze_armed: AtomicBool::new(false),
            frozen: AtomicBool::new(false),
            freeze: Mutex::new(freeze::FreezeState::default()),
            recording: AtomicBool::new(false),
            recording_receiving: AtomicBool::new(false),
            recording_id: Mutex::new(String::new()),
            recording_version: AtomicU64::new(0),
            recording_operation: Mutex::new(()),
            recording_barriers: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            endpoint,
            target,
            app,
        });
        let weak = Arc::downgrade(&connection);
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        let Some(connection) = weak.upgrade() else {
                            break;
                        };
                        if !connection.alive.load(Ordering::Relaxed) {
                            break;
                        }
                        connection.handle(event).await;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(c) = weak.upgrade() {
                            c.emit("error", json!("浏览器事件过多，请重新连接标签页"));
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let result = connection
            .client
            .call(
                "",
                "Target.attachToTarget",
                json!({"targetId":connection.target,"flatten":true}),
            )
            .await;
        match result {
            Ok(result) => {
                let root = result["sessionId"]
                    .as_str()
                    .ok_or("浏览器未返回会话 ID")?
                    .to_string();
                connection.inner.write().await.root = root.clone();
                if let Err(error) = connection.setup(&root).await {
                    connection.shutdown().await;
                    return Err(error);
                }
                Ok(connection)
            }
            Err(error) => {
                connection.shutdown().await;
                Err(error)
            }
        }
    }
    fn emit(&self, kind: &str, data: Value) {
        let _ = self.app.emit(
            "browser-event",
            json!({"targetId":self.target,"endpoint":self.endpoint,"kind":kind,"data":data}),
        );
    }
    async fn setup(&self, session: &str) -> Result<(), String> {
        self.client
            .call(
                session,
                "Runtime.addBinding",
                json!({"name":"__elemlens_bridge"}),
            )
            .await?;
        self.client.call(session, "Page.enable", json!({})).await?;
        self.client.call(session, "DOM.enable", json!({})).await?;
        let script = self
            .client
            .call(
                session,
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source":AGENT}),
            )
            .await?;
        if let Some(id) = script["identifier"].as_str() {
            self.inner
                .write()
                .await
                .scripts
                .insert(session.into(), id.into());
        }
        self.client
            .call(session, "Runtime.enable", json!({}))
            .await?;
        if let Ok(tree) = self
            .client
            .call(session, "Page.getFrameTree", json!({}))
            .await
        {
            self.read_tree(&tree["frameTree"], "").await;
        }
        self.client
            .call(
                session,
                "Target.setAutoAttach",
                json!({"autoAttach":true,"waitForDebuggerOnStart":false,"flatten":true}),
            )
            .await?;
        Ok(())
    }
    async fn read_tree(&self, tree: &Value, parent: &str) {
        let mut stack = vec![(tree.clone(), parent.to_string())];
        let mut inner = self.inner.write().await;
        while let Some((node, parent)) = stack.pop() {
            if let Some(id) = node["frame"]["id"].as_str() {
                if !parent.is_empty() {
                    inner.parents.insert(id.into(), parent);
                }
                if let Some(children) = node["childFrames"].as_array() {
                    for child in children {
                        stack.push((child.clone(), id.into()));
                    }
                }
            }
        }
    }
    async fn handle(self: &Arc<Self>, event: Value) {
        let session = event["sessionId"].as_str().unwrap_or("").to_string();
        let params = &event["params"];
        match event["method"].as_str().unwrap_or("") {
            "Target.attachedToTarget" if params["targetInfo"]["type"] == "iframe" => {
                let session = params["sessionId"].as_str().unwrap_or("").to_string();
                let connection = self.clone();
                tokio::spawn(async move {
                    if let Err(e) = connection.setup(&session).await {
                        connection.emit("error", json!(format!("iframe 接入失败：{e}")));
                    }
                });
            }
            "Runtime.executionContextCreated" => {
                let context = &params["context"];
                if context["auxData"]["isDefault"] != true {
                    return;
                }
                let Some(id) = context["id"].as_i64() else {
                    return;
                };
                let Some(frame) = context["auxData"]["frameId"].as_str() else {
                    return;
                };
                let context = Context {
                    session: session.clone(),
                    id,
                    frame: frame.into(),
                };
                self.inner
                    .write()
                    .await
                    .contexts
                    .insert((session.clone(), id), context.clone());
                let connection = self.clone();
                tokio::spawn(async move {
                    let script = format!(
                        "{AGENT}\nwindow.__elemlens_v1.setCaptureScope({});window.__elemlens_v1.setActive({});window.__elemlens_v1.setFreezeArmed({});",
                        connection.capture_scope_config().await,
                        connection.active.load(Ordering::Relaxed),
                        connection.freeze_armed.load(Ordering::Relaxed)
                    );
                    if let Err(e) = connection.evaluate(&context, &script).await {
                        if connection.alive.load(Ordering::Relaxed) {
                            connection.emit("error", json!(format!("页面初始化失败：{e}")));
                        }
                    }
                    if connection.recording.load(Ordering::Relaxed) {
                        let version = connection.recording_version.load(Ordering::Relaxed);
                        if let Err(e) = connection.configure_recording(&context, version).await {
                            connection
                                .emit("recording-warning", json!(format!("新页面录制未就绪：{e}")));
                        }
                    }
                });
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = params["executionContextId"].as_i64() {
                    self.inner.write().await.contexts.remove(&(session, id));
                }
                self.cancel_freeze_on_navigation();
                self.emit("invalidated", Value::Null);
            }
            "Runtime.executionContextsCleared" => {
                self.inner
                    .write()
                    .await
                    .contexts
                    .retain(|(s, _), _| s != &session);
                self.cancel_freeze_on_navigation();
                self.emit("invalidated", Value::Null);
            }
            "Page.frameAttached" => {
                if let (Some(id), Some(parent)) =
                    (params["frameId"].as_str(), params["parentFrameId"].as_str())
                {
                    self.inner
                        .write()
                        .await
                        .parents
                        .insert(id.into(), parent.into());
                }
            }
            "Page.frameNavigated" => {
                if let (Some(id), Some(parent)) = (
                    params["frame"]["id"].as_str(),
                    params["frame"]["parentId"].as_str(),
                ) {
                    self.inner
                        .write()
                        .await
                        .parents
                        .insert(id.into(), parent.into());
                }
            }
            "Target.detachedFromTarget" => {
                let detached = params["sessionId"].as_str().unwrap_or("");
                let mut inner = self.inner.write().await;
                inner.contexts.retain(|(s, _), _| s != detached);
                inner.scripts.remove(detached);
                if inner.root == detached {
                    drop(inner);
                    self.alive.store(false, Ordering::Relaxed);
                    self.emit("disconnected", Value::Null);
                    self.client.close().await;
                } else {
                    drop(inner);
                    self.cancel_freeze_on_navigation();
                    self.emit("invalidated", Value::Null);
                }
            }
            "Overlay.inspectNodeRequested" => {
                if self.frozen.load(Ordering::Relaxed) && self.active.load(Ordering::Relaxed) {
                    if let Some(node) = params["backendNodeId"].as_i64() {
                        let connection = self.clone();
                        tokio::spawn(async move {
                            if let Err(e) = connection.capture_frozen_node(&session, node).await {
                                let _ = connection.set_active(false).await;
                                connection.emit("error", json!(e));
                            }
                        });
                    }
                }
            }
            "Overlay.inspectModeCanceled" => {
                if self.frozen.load(Ordering::Relaxed) && self.active.load(Ordering::Relaxed) {
                    let connection = self.clone();
                    tokio::spawn(async move {
                        let _ = connection.set_active(false).await;
                        connection.emit("cancel", Value::Null);
                    });
                }
            }
            "Runtime.bindingCalled" if params["name"] == "__elemlens_bridge" => {
                let Some(id) = params["executionContextId"].as_i64() else {
                    return;
                };
                let Ok(payload) =
                    serde_json::from_str::<Value>(params["payload"].as_str().unwrap_or(""))
                else {
                    return;
                };
                if payload["type"] == "recordingBarrier" {
                    if let Some(key) = payload["id"].as_str() {
                        if let Some(sender) = self.recording_barriers.lock().await.remove(key) {
                            let _ = sender.send(());
                        }
                    }
                    return;
                }
                if payload["type"] == "recording" || payload["type"] == "recordingWarning" {
                    // Events contain their context snapshot already. A navigation may
                    // have destroyed the execution context by the time they arrive.
                    let recording_id = self.recording_id.lock().await;
                    if self.recording_receiving.load(Ordering::Relaxed)
                        && !recording_id.is_empty()
                        && payload["recordingId"].as_str() == Some(recording_id.as_str())
                    {
                        self.emit(
                            if payload["type"] == "recording" {
                                "recording-step"
                            } else {
                                "recording-warning"
                            },
                            payload,
                        );
                    }
                    return;
                }
                let Some(context) = self
                    .inner
                    .read()
                    .await
                    .contexts
                    .get(&(session, id))
                    .cloned()
                else {
                    return;
                };
                let connection = self.clone();
                tokio::spawn(async move {
                    if payload["type"] == "freeze" {
                        if let Err(e) = connection.confirm_freeze().await {
                            connection.emit("error", json!(e));
                        }
                        return;
                    }
                    if payload["type"] == "freezeCancel" {
                        if let Err(e) = connection.set_freeze(false).await {
                            connection.emit("error", json!(e));
                        }
                        return;
                    }
                    if payload["type"] == "captureRejected" {
                        if connection.active.load(Ordering::Relaxed) {
                            connection.emit("capture-rejected", payload["message"].clone());
                        }
                        return;
                    }
                    if payload["type"] == "cancel" {
                        let _ = connection.set_active(false).await;
                        connection.emit("cancel", Value::Null);
                        return;
                    }
                    if payload["type"] != "capture"
                        || !connection.active.swap(false, Ordering::Relaxed)
                    {
                        return;
                    }
                    match connection
                        .capture_context(
                            &context,
                            payload["steps"].as_array().cloned().unwrap_or_default(),
                        )
                        .await
                    {
                        Ok(context_value) => {
                            let _ = connection.set_active(false).await;
                            connection.emit(
                                "capture",
                                json!({"context":context_value,"element":payload["element"]}),
                            );
                        }
                        Err(e) => {
                            let _ = connection.set_active(false).await;
                            connection.emit("error", json!(e));
                        }
                    }
                });
            }
            "ElemLens.disconnected" => {
                self.alive.store(false, Ordering::Relaxed);
                self.emit("disconnected", Value::Null);
            }
            _ => {}
        }
    }
    async fn evaluate(&self, context: &Context, expression: &str) -> Result<Value, String> {
        let result = self.client.call(&context.session,"Runtime.evaluate",json!({"contextId":context.id,"expression":expression,"returnByValue":true,"awaitPromise":true})).await?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(exception["exception"]["description"]
                .as_str()
                .or(exception["text"].as_str())
                .unwrap_or("页面脚本执行失败")
                .into());
        }
        Ok(result["result"]["value"].clone())
    }
    pub async fn set_active(&self, active: bool) -> Result<(), String> {
        if active && self.recording.load(Ordering::Relaxed) {
            return Err("请先暂停录制，再捕获单个元素".into());
        }
        if active && self.freeze_armed.load(Ordering::Relaxed) {
            return Err("请先确认或取消冻结，再捕获元素".into());
        }
        self.active.store(active, Ordering::Relaxed);
        let contexts: Vec<_> = self.inner.read().await.contexts.values().cloned().collect();
        if active && contexts.is_empty() {
            return Err("页面尚未就绪，请稍后重试".into());
        }
        let scope = self.capture_scope_config().await;
        for context in contexts {
            let _ = self.evaluate(&context, &format!(
                "window.__elemlens_v1?.setCaptureScope({scope});window.__elemlens_v1?.setActive({active})"
            )).await;
        }
        if self.frozen.load(Ordering::Relaxed) {
            self.set_frozen_picker(active).await?;
        }
        Ok(())
    }
    async fn capture_scope_config(&self) -> Value {
        match self.capture_scope.read().await.as_ref() {
            Some(scope) => json!({"documentToken":scope["documentToken"],"token":scope["parents"].as_array().and_then(|p| p.last()).map(|p| p["token"].clone())}),
            None => Value::Null,
        }
    }
    pub async fn set_capture_scope(&self, scope: Option<Value>) -> Result<(), String> {
        if let Some(value) = &scope {
            let context = self.check_context(value).await?.context;
            let token = value["parents"].as_array().and_then(|p| p.last()).and_then(|p| p["token"].as_str()).ok_or("父级标识不可用，请重新校验")?;
            let config = json!({"documentToken":value["documentToken"],"token":token});
            if self.evaluate(&context, &format!("window.__elemlens_v1.setCaptureScope({config})")).await? != true {
                return Err("父级元素已失效，请重新校验".into());
            }
        }
        *self.capture_scope.write().await = scope;
        Ok(())
    }
    async fn capture_context(&self, context: &Context, steps: Vec<Value>) -> Result<Value, String> {
        let mut value = self.context_value(context, steps).await?;
        if let Some(scope) = self.capture_scope.read().await.as_ref() {
            if value["documentToken"] != scope["documentToken"] || value["steps"] != scope["steps"] {
                return Err("不支持跨 iframe / Shadow Root 捕获，请返回对应查找上下文".into());
            }
            value["parents"] = scope["parents"].clone();
        }
        Ok(value)
    }
    async fn configure_recording(&self, context: &Context, version: u64) -> Result<(), String> {
        let context_value = self.context_value(context, vec![]).await?;
        let recording_id = self.recording_id.lock().await.clone();
        if !self.recording.load(Ordering::Relaxed)
            || version != self.recording_version.load(Ordering::Relaxed)
        {
            return Ok(());
        }
        self.evaluate(
            context,
            &format!(
                "window.__elemlens_v1.setRecording({}, {version})",
                json!({"id":recording_id,"context":context_value})
            ),
        )
        .await?;
        Ok(())
    }

    pub async fn set_recording(&self, recording_id: String, action: &str) -> Result<(), String> {
        let _operation = self.recording_operation.lock().await;
        if recording_id.is_empty() || !matches!(action, "start" | "resume" | "pause" | "stop") {
            return Err("无效的录制命令".into());
        }
        if action != "start" && *self.recording_id.lock().await != recording_id {
            return Err("录制会话已改变，请重新开始".into());
        }
        let enable = matches!(action, "start" | "resume");
        if enable && (self.frozen.load(Ordering::Relaxed) || self.freeze_armed.load(Ordering::Relaxed)) {
            return Err("请先解除或取消冻结，再开始录制".into());
        }
        let contexts: Vec<_> = self.inner.read().await.contexts.values().cloned().collect();
        if enable && contexts.is_empty() {
            return Err("页面尚未就绪，请稍后开始录制".into());
        }
        if enable {
            self.set_active(false).await?;
        }
        *self.recording_id.lock().await = recording_id;
        self.recording.store(enable, Ordering::Relaxed);
        if enable {
            self.recording_receiving.store(true, Ordering::Relaxed);
        }
        let version = self.recording_version.fetch_add(1, Ordering::Relaxed) + 1;
        let mut ready = 0;
        let mut failures = Vec::new();
        for context in contexts {
            if enable {
                match self.configure_recording(&context, version).await {
                    Ok(()) => ready += 1,
                    Err(e) => failures.push(e),
                }
            } else {
                // The marker travels through the same ordered event stream as steps.
                // Waiting for it drains the final input before pause/stop returns.
                let key = format!("{version}:{}:{}", context.session, context.id);
                let (sender, receiver) = oneshot::channel();
                self.recording_barriers
                    .lock()
                    .await
                    .insert(key.clone(), sender);
                let script = format!(
                    "window.__elemlens_v1?.setRecording(null,{version});window.__elemlens_bridge(JSON.stringify({}));",
                    json!({"type":"recordingBarrier","id":key})
                );
                match self.evaluate(&context, &script).await {
                    Ok(_) => {
                        if !matches!(
                            tokio::time::timeout(Duration::from_secs(3), receiver).await,
                            Ok(Ok(()))
                        ) {
                            failures.push("收取末尾操作超时，请检查最后一步".into());
                        }
                    }
                    Err(e) => {
                        if self
                            .inner
                            .read()
                            .await
                            .contexts
                            .contains_key(&(context.session.clone(), context.id))
                        {
                            failures.push(format!("末尾操作未能确认：{e}"));
                        }
                    }
                }
                self.recording_barriers.lock().await.remove(&key);
            }
        }
        if !enable {
            self.recording_receiving.store(false, Ordering::Relaxed);
        }
        if enable && ready == 0 {
            self.recording.store(false, Ordering::Relaxed);
            self.recording_receiving.store(false, Ordering::Relaxed);
            let cancelled_version = self.recording_version.fetch_add(1, Ordering::Relaxed) + 1;
            let current: Vec<_> = self.inner.read().await.contexts.values().cloned().collect();
            for context in current {
                let _ = self
                    .evaluate(
                        &context,
                        &format!("window.__elemlens_v1?.setRecording(null,{cancelled_version})"),
                    )
                    .await;
            }
            return Err(format!("无法开始录制：{}", failures.join("；")));
        }
        if !failures.is_empty() {
            self.emit(
                "recording-warning",
                json!(format!("部分页面录制受限：{}", failures.join("；"))),
            );
        }
        Ok(())
    }

    pub async fn root_context(&self) -> Result<Value, String> {
        let inner = self.inner.read().await;
        let context = inner
            .contexts
            .values()
            .find(|c| c.session == inner.root && !inner.parents.contains_key(&c.frame))
            .cloned()
            .ok_or("页面尚未就绪，请稍后重试")?;
        drop(inner);
        self.context_value(&context, vec![]).await
    }
    async fn context_value(
        &self,
        context: &Context,
        shadow_steps: Vec<Value>,
    ) -> Result<Value, String> {
        let mut chain = Vec::new();
        let mut frame = context.frame.clone();
        let mut anchor = context.clone();
        {
            let inner = self.inner.read().await;
            while let Some(parent) = inner.parents.get(&frame) {
                let owner = inner
                    .contexts
                    .values()
                    .find(|c| &c.frame == parent)
                    .cloned()
                    .ok_or("父 iframe 上下文尚未就绪，请重新捕获")?;
                anchor = owner.clone();
                chain.push((frame.clone(), owner));
                frame = parent.clone();
                if chain.len() > 32 {
                    return Err("iframe 层级异常".into());
                }
            }
        }
        // PDF viewers can live in an attached target absent from the outer frame tree.
        // Replay selectors from the target owning the first document in this chain.
        let target_info = self
            .client
            .call(&anchor.session, "Target.getTargetInfo", json!({}))
            .await?;
        let target_id = target_info["targetInfo"]["targetId"]
            .as_str()
            .ok_or("无法确定定位上下文所属文档")?;
        let mut steps = Vec::new();
        for (frame, parent) in chain.into_iter().rev() {
            let owner = self
                .client
                .call(
                    &parent.session,
                    "DOM.getFrameOwner",
                    json!({"frameId":frame}),
                )
                .await?;
            let resolved = self
                .client
                .call(
                    &parent.session,
                    "DOM.resolveNode",
                    json!({"backendNodeId":owner["backendNodeId"],"executionContextId":parent.id}),
                )
                .await?;
            let object = resolved["object"]["objectId"]
                .as_str()
                .ok_or("无法解析 iframe 宿主")?;
            let result = self.client.call(&parent.session,"Runtime.callFunctionOn",json!({"objectId":object,"functionDeclaration":"function(){const a=window.__elemlens_v1;return [...a.scopeSteps(this),{kind:'frame',selector:a.uniqueCss(this)}]}","returnByValue":true})).await;
            let _ = self
                .client
                .call(
                    &parent.session,
                    "Runtime.releaseObject",
                    json!({"objectId":object}),
                )
                .await;
            let result = result?;
            let values = result["result"]["value"]
                .as_array()
                .ok_or("无法确定 iframe 定位路径")?;
            steps.extend(values.clone());
        }
        steps.extend(shadow_steps);
        let token = self
            .evaluate(context, "window.__elemlens_v1?.documentToken")
            .await?;
        if !token.is_string() {
            return Err("捕获脚本尚未就绪，请重试".into());
        }
        Ok(
            json!({"sessionId":context.session,"contextId":context.id,"frameId":context.frame,"documentToken":token,"targetId":target_id,"steps":steps}),
        )
    }
    // Resolve the live document reached by replaying a saved scope path.
    // Execution-context ids from the recording may belong to an earlier load.
    pub async fn query_context(&self, value: &Value) -> Result<Value, String> {
        let token = value["documentToken"]
            .as_str()
            .ok_or("校验未返回有效文档")?;
        let contexts: Vec<_> = self.inner.read().await.contexts.values().cloned().collect();
        for context in contexts {
            if let Ok(current) = self
                .evaluate(&context, "window.__elemlens_v1?.documentToken")
                .await
            {
                if current.as_str() == Some(token) {
                    let mut result = value.clone();
                    result["sessionId"] = json!(context.session);
                    result["contextId"] = json!(context.id);
                    result["frameId"] = json!(context.frame);
                    self.check_context(&result).await?;
                    return Ok(result);
                }
            }
        }
        Err("校验期间文档已变化，请重试".into())
    }
    pub async fn check_context(&self, value: &Value) -> Result<ContextRef, String> {
        let session = value["sessionId"]
            .as_str()
            .ok_or("无效的页面上下文")?
            .to_string();
        let id = value["contextId"].as_i64().ok_or("无效的页面上下文")?;
        let context = self
            .inner
            .read()
            .await
            .contexts
            .get(&(session.clone(), id))
            .cloned()
            .ok_or("页面已刷新，请重新捕获或选择标签页")?;
        let token = self
            .evaluate(&context, "window.__elemlens_v1?.documentToken")
            .await?;
        if token != value["documentToken"] {
            return Err("页面已刷新，请重新捕获".into());
        }
        Ok(ContextRef { context })
    }
    pub async fn highlight(
        &self,
        value: &Value,
        tokens: Vec<String>,
        scroll: bool,
    ) -> Result<(), String> {
        let context = self.check_context(value).await?.context;
        self.evaluate(
            &context,
            &format!(
                "window.__elemlens_v1.highlight({}, {scroll})",
                json!(tokens)
            ),
        )
        .await?;
        Ok(())
    }
    pub async fn clear_highlights(&self) -> Result<(), String> {
        let contexts: Vec<_> = self.inner.read().await.contexts.values().cloned().collect();
        for context in contexts {
            self.evaluate(&context, "window.__elemlens_v1?.highlight([], false)")
                .await?;
        }
        Ok(())
    }
    /// Convert the element's frame viewport rectangle to the selected page viewport.
    pub async fn element_geometry(&self, value: &Value, token: &str) -> Result<Value, String> {
        let original = self.check_context(value).await?.context;
        let rect = self
            .evaluate(
                &original,
                &format!("window.__elemlens_v1.measure({})", json!(token)),
            )
            .await?;
        let number = |key: &str| rect[key].as_f64().ok_or("元素位置不可用");
        let (x, y, w, h) = (
            number("x")?,
            number("y")?,
            number("width")?,
            number("height")?,
        );
        let mut points = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        let mut current = original;
        let mut reached_page = false;
        for _ in 0..32 {
            let tree = self
                .client
                .call(&current.session, "Page.getFrameTree", json!({}))
                .await?;
            let root_frame = tree["frameTree"]["frame"]["id"]
                .as_str()
                .ok_or("页面 frame 信息不可用")?;
            // BoxModel coordinates already include all same-process ancestor frames.
            // Mapping a frame's content quad therefore jumps to its parent's renderer root.
            let parent_frame = if current.frame != root_frame {
                self.inner
                    .read()
                    .await
                    .parents
                    .get(&current.frame)
                    .cloned()
                    .ok_or("无法确定 iframe 的父页面，请重新连接")?
            } else {
                let info = self
                    .client
                    .call(&current.session, "Target.getTargetInfo", json!({}))
                    .await?;
                if info["targetInfo"]["targetId"].as_str() == Some(self.target.as_str()) {
                    reached_page = true;
                    break;
                }
                info["targetInfo"]["parentFrameId"]
                    .as_str()
                    .ok_or("无法换算此内部页面相对于浏览器的坐标")?
                    .to_string()
            };
            let parent = self
                .inner
                .read()
                .await
                .contexts
                .values()
                .find(|c| c.frame == parent_frame)
                .cloned()
                .ok_or("父页面上下文不可用，请重新连接")?;
            let viewport = self
                .evaluate(&current, "({width:innerWidth,height:innerHeight})")
                .await?;
            let owner = self
                .client
                .call(
                    &parent.session,
                    "DOM.getFrameOwner",
                    json!({"frameId":current.frame}),
                )
                .await?;
            let model = self
                .client
                .call(
                    &parent.session,
                    "DOM.getBoxModel",
                    json!({"backendNodeId":owner["backendNodeId"]}),
                )
                .await?;
            let content = model["model"]["content"]
                .as_array()
                .ok_or("iframe 没有可用的布局框")?;
            let quad: Vec<f64> = content.iter().filter_map(Value::as_f64).collect();
            let quad: [f64; 8] = quad.try_into().map_err(|_| "iframe 几何信息无效")?;
            points = crate::geometry::project(
                points,
                quad,
                viewport["width"].as_f64().unwrap_or(0.0),
                viewport["height"].as_f64().unwrap_or(0.0),
            )?;
            let parent_tree = self
                .client
                .call(&parent.session, "Page.getFrameTree", json!({}))
                .await?;
            let parent_root = parent_tree["frameTree"]["frame"]["id"]
                .as_str()
                .ok_or("父页面 frame 信息不可用")?;
            current = self
                .inner
                .read()
                .await
                .contexts
                .values()
                .find(|c| c.session == parent.session && c.frame == parent_root)
                .cloned()
                .ok_or("父页面根上下文不可用，请重新连接")?;
        }
        if !reached_page {
            return Err("iframe 层级过深，无法换算坐标".into());
        }
        self.check_context(value).await?;
        let [x, y, width, height] = crate::geometry::bounds(points);
        Ok(json!({"x":x,"y":y,"width":width,"height":height,
            "centerX":x+width/2.0,"centerY":y+height/2.0}))
    }
    pub async fn shutdown(&self) {
        let _ = self.set_freeze(false).await;
        self.alive.store(false, Ordering::Relaxed);
        self.active.store(false, Ordering::Relaxed);
        let (contexts, scripts) = {
            let inner = self.inner.read().await;
            (
                inner.contexts.values().cloned().collect::<Vec<_>>(),
                inner.scripts.clone(),
            )
        };
        for context in contexts {
            let _ = self
                .evaluate(&context, "window.__elemlens_v1?.dispose()")
                .await;
        }
        for (session, id) in scripts {
            let _ = self
                .client
                .call(
                    &session,
                    "Page.removeScriptToEvaluateOnNewDocument",
                    json!({"identifier":id}),
                )
                .await;
        }
        self.client.close().await;
    }
}
pub struct ContextRef {
    context: Context,
}
