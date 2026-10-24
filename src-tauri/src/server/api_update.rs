use super::{bad, ok, ApiResult, Body, Shared};
use axum::extract::State;

pub async fn status(State(app): State<Shared>) -> ApiResult {
    let mut v = app.updates.view();
    v["busy_reason"] = serde_json::json!(super::update_idle(&app).await.err());
    ok(v)
}

pub async fn check(State(app): State<Shared>) -> ApiResult {
    app.updates.check().await;
    status(State(app)).await
}

pub async fn preferences(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let on = b["auto_check"].as_bool().ok_or_else(|| bad("auto_check 必須是布林值"))?;
    app.updates.set_auto(on).map_err(bad)?;
    status(State(app)).await
}

pub async fn install(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    if b["confirm"] != true { return Err(bad("請先確認要下載、安裝並重新開啟程式")); }
    let version = b["version"].as_str().ok_or_else(|| bad("請先檢查更新"))?;
    app.updates.install(&app, version).await.map_err(bad)?;
    ok(serde_json::json!({"ok": true}))
}
