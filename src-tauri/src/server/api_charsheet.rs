//! 角色設定圖工坊（design\角色設定圖工坊_設計.md）：
//!   POST /api/charsheet/prompt {kind: turnaround｜face｜pose, desc, family} → {prompt, width, height}（pose＝定稿補字，只有 prompt）
//!   POST /api/charsheet/tags   {name（input 檔名）} → {tags}：反推後只留外觀類
//! 生圖走 /api/generate，存檔走 /api/lib＋/api/assets/{id}/file。
use super::{bad, basename, blocking, not_found, ok, ApiResult, Body, Shared};
use crate::charsheet;
use crate::director::tx;
use axum::extract::State;
use serde_json::json;

pub async fn prompt(Body(b): Body) -> ApiResult {
    let (kind, family) = (tx(&b["kind"]), tx(&b["family"]));
    if kind == "pose" {
        return ok(json!({"prompt": charsheet::pose_suffix(&family)}));
    }
    let (p, w, h) = charsheet::prompt(&kind, &tx(&b["desc"]), &family).ok_or_else(|| bad("kind 只能是 turnaround、face 或 pose"))?;
    ok(json!({"prompt": p, "width": w, "height": h}))
}

pub async fn tags(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    if !app.tagger.available() {
        return Err(bad("反推模型尚未下載"));
    }
    let name = basename(&tx(&b["name"]));
    let path = app.paths.input.join(&name);
    if name.is_empty() || !path.is_file() {
        return Err(not_found("找不到定稿圖"));
    }
    let t = app.tagger.clone();
    let v = blocking(move || t.tag(&path, 0.35, 0.85)).await.map_err(|e| bad(format!("反推失敗：{e}")))?;
    // 角色名在前（最能認出是誰），再來是一般 tag（已照機率排好）
    let all: Vec<String> = ["character", "general"]
        .iter()
        .flat_map(|k| v[*k].as_array().cloned().unwrap_or_default())
        .filter_map(|p| p[0].as_str().map(str::to_owned))
        .collect();
    ok(json!({"tags": charsheet::filter_tags(&all)}))
}
