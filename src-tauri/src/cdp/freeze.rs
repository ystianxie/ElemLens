use super::*;

#[derive(Default)]
pub(super) struct FreezeState {
    // Keep every touched session until scripts have been restored, including failed freezes.
    // Backend IDs survive DOM refreshes caused by validation and DevTools.
    sessions: HashMap<String, Vec<i64>>,
}

impl Connection {
    pub async fn set_freeze(&self, active: bool) -> Result<(), String> {
        let mut state = self.freeze.lock().await;
        if !active {
            self.freeze_armed.store(false, Ordering::Relaxed);
            let result = self.release_freeze(&mut state).await;
            self.emit(
                "freeze",
                json!(if self.frozen.load(Ordering::Relaxed) {
                    "frozen"
                } else {
                    "idle"
                }),
            );
            return result;
        }
        if self.recording.load(Ordering::Relaxed) || self.active.load(Ordering::Relaxed) {
            return Err("请先结束捕获或暂停录制，再冻结浮窗".into());
        }
        if self.frozen.load(Ordering::Relaxed) {
            return Err("请先解除当前冻结".into());
        }
        let contexts: Vec<_> = self.inner.read().await.contexts.values().cloned().collect();
        if contexts.is_empty() {
            return Err("页面尚未就绪，请稍后重试".into());
        }
        self.freeze_armed.store(true, Ordering::Relaxed);
        for context in contexts {
            if let Err(e) = self
                .evaluate(&context, "window.__elemlens_v1.setFreezeArmed(true)")
                .await
            {
                self.freeze_armed.store(false, Ordering::Relaxed);
                let _ = self.release_freeze(&mut state).await;
                self.emit("freeze", json!("idle"));
                return Err(e);
            }
        }
        self.emit("freeze", json!("armed"));
        Ok(())
    }

    pub(super) async fn confirm_freeze(&self) -> Result<(), String> {
        let mut state = self.freeze.lock().await;
        if !self.freeze_armed.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        self.frozen.store(true, Ordering::Relaxed);
        let result = self.apply_freeze(&mut state).await;
        if let Err(e) = result {
            let cleanup = self.release_freeze(&mut state).await;
            self.emit(
                "freeze",
                json!(if self.frozen.load(Ordering::Relaxed) {
                    "frozen"
                } else {
                    "idle"
                }),
            );
            return Err(match cleanup {
                Ok(()) => e,
                Err(recovery) => format!("{e}；解除冻结失败：{recovery}"),
            });
        }
        self.frozen.store(true, Ordering::Relaxed);
        self.emit("freeze", json!("frozen"));
        Ok(())
    }

    async fn apply_freeze(&self, state: &mut FreezeState) -> Result<(), String> {
        let (sessions, contexts) = {
            let inner = self.inner.read().await;
            (
                inner.scripts.keys().cloned().collect::<Vec<_>>(),
                inner.contexts.values().cloned().collect::<Vec<_>>(),
            )
        };
        // Stop mouseleave handlers/timers first. CDP evaluation still runs synchronously.
        for session in &sessions {
            state.sessions.insert(session.clone(), vec![]);
            self.client
                .call(
                    session,
                    "Emulation.setFocusEmulationEnabled",
                    json!({"enabled":true}),
                )
                .await?;
            self.client
                .call(
                    session,
                    "Emulation.setScriptExecutionDisabled",
                    json!({"value":true}),
                )
                .await?;
            self.client.call(session, "CSS.enable", json!({})).await?;
            self.client
                .call(session, "DOM.getDocument", json!({"depth":0}))
                .await?;
        }
        for context in &contexts {
            let result = self
                .client
                .call(
                    &context.session,
                    "Runtime.evaluate",
                    json!({
                        "contextId":context.id, "expression":"window.__elemlens_v1.freezeTargets()",
                        "objectGroup":"elemlens-freeze", "returnByValue":false
                    }),
                )
                .await?;
            let object = result["result"]["objectId"]
                .as_str()
                .ok_or("无法读取悬浮元素")?;
            let properties = self
                .client
                .call(
                    &context.session,
                    "Runtime.getProperties",
                    json!({
                        "objectId":object, "ownProperties":true
                    }),
                )
                .await?;
            if let Some(properties) = properties["result"].as_array() {
                for property in properties {
                    if property["name"]
                        .as_str()
                        .and_then(|s| s.parse::<usize>().ok())
                        .is_none()
                    {
                        continue;
                    }
                    let Some(object) = property["value"]["objectId"].as_str() else {
                        continue;
                    };
                    let node = self
                        .client
                        .call(
                            &context.session,
                            "DOM.requestNode",
                            json!({"objectId":object}),
                        )
                        .await?;
                    let node = node["nodeId"]
                        .as_i64()
                        .filter(|id| *id > 0)
                        .ok_or("悬浮元素已失效")?;
                    let description = self
                        .client
                        .call(&context.session, "DOM.describeNode", json!({"nodeId":node}))
                        .await?;
                    let backend = description["node"]["backendNodeId"]
                        .as_i64()
                        .ok_or("悬浮元素已失效")?;
                    self.client
                        .call(
                            &context.session,
                            "CSS.forcePseudoState",
                            json!({
                                "nodeId":node, "forcedPseudoClasses":["hover"]
                            }),
                        )
                        .await?;
                    state
                        .sessions
                        .get_mut(&context.session)
                        .ok_or("页面会话已改变")?
                        .push(backend);
                }
            }
            self.evaluate(context, "window.__elemlens_v1.setFrozen(true)")
                .await?;
        }
        for session in sessions {
            let _ = self
                .client
                .call(
                    &session,
                    "Runtime.releaseObjectGroup",
                    json!({"objectGroup":"elemlens-freeze"}),
                )
                .await;
        }
        Ok(())
    }

    async fn release_freeze(&self, state: &mut FreezeState) -> Result<(), String> {
        let contexts: Vec<_> = self.inner.read().await.contexts.values().cloned().collect();
        for context in contexts {
            let _ = self.evaluate(&context, "window.__elemlens_v1?.setFrozen(false);window.__elemlens_v1?.setFreezeArmed(false)").await;
        }
        let mut failures = vec![];
        let sessions = std::mem::take(&mut state.sessions);
        for (session, nodes) in sessions {
            if !self.inner.read().await.scripts.contains_key(&session) {
                continue;
            }
            let _ = self
                .client
                .call(
                    &session,
                    "Overlay.setInspectMode",
                    json!({"mode":"none","highlightConfig":{}}),
                )
                .await;
            let hover = self.clear_frozen_hover(&session, &nodes).await;
            let _ = self
                .client
                .call(
                    &session,
                    "Runtime.releaseObjectGroup",
                    json!({"objectGroup":"elemlens-freeze"}),
                )
                .await;
            let focus = self
                .client
                .call(
                    &session,
                    "Emulation.setFocusEmulationEnabled",
                    json!({"enabled":false}),
                )
                .await;
            let scripts = self
                .client
                .call(
                    &session,
                    "Emulation.setScriptExecutionDisabled",
                    json!({"value":false}),
                )
                .await;
            if let Err(e) = hover.and(focus).and(scripts) {
                failures.push(e);
                state.sessions.insert(session, nodes);
            }
        }
        self.frozen
            .store(!state.sessions.is_empty(), Ordering::Relaxed);
        if self.active.swap(false, Ordering::Relaxed) {
            self.emit("cancel", Value::Null);
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("；"))
        }
    }

    async fn clear_frozen_hover(&self, session: &str, nodes: &[i64]) -> Result<(), String> {
        if nodes.is_empty() {
            return Ok(());
        }
        self.client
            .call(session, "DOM.getDocument", json!({"depth":0}))
            .await?;
        let resolved = self
            .client
            .call(
                session,
                "DOM.pushNodesByBackendIdsToFrontend",
                json!({"backendNodeIds":nodes}),
            )
            .await?;
        if let Some(ids) = resolved["nodeIds"].as_array() {
            for node in ids.iter().filter_map(Value::as_i64).filter(|id| *id > 0) {
                self.client
                    .call(
                        session,
                        "CSS.forcePseudoState",
                        json!({"nodeId":node,"forcedPseudoClasses":[]}),
                    )
                    .await?;
            }
        }
        Ok(())
    }

    pub(super) fn cancel_freeze_on_navigation(self: &Arc<Self>) {
        if self.freeze_armed.load(Ordering::Relaxed) || self.frozen.load(Ordering::Relaxed) {
            let connection = self.clone();
            tokio::spawn(async move {
                if let Err(e) = connection.set_freeze(false).await {
                    connection.emit("error", json!(format!("页面变化后解除冻结失败：{e}")));
                }
            });
        }
    }

    pub(super) async fn set_frozen_picker(&self, active: bool) -> Result<(), String> {
        let state = self.freeze.lock().await;
        for session in state.sessions.keys() {
            self.client
                .call(session, "Overlay.enable", json!({}))
                .await?;
            self.client.call(session, "Overlay.setInspectMode", json!({
                "mode":if active {"searchForNode"} else {"none"},
                "highlightConfig":{"showInfo":true,"contentColor":{"r":24,"g":166,"b":123,"a":0.18},"borderColor":{"r":24,"g":166,"b":123,"a":1}}
            })).await?;
        }
        Ok(())
    }

    pub(super) async fn capture_frozen_node(&self, session: &str, node: i64) -> Result<(), String> {
        if !self.active.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        self.set_frozen_picker(false).await?;
        let contexts: Vec<_> = self
            .inner
            .read()
            .await
            .contexts
            .values()
            .filter(|c| c.session == session)
            .cloned()
            .collect();
        for context in contexts {
            let resolved = self.client.call(session, "DOM.resolveNode", json!({
                "backendNodeId":node, "executionContextId":context.id, "objectGroup":"elemlens-picker"
            })).await?;
            let Some(object) = resolved["object"]["objectId"].as_str() else {
                continue;
            };
            let result = self.client.call(session, "Runtime.callFunctionOn", json!({
                "objectId":object, "returnByValue":true,
                "functionDeclaration":"function(){if(this.ownerDocument!==document || !(this instanceof Element))return null;const a=window.__elemlens_v1;return a.captureInfo(this);}"
            })).await;
            let _ = self
                .client
                .call(
                    session,
                    "Runtime.releaseObjectGroup",
                    json!({"objectGroup":"elemlens-picker"}),
                )
                .await;
            let result = result?;
            if result.get("exceptionDetails").is_some() {
                return Err("读取冻结元素失败，请重新捕获".into());
            }
            let payload = &result["result"]["value"];
            if !payload.is_object() {
                continue;
            }
            if let Some(error) = payload["error"].as_str() {
                self.active.store(true, Ordering::Relaxed);
                self.set_frozen_picker(true).await?;
                self.emit("capture-rejected", json!(error));
                return Ok(());
            }
            let context_value = self
                .capture_context(
                    &context,
                    payload["steps"].as_array().cloned().unwrap_or_default(),
                )
                .await?;
            self.highlight(
                &context_value,
                vec![payload["element"]["token"]
                    .as_str()
                    .ok_or("元素标识不可用")?
                    .into()],
                false,
            )
            .await?;
            self.emit(
                "capture",
                json!({"context":context_value,"element":payload["element"]}),
            );
            return Ok(());
        }
        Err("无法确定冻结元素所在文档，请重新捕获".into())
    }
}
