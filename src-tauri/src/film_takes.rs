//! 每鏡拍攝版本。只保存配方與結果索引；不搬動、刪除或生成媒體。
//! 呼叫者負責讓 result 中的檔案位置不可被下次拍攝覆寫，並在專案寫鎖內修改。
use crate::director::new_id;
use crate::py::now;
use serde_json::{json, Value};

pub fn result_of(seg: &Value, keys: &[&str]) -> Value {
    let mut result = serde_json::Map::new();
    for key in keys {
        if let Some(v) = seg.get(*key) {
            result.insert((*key).into(), v.clone());
        }
    }
    Value::Object(result)
}

/// 舊專案第一次操作時，把目前結果收成一版。重複呼叫不增加相同版本。
pub fn ensure_legacy(seg: &mut Value, keys: &[&str]) {
    if !seg.is_object() { return; }
    if !seg["takes"].is_array() { seg["takes"] = json!([]); }
    if seg["selected_take"].as_str().is_some_and(|id| seg["takes"].as_array().is_some_and(|a| a.iter().any(|t| t["id"] == id))) {
        return;
    }
    let result = result_of(seg, keys);
    let has_media = result["video_id"].as_i64().is_some() || result["files"].as_object().is_some_and(|m| !m.is_empty());
    if !has_media { return; }
    let pending = seg["pending_take"].clone();
    let existing = seg["takes"].as_array().and_then(|a| a.iter().find(|t| t["result"] == result)).map(|t| t["id"].clone());
    let id = existing.unwrap_or_else(|| {
        json!(record(seg, json!({"legacy": true, "note": "舊版結果，原始生成配方可能不完整"}), result, None))
    });
    seg["selected_take"] = id;
    seg["pending_take"] = pending;
}

/// 生成前保留目前採用的舊結果；不重複存已有 selected_take。
pub fn archive_current(seg: &mut Value, recipe: Value, keys: &[&str]) {
    ensure_legacy(seg, keys);
    let selected = seg["selected_take"].as_str().unwrap_or("").to_string();
    if recipe.is_object() && !selected.is_empty() {
        if let Some(t) = seg["takes"].as_array_mut().and_then(|a| a.iter_mut().find(|t| t["id"] == selected)) {
            // 舊版配方不偽裝成這一次生成的配方。
            if t["recipe"].is_null() { t["recipe"] = recipe; }
        }
    }
}

/// 新版只加入候選；採用必須另外呼叫 select。source_take 是上一鏡採用版號。
pub fn record(seg: &mut Value, recipe: Value, result: Value, source_take: Option<&str>) -> String {
    if !seg["takes"].is_array() { seg["takes"] = json!([]); }
    let id = format!("{}_{:016x}", new_id(), rand::random::<u64>());
    let number = seg["takes"].as_array().map_or(1, |a| a.len() + 1);
    let mut take = json!({"id": id, "created": now(), "label": format!("第 {number} 版"), "recipe": recipe, "result": result});
    if let Some(source) = source_take.filter(|s| !s.is_empty()) { take["source_take"] = json!(source); }
    seg["takes"].as_array_mut().unwrap().push(take);
    seg["pending_take"] = json!(id);
    id
}

/// 清掉可供下游使用的目前結果，歷史版本與提示詞完整保留。
pub fn clear_current(seg: &mut Value, keys: &[&str]) {
    for key in keys { seg[*key] = Value::Null; }
    seg["status"] = json!("todo");
    seg["selected_take"] = Value::Null;
    seg["pending_take"] = Value::Null;
}

/// 將選用版本投影回舊欄位，讓既有接續與合片流程沿用。回傳版本是否改變。
pub fn select(seg: &mut Value, id: &str, keys: &[&str]) -> Result<bool, String> {
    let take = seg["takes"].as_array().and_then(|a| a.iter().find(|t| t["id"] == id)).cloned().ok_or("找不到這個拍攝版本")?;
    if !take["result"].is_object() { return Err("這個版本沒有可採用的拍攝結果".into()); }
    let changed = seg["selected_take"] != id;
    for key in keys { seg[*key] = take["result"].get(*key).cloned().unwrap_or(Value::Null); }
    seg["selected_take"] = json!(id);
    seg["pending_take"] = Value::Null;
    seg["status"] = json!("done");
    seg["error"] = json!("");
    seg["stale"] = Value::Null;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEYS: &[&str] = &["video_id", "last_frame", "status", "error"];

    #[test]
    fn old_project_migrates_once_and_keeps_media() {
        let mut s = json!({"video_id": 7, "last_frame": "old.png", "status": "done", "video": "prompt"});
        ensure_legacy(&mut s, KEYS);
        ensure_legacy(&mut s, KEYS);
        assert_eq!(s["takes"].as_array().unwrap().len(), 1);
        assert_eq!(s["video_id"], 7);
        assert!(s["pending_take"].is_null(), "補舊版不能變成待審新候選");
        assert_eq!(s["takes"][0]["recipe"]["legacy"], true);
    }

    #[test]
    fn candidate_never_replaces_selected_until_adopted() {
        let mut s = json!({"video_id": 7, "status": "done"});
        ensure_legacy(&mut s, KEYS);
        let first = s["selected_take"].as_str().unwrap().to_string();
        let id = record(&mut s, json!({"params":{"seed": 123}}), json!({"video_id": 8,"last_frame":"new.png"}), Some("previous-shot-take"));
        assert_eq!(s["video_id"], 7);
        assert_eq!(s["selected_take"], first);
        assert!(select(&mut s, &id, KEYS).unwrap());
        assert_eq!(s["video_id"], 8);
        assert!(!select(&mut s, &id, KEYS).unwrap());
        select(&mut s, &first, KEYS).unwrap();
        assert_eq!(s["video_id"], 7);
        assert!(s["last_frame"].is_null(), "舊版沒有的欄位不能殘留新版結果");
        assert_eq!(s["takes"][1]["source_take"], "previous-shot-take");
    }

    #[test]
    fn invalidation_keeps_versions_and_recipe() {
        let mut s = json!({"video_id": 7,"status":"done","video":"kept"});
        ensure_legacy(&mut s, KEYS);
        let takes = s["takes"].clone();
        clear_current(&mut s, KEYS);
        assert_eq!(s["takes"], takes);
        assert_eq!(s["video"], "kept");
        assert!(s["video_id"].is_null());
        assert!(select(&mut s, "missing", KEYS).is_err());
    }
}
