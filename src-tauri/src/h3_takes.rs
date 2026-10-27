//! H3 版本使用獨立媒體檔；重拍不會覆寫舊版影片或 latent。
use crate::{director::tx, film_takes as takes, h3chain as hc};
use serde_json::{json, Value};
use std::path::Path;

pub fn safe_file(name: &str) -> bool {
    !name.is_empty() && name.len() < 180 && !name.starts_with('.') && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn copy_atomic(source: &Path, target: &Path) -> Result<(), String> {
    let temporary = target.with_extension(format!("{}.part", target.extension().unwrap_or_default().to_string_lossy()));
    std::fs::copy(source, &temporary).map_err(|e| e.to_string())?;
    std::fs::OpenOptions::new().write(true).open(&temporary).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, target).map_err(|e| e.to_string())
}

pub fn preserve(seg: &mut Value, dir: &Path) -> Result<(), String> {
    takes::ensure_legacy(seg, hc::RESULT_KEYS);
    let selected = tx(&seg["selected_take"]);
    if let Some(versions) = seg["takes"].as_array_mut() {
        for take in versions {
            let id = tx(&take["id"]);
            if !crate::director::valid_id(&id) { return Err("拍攝版本編號不正確".into()); }
            for tag in ["cut", "end", "lat"] {
                let source = tx(&take["result"]["files"][tag]);
                if source.is_empty() { continue; }
                if !safe_file(&source) { return Err("拍攝版本的檔名不正確".into()); }
                let target = format!("take_{id}_{tag}.{}", if tag == "lat" { "safetensors" } else { "mp4" });
                if source != target {
                    if !dir.join(&source).is_file() { return Err(format!("拍攝版本的檔案不見了：{source}")); }
                    if !dir.join(&target).exists() { copy_atomic(&dir.join(&source), &dir.join(&target))?; }
                    take["result"]["files"][tag] = json!(target);
                }
            }
        }
    }
    if !selected.is_empty() {
        if let Some(files) = seg["takes"].as_array().and_then(|a| a.iter().find(|t| t["id"] == selected)).map(|t| t["result"]["files"].clone()) {
            seg["files"] = files;
        }
    }
    Ok(())
}

pub fn select(c: &mut Value, dir: &Path, i: usize, take_id: &str) -> Result<bool, String> {
    let seg = c["segments"].get(i).ok_or("沒有這一段")?;
    let take = seg["takes"].as_array().and_then(|a| a.iter().find(|t| t["id"] == take_id)).cloned().ok_or("找不到拍攝版本")?;
    if i > 0 {
        if let Some(source) = take["source_take"].as_str().filter(|s| !s.is_empty()) {
            if c["segments"][i - 1]["selected_take"] != source { return Err("這一版接的是不同的上一鏡，請先還原上一鏡版本或重新拍攝".into()); }
        }
    }
    if let Some(shape) = take["recipe"]["size"].as_array() {
        if c["size"].is_array() && c["size"].as_array() != Some(shape) { return Err("這個版本的畫面尺寸不同，不能混用接續資料".into()); }
        c["size"] = json!(shape);
    } else if c["size"].is_null() {
        return Err("舊版本沒有接續尺寸紀錄，請從第一鏡重新拍攝".into());
    }
    // RunningHub 版（recipe.where）沒有 latent：接下一段靠上一段的影片
    let rhub = take["recipe"]["where"] == "runninghub";
    for tag in if rhub { &["cut", "end"][..] } else { &["cut", "end", "lat"][..] } {
        let file = tx(&take["result"]["files"][tag]);
        if !safe_file(&file) || !dir.join(file).is_file() { return Err(format!("這個拍攝版本缺少 {tag} 檔案")); }
    }
    let changed = takes::select(&mut c["segments"][i], take_id, hc::RESULT_KEYS)?;
    if let Some(input) = take["recipe"]["segment"].as_object() {
        let draft: serde_json::Map<String, Value> = input.iter().filter(|(key,value)| c["segments"][i][key.as_str()] != **value)
            .map(|(key,_)| (key.clone(), c["segments"][i][key.as_str()].clone())).collect();
        if !draft.is_empty() { c["segments"][i]["draft"] = Value::Object(draft); }
        for key in ["secs","text","lines","last","entry","exit","inherit_entry"] {
            if let Some(value) = input.get(key) { c["segments"][i][key] = value.clone(); }
        }
    }

    // 雲端節點使用固定 latent 名稱；採用時由不可變版本恢復這個工作副本。
    if !rhub {
        let latent = tx(&c["segments"][i]["files"]["lat"]);
        copy_atomic(&dir.join(latent), &dir.join(hc::latent_name(i + 1)))?;
    }
    if changed { hc::reset_from(c, i + 1); }
    c["final"] = Value::Null;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archived_media_survives_retake_and_switching_restores_latent() {
        let dir = std::env::temp_dir().join(format!("paintdeck_h3_takes_{}", crate::director::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["seg01_cut.mp4", "seg01_end.mp4", "lat_00001.safetensors"] { std::fs::write(dir.join(f), b"first").unwrap(); }
        let mut c = json!({"size":[640,960],"segments":[{"status":"done","files":{"cut":"seg01_cut.mp4","end":"seg01_end.mp4","lat":"lat_00001.safetensors"}}, {"status":"todo"}]});
        preserve(&mut c["segments"][0], &dir).unwrap();
        let first = tx(&c["segments"][0]["selected_take"]);
        let old_file = tx(&c["segments"][0]["files"]["end"]);
        std::fs::write(dir.join("seg01_end.mp4"), b"second").unwrap();
        assert_eq!(std::fs::read(dir.join(old_file)).unwrap(), b"first");
        select(&mut c, &dir, 0, &first).unwrap();
        assert_eq!(std::fs::read(dir.join("lat_00001.safetensors")).unwrap(), b"first");
        assert!(!safe_file("../secret"));
    }
    #[test]
    fn cannot_adopt_a_take_from_another_predecessor() {
        let mut c = json!({"segments":[{"selected_take":"new-parent"},{"takes":[{"id":"x","source_take":"old-parent","result":{}}]}]});
        assert!(select(&mut c, Path::new("unused"), 1, "x").unwrap_err().contains("上一鏡"));
    }
}
