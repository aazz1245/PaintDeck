//! AI 改寫提示詞的 API（對照舊版 server.py 的 /api/pe/*；實際工作在 crate::pe::Service）。
use super::{internal, ok, ApiResult, Body, Shared};
use crate::py::str_of;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};

/// SSE 串流：status／reasoning／content／zh_delta／result／error／cancelled 事件
pub async fn rewrite(State(app): State<Shared>, Body(body): Body) -> Response {
    app.pe.rewrite_sse(body)
}

pub async fn cancel(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let rid = str_of(body.get("rid").unwrap_or(&Value::Null));
    ok(json!({"ok": app.pe.cancel(&rid)}))
}

pub async fn status(State(app): State<Shared>) -> ApiResult {
    ok(app.pe.status())
}

/// 姿勢大彙整的選單（id、中文名、類別、人數、有沒有姿勢參考圖、中文說明）
pub async fn poses(State(app): State<Shared>) -> ApiResult {
    ok(json!({"poses": app.pe.poses.menu(), "control_dir": super::POSE_INPUT}))
}

/// 可以自訂的系統提示詞（目前內容、預設內容、有沒有改過）
pub async fn prompts(State(app): State<Shared>) -> ApiResult {
    ok(json!({"prompts": app.pe.prompts_list().map_err(super::bad)?}))
}

/// 儲存自訂系統提示詞：{"id": ..., "text": ...}；text 空白＝還原預設
pub async fn prompt_save(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let id = str_of(body.get("id").unwrap_or(&Value::Null));
    let text = body.get("text").and_then(Value::as_str).unwrap_or("");
    ok(app.pe.prompt_save(&id, text).map_err(super::bad)?)
}

pub async fn stop(State(app): State<Shared>) -> ApiResult {
    let stopped = app.pe.stop("網頁按了關閉").await.map_err(internal)?;
    ok(json!({"stopped": stopped}))
}

/// 「下載讀圖檔」：生圖助手、導演台看圖要的 mmproj 不見了，從安裝清單查網址下載到語言模型資料夾。
/// {brain?: "9b"|"35b"} → {ok, have: true}（已經有了）或 {ok, id, name, size}（進度看 /api/models/downloads）
pub async fn mmproj(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let brain = body["brain"].as_str().filter(|b| matches!(*b, "9b" | "35b"));
    match app.pe.mmproj_download(brain).map_err(super::bad)? {
        None => ok(json!({"ok": true, "have": true})),
        Some((dest, url, size, sha)) => {
            let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let id = super::api_models::download_to(url, dest, size, sha);
            ok(json!({"ok": true, "id": id, "name": name, "size": size}))
        }
    }
}
