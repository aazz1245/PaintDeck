//! 拍攝單 API（2026-10-24，子專案 2）：組提示詞、健檢、使用者的危險字、AI 潤飾、存成範本。
//! 邏輯在 crate::shotsheet；網頁在 ui\js\shotsheet.js。
use super::api_lib::item_from;
use super::{bad, blocking, ok, ApiResult, Body, Shared};
use crate::db::Thumb;
use crate::director::{tx, write_atomic};
use crate::shotsheet as sh;
use axum::extract::State;
use serde_json::{json, Value};
use std::path::PathBuf;

/// 使用者自己加的危險字，最多幾個
const MAX_DANGER: usize = 200;
// 同一份字表共用 write_atomic 的暫存檔，寫入必須排隊。
static DANGER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn danger_file(app: &Shared) -> PathBuf {
    app.paths.data.join("h3_sheet_danger.json")
}

fn danger_words(app: &Shared) -> Vec<String> {
    std::fs::read(danger_file(app))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

fn sheet_of(b: &Value) -> Result<Value, super::ApiError> {
    sh::normalize(&b["sheet"]).map_err(bad)
}

fn other(lang: &str) -> &'static str {
    if lang == "en" {
        "zh"
    } else {
        "en"
    }
}

/// 鏡位按鈕、危險字、時間常數
pub async fn meta(State(app): State<Shared>) -> ApiResult {
    let rules = sh::rules_json();
    ok(json!({
        "cheat": rules["cheat"],
        "rules": {"danger": rules["danger"], "danger_user": danger_words(&app)},
        "limits": {"tail": sh::TAIL_SECS, "handover": sh::HANDOVER_SECS, "early": sh::EARLY_SECS,
                   "min_secs": sh::MIN_SECS, "max_secs": sh::MAX_SECS, "max_segs": sh::MAX_SEGS,
                   "max_cast": sh::MAX_CAST, "max_refs": sh::MAX_REFS},
    }))
}

/// {sheet} → 正規化後的拍攝單、每段的提示詞（拍攝單的語言）和對照（另一種語言）、開拍預估
pub async fn compose(Body(b): Body) -> ApiResult {
    let s = sheet_of(&b)?;
    let lang = s["lang"].as_str().unwrap_or("zh").to_string();
    let n = s["segments"].as_array().map_or(0, |a| a.len());
    let segments: Vec<Value> =
        (0..n).map(|i| json!({"prompt": sh::compose(&s, i, &lang), "mirror": sh::compose(&s, i, other(&lang))})).collect();
    ok(json!({"estimate": sh::estimate(&s), "segments": segments, "sheet": s}))
}

/// {sheet, prompts} → {issues}
pub async fn check(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let s = sheet_of(&b)?;
    let prompts: Vec<String> = b["prompts"].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
    let rules = sh::rules(&danger_words(&app));
    ok(json!({"issues": sh::check(&s, &prompts, &rules)}))
}

/// {words} → 存使用者的危險字（去空白、去重、最多 200 個）
pub async fn danger(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let input = b["words"].as_array().filter(|a| a.iter().all(Value::is_string)).ok_or_else(|| bad("危險字必須是文字陣列"))?;
    let mut words: Vec<String> = Vec::new();
    for w in input {
        let w: String = w.as_str().unwrap_or("").trim().chars().take(60).collect();
        if !w.is_empty() && !words.contains(&w) && words.len() < MAX_DANGER {
            words.push(w);
        }
    }
    let path = danger_file(&app);
    let v = json!(words);
    let guard = DANGER_LOCK.lock().await;
    blocking(move || {
        let _guard = guard;
        write_atomic(&path, &v)
    }).await.map_err(|e| bad(format!("危險字沒存成：{e}")))?;
    ok(json!({"words": words}))
}

/// 從回覆裡拿出 ```text 區塊（沒寫 text 的 ``` 也收）
fn text_blocks(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(a) = rest.find("```") {
        let after = &rest[a + 3..];
        let body_start = after.find('\n').map_or(after.len(), |i| i + 1);
        let body = &after[body_start..];
        match body.find("```") {
            Some(e) => {
                let t = body[..e].trim();
                if !t.is_empty() {
                    out.push(t.to_string());
                }
                rest = &body[e + 3..];
            }
            None => break,
        }
    }
    out
}

/// {sheet, seg, prompt, brain} → AI 潤飾這一段：{prompt, mirror}
pub async fn polish(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let s = sheet_of(&b)?;
    let n = s["segments"].as_array().map_or(0, |a| a.len());
    let i = b["seg"].as_u64().map(|x| x as usize).filter(|x| *x < n).ok_or_else(|| bad("沒有這一段"))?;
    let lang = s["lang"].as_str().unwrap_or("zh").to_string();
    let draft = match tx(&b["prompt"]) {
        p if p.trim().is_empty() => sh::compose(&s, i, &lang),
        p => p,
    };
    let (brain, remote) = super::api_h3::brain_of(&app, &b)?;
    let mut part = s.clone();
    part["segments"] = json!([s["segments"][i]]);
    for k in ["prompt", "mirror", "manual"] {
        if let Some(o) = part["segments"][0].as_object_mut() {
            o.remove(k);
        }
    }
    let req = format!(
        "Output language: {}\nSegment {} of {}, {} seconds.\n\nShot sheet for this segment (JSON):\n{}\n\nDraft prompt:\n```text\n{}\n```",
        if lang == "en" { "English" } else { "Traditional Chinese" },
        i + 1,
        n,
        s["segments"][i]["secs"],
        part,
        draft
    );
    let system = app.pe.agent_text("agent_h3_sheet");
    let msgs = json!([{"role": "system", "content": system}, {"role": "user", "content": req}]);
    let rid = format!("h3s-{:x}", super::api_director::random_seed());
    let (content, _) = app.pe.agent_chat(&rid, &msgs, 6144, 0.6, false, &brain, remote.as_ref()).await.map_err(bad)?;
    let blocks = text_blocks(&content);
    if blocks.len() < 2 {
        return Err(bad("腦袋沒照格式寫，換一顆腦袋或再按一次"));
    }
    ok(json!({"prompt": blocks[0], "mirror": blocks[1]}))
}

/// {name, sheet} → 存成資產庫的拍攝單範本（kind=shot），回存好的那筆
pub async fn template(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let s = sheet_of(&b)?;
    let it = item_from(&json!({"kind": "shot", "name": b["name"], "family": "h3", "data": sh::template_of(&s)}), None)?;
    let _g = app.assets_lock.lock().await;
    let id = app.db.lib_save(None, &it, &Thumb::Keep)?.ok_or_else(|| bad("範本沒存成"))?;
    ok(json!(app.db.lib_item(id)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_blocks_reads_two_fences() {
        let r = "好的：\n```text\nA\nB\n```\n說明\n```\nC\n```";
        assert_eq!(text_blocks(r), ["A\nB", "C"]);
        assert!(text_blocks("```text\n沒收尾").is_empty());
        assert_eq!(other("zh"), "en");
        assert_eq!(other("en"), "zh");
    }
}
