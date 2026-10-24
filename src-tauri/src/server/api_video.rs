//! 影片模型：列出、匯入、刪除自訂的 ComfyUI 影片工作流（video_wf.rs）。選哪個用 /api/settings 的 video_engine 存
use super::{api_wf, bad, blocking, internal, ok, ApiResult, Body, Shared};
use crate::{settings, video_wf};
use axum::extract::{Path as UrlPath, State};
use serde_json::{json, Value};

/// {"engine": 現在用的, "builtin": {id, name}, "workflows": [{id, name, added, info | error}]}
pub async fn list(State(app): State<Shared>) -> ApiResult {
    let engine = settings::load(&app.paths.settings)
        .get("video_engine")
        .and_then(Value::as_str)
        .unwrap_or(video_wf::BUILTIN)
        .to_string();
    let dir = video_wf::dir(&app.paths.data);
    let workflows = blocking(move || video_wf::list(&dir)).await;
    ok(json!({"engine": engine, "builtin": {"id": video_wf::BUILTIN, "name": video_wf::BUILTIN_NAME}, "workflows": workflows}))
}

/// 匯入 {"name", "graph"}，或 {"name", "file_name", "data_b64"}（API／一般「儲存」的 JSON、ComfyUI 生成的 PNG／WebP，跟生圖工作流一樣轉）：
/// 看得懂才存，同名的覆蓋。回 {"ok", "workflow", "warnings": [轉換時的提醒]}
pub async fn add(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let name = body.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(bad("幫這個工作流取個名字"));
    }
    let (graph, warnings) = if let Some(g) = body.get("graph").cloned() {
        (g, vec![])
    } else if let Some(b64) = body.get("data_b64").and_then(Value::as_str) {
        let file_name = body.get("file_name").and_then(Value::as_str).unwrap_or("").to_string();
        let i = api_wf::file_to_api(&app, &file_name, api_wf::decode_b64(b64)?).await?;
        (i.graph, i.warnings)
    } else {
        return Err(bad("送來的資料格式不對：要有 graph，或 file_name 加 data_b64"));
    };
    let dir = video_wf::dir(&app.paths.data);
    // 存不了的時候把轉換的提醒一起講（缺自訂節點被略過，常常就是找不到存影片節點的原因）
    let w2 = warnings.clone();
    let wf = blocking(move || video_wf::save(&dir, &name, &graph)).await.map_err(|e| {
        bad(if w2.is_empty() { e } else { format!("{e}
轉換時的提醒：
・{}", w2.iter().take(8).cloned().collect::<Vec<_>>().join("
・")) })
    })?;
    ok(json!({"ok": true, "workflow": wf, "warnings": warnings}))
}

/// 對應設定的編輯畫面（video_wf::detail）；ComfyUI 沒連線也給（欄位型別用值猜、沒有下拉選項，info_known＝false）
pub async fn detail(State(app): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let oi = app.comfy.object_info_all().await.ok();
    let known = oi.is_some();
    let dir = video_wf::dir(&app.paths.data);
    let mut d = blocking(move || video_wf::detail(&dir, &id, oi.as_deref().unwrap_or(&Value::Null))).await.map_err(bad)?;
    d["info_known"] = json!(known);
    ok(d)
}

/// 存對應設定 {"map": {...} | null（清掉、全部自動）} → {"ok", "workflow": list() 那樣的一筆}
pub async fn set_map(State(app): State<Shared>, UrlPath(id): UrlPath<String>, Body(body): Body) -> ApiResult {
    let map = body.get("map").cloned().unwrap_or(Value::Null);
    let dir = video_wf::dir(&app.paths.data);
    let wf = blocking(move || video_wf::save_map(&dir, &id, &map)).await.map_err(bad)?;
    ok(json!({"ok": true, "workflow": wf}))
}

/// 刪掉；正在用的被刪了就換回內建
pub async fn remove(State(app): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let _g = app.settings_lock.lock().await;
    video_wf::remove(&video_wf::dir(&app.paths.data), &id).map_err(bad)?;
    let mut s = settings::load(&app.paths.settings);
    if s.get("video_engine").and_then(Value::as_str) == Some(id.as_str()) {
        s.insert("video_engine".into(), json!(video_wf::BUILTIN));
        settings::save(&app.paths.settings, &s).map_err(internal)?;
    }
    ok(json!({"ok": true}))
}
