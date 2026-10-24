//! 聲音庫（2026-10-23）：角色的專屬聲音存起來，H3 素材板放進去當「取音色」或「原封不動放進去」，每一支片同一把聲音。
//!   GET    /api/voices                 清單＋TTS 接好了沒
//!   POST   /api/voices                 {name, desc, file_name, data_b64}：存一段聲音
//!   GET    /api/voices/{id}/file       聲音檔本身（網頁再送 /api/h3/media 放進素材板）
//!   DELETE /api/voices/{id}            搬到 待刪除\聲音庫\（不真的刪）
//!   POST   /api/voices/tts             {name, desc, text}：用 TTS 工作流「捏」一把聲音，存進聲音庫
//!   POST   /api/voices/tts_workflow    {file_name, data_b64}：設定 TTS 工作流（ComfyUI 存的 JSON，API 或一般格式都行）；{workflow:null}＝拿掉
//! TTS 工作流：任何 ComfyUI 的 TTS 工作流都行，文字欄位寫 {{text}}、聲音描述欄位寫 {{voice}}，要有存聲音的輸出節點（SaveAudio 這類）。
//! 存在 <資料>\voices\tts_workflow.json。還沒實測任何一個 TTS 節點（使用者：「先把框架弄好，至少要能支援就好」）。
use super::{bad, blocking, internal, not_found, ok, ApiResult, Body, Shared};
use crate::director::tx;
use axum::extract::{Path as UrlPath, State};
use axum::http::header;
use axum::response::IntoResponse;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// 一段聲音最大多大（說話樣本幾秒～幾十秒就夠）
const MAX_BYTES: usize = 30 * 1024 * 1024;
const AUDIO_EXT: &[&str] = &["wav", "mp3", "flac", "ogg", "m4a", "aac", "opus"];
/// ComfyUI 存聲音的輸出節點
const AUDIO_OUT: &[&str] = &["SaveAudio", "SaveAudioMP3", "SaveAudioOpus", "PreviewAudio"];

fn dir(app: &Shared) -> PathBuf {
    app.paths.data.join("voices")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn ext_of(name: &str) -> Option<String> {
    let e = Path::new(name).extension()?.to_str()?.to_lowercase();
    AUDIO_EXT.contains(&e.as_str()).then_some(e)
}

fn read_meta(d: &Path, id: &str) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(d.join(format!("{id}.json"))).ok()?).ok()
}

/// 存一段聲音＋說明：回傳那一筆
fn save(d: &Path, name: &str, desc: &str, ext: &str, bytes: &[u8], source: &str) -> Result<Value, String> {
    std::fs::create_dir_all(d).map_err(|e| format!("建不了聲音庫資料夾：{e}"))?;
    let id = format!("v{}_{:x}", chrono::Local::now().format("%Y%m%d%H%M%S"), rand::random::<u16>());
    let file = format!("{id}.{ext}");
    std::fs::write(d.join(&file), bytes).map_err(|e| format!("存不了聲音檔：{e}"))?;
    let meta = json!({"id": id, "name": name, "desc": desc, "file": file, "source": source, "created": chrono::Local::now().timestamp()});
    std::fs::write(d.join(format!("{id}.json")), serde_json::to_vec_pretty(&meta).unwrap_or_default()).map_err(|e| format!("存不了說明：{e}"))?;
    Ok(meta)
}

/// TTS 工作流檢查：要有 {{text}}、存聲音的節點；回傳看不懂的原因
pub fn check_tts(wf: &Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string(wf).unwrap_or_default();
    if !text.contains("{{text}}") {
        return Err("工作流裡找不到 {{text}}：在 ComfyUI 把要念的文字欄位改成 {{text}}（聲音描述欄位寫 {{voice}}），再「Export (API)」".into());
    }
    if !wf.values().any(|n| AUDIO_OUT.contains(&n["class_type"].as_str().unwrap_or(""))) {
        return Err(format!("工作流裡沒有存聲音的節點（{}）", AUDIO_OUT.join("、")));
    }
    Ok(())
}

/// 把 {{text}}、{{voice}} 換進工作流（JSON 字串裡換，跳脫照 JSON 規則）
pub fn fill_tts(wf: &Map<String, Value>, text: &str, voice: &str) -> Value {
    fn walk(v: &mut Value, text: &str, voice: &str) {
        match v {
            Value::String(s) => *s = s.replace("{{text}}", text).replace("{{voice}}", voice),
            Value::Array(a) => a.iter_mut().for_each(|x| walk(x, text, voice)),
            Value::Object(o) => o.values_mut().for_each(|x| walk(x, text, voice)),
            _ => {}
        }
    }
    let mut v = Value::Object(wf.clone());
    walk(&mut v, text, voice);
    v
}

fn tts_file(app: &Shared) -> PathBuf {
    dir(app).join("tts_workflow.json")
}

pub async fn list(State(app): State<Shared>) -> ApiResult {
    let d = dir(&app);
    let (voices, tts) = blocking(move || {
        let mut v: Vec<Value> = std::fs::read_dir(&d)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                let id = n.strip_suffix(".json")?;
                valid_id(id).then(|| read_meta(&d, id)).flatten()
            })
            .collect();
        v.sort_by_key(|m| -m["created"].as_i64().unwrap_or(0));
        let tts = std::fs::read(d.join("tts_workflow.json")).ok().and_then(|b| serde_json::from_slice::<Map<String, Value>>(&b).ok());
        (v, tts)
    })
    .await;
    let tts = match tts {
        None => json!({"ready": false, "why": "還沒接 TTS：在聲音庫選單按「匯入 TTS 工作流…」"}),
        Some(wf) => match check_tts(&wf) {
            Ok(()) => json!({"ready": true, "voice_field": serde_json::to_string(&wf).unwrap_or_default().contains("{{voice}}")}),
            Err(e) => json!({"ready": false, "why": e}),
        },
    };
    ok(json!({"voices": voices, "tts": tts}))
}

pub async fn add(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let name = tx(&b["name"]).trim().to_string();
    if name.is_empty() {
        return Err(bad("要取個名字（例：小克的聲音）"));
    }
    let ext = ext_of(&tx(&b["file_name"])).ok_or_else(|| bad(format!("聲音檔要是 {} 其中一種", AUDIO_EXT.join("、"))))?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(tx(&b["data_b64"]).as_bytes()).map_err(|_| bad("檔案內容讀不懂（base64 壞了）"))?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(bad(format!("聲音檔要在 {} MB 以內（說話樣本 5～30 秒就夠）", MAX_BYTES / 1024 / 1024)));
    }
    let (d, desc) = (dir(&app), tx(&b["desc"]).trim().to_string());
    let m = blocking(move || save(&d, &name, &desc, &ext, &bytes, "upload")).await.map_err(bad)?;
    ok(m)
}

pub async fn file(State(app): State<Shared>, UrlPath(id): UrlPath<String>) -> Result<axum::response::Response, super::ApiError> {
    if !valid_id(&id) {
        return Err(bad("聲音編號不對"));
    }
    let d = dir(&app);
    let m = read_meta(&d, &id).ok_or_else(|| not_found("聲音庫沒有這一筆"))?;
    let f = tx(&m["file"]);
    let bytes = tokio::fs::read(d.join(super::basename(&f))).await.map_err(|_| not_found("聲音檔不見了"))?;
    let mime = match ext_of(&f).as_deref() {
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("ogg") | Some("opus") => "audio/ogg",
        Some("m4a") | Some("aac") => "audio/mp4",
        _ => "audio/wav",
    };
    Ok(([(header::CONTENT_TYPE, mime)], bytes).into_response())
}

pub async fn remove(State(app): State<Shared>, UrlPath(id): UrlPath<String>) -> ApiResult {
    if !valid_id(&id) {
        return Err(bad("聲音編號不對"));
    }
    let (d, trash) = (dir(&app), app.paths.root.join("待刪除").join("聲音庫"));
    blocking(move || -> std::io::Result<()> {
        let m = read_meta(&d, &id).ok_or_else(|| std::io::Error::other("聲音庫沒有這一筆"))?;
        let to = trash.join(format!("{}_{id}", chrono::Local::now().format("%Y%m%d_%H%M%S")));
        std::fs::create_dir_all(&to)?;
        let f = tx(&m["file"]);
        std::fs::rename(d.join(super::basename(&f)), to.join(super::basename(&f)))?;
        std::fs::rename(d.join(format!("{id}.json")), to.join(format!("{id}.json")))
    })
    .await
    .map_err(internal)?;
    ok(json!({"ok": true}))
}

pub async fn set_tts(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let f = tts_file(&app);
    if b["workflow"].is_null() {
        let _ = std::fs::remove_file(&f);
        return ok(json!({"ok": true, "ready": false}));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(tx(&b["data_b64"]).as_bytes()).map_err(|_| bad("檔案內容讀不懂（base64 壞了）"))?;
    let imported = super::api_wf::file_to_api(&app, &tx(&b["file_name"]), bytes).await?;
    let wf = imported.graph.as_object().cloned().ok_or_else(|| bad("工作流轉換失敗"))?;
    check_tts(&wf).map_err(bad)?;
    std::fs::create_dir_all(dir(&app)).map_err(internal)?;
    std::fs::write(&f, serde_json::to_vec_pretty(&wf).unwrap_or_default()).map_err(internal)?;
    ok(json!({"ok": true, "ready": true}))
}

pub async fn tts(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let name = tx(&b["name"]).trim().to_string();
    let text = tx(&b["text"]).trim().to_string();
    let desc = tx(&b["desc"]).trim().to_string();
    if name.is_empty() || text.is_empty() {
        return Err(bad("要有名字和要念的句子"));
    }
    let wf: Map<String, Value> = std::fs::read(tts_file(&app))
        .ok()
        .and_then(|x| serde_json::from_slice(&x).ok())
        .ok_or_else(|| bad("還沒接 TTS：在聲音庫選單按「匯入 TTS 工作流…」，選 ComfyUI 存的 TTS 工作流（文字欄位寫 {{text}}、聲音描述寫 {{voice}}）"))?;
    check_tts(&wf).map_err(bad)?;
    if !app.comfy.live().online {
        return Err(bad("ComfyUI 沒有連線。解法：重新開啟「繪匣 PaintDeck」。"));
    }
    let nodes = fill_tts(&wf, &text, &desc);
    let pid = app.comfy.submit(&nodes, &json!({})).await.map_err(|e| bad(e.0))?;
    let h = super::api_play::wait_history(&app, &pid, "TTS ").await.map_err(bad)?;
    let mut got: Option<(Vec<u8>, String)> = None;
    for o in h["outputs"].as_object().into_iter().flat_map(|o| o.values()) {
        if let Some(a) = o["audio"].as_array().and_then(|a| a.first()) {
            let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
            let bytes = app.comfy.view(&s("filename"), &s("subfolder"), &s("type")).await.map_err(|e| bad(e.0))?;
            got = Some((bytes, ext_of(&s("filename")).unwrap_or_else(|| "flac".into())));
            break;
        }
    }
    let (bytes, ext) = got.ok_or_else(|| bad("TTS 工作流跑完了，但沒有存出聲音（看 ComfyUI 視窗）"))?;
    let d = dir(&app);
    let m = blocking(move || save(&d, &name, &desc, &ext, &bytes, "tts")).await.map_err(bad)?;
    ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tts_workflow_fill_and_check() {
        let wf: Map<String, Value> = serde_json::from_value(json!({
            "1": {"class_type": "SomeTTS", "inputs": {"text": "{{text}}", "instruct": "Voice: {{voice}}", "seed": 1}},
            "2": {"class_type": "SaveAudio", "inputs": {"audio": ["1", 0], "filename_prefix": "tts"}}
        }))
        .unwrap();
        assert!(check_tts(&wf).is_ok());
        let v = fill_tts(&wf, "嗨，我是\"小克\"", "low, sultry young woman");
        assert_eq!(v["1"]["inputs"]["text"], "嗨，我是\"小克\"");
        assert_eq!(v["1"]["inputs"]["instruct"], "Voice: low, sultry young woman");
        assert_eq!(v["1"]["inputs"]["seed"], 1);
        let mut no_out = wf.clone();
        no_out.remove("2");
        assert!(check_tts(&no_out).unwrap_err().contains("存聲音"));
        let mut no_text = wf.clone();
        no_text["1"]["inputs"]["text"] = json!("hello");
        assert!(check_tts(&no_text).unwrap_err().contains("{{text}}"));
        assert!(valid_id("v20261023_ab12") && !valid_id("../x") && !valid_id(""));
        assert_eq!(ext_of("a.WAV").as_deref(), Some("wav"));
        assert!(ext_of("a.exe").is_none());
    }

    #[test]
    fn save_and_read_back() {
        let d = std::env::temp_dir().join(format!("anima_voice_test_{}", std::process::id()));
        let m = save(&d, "小克", "low voice", "wav", b"RIFF", "upload").unwrap();
        let id = m["id"].as_str().unwrap();
        assert_eq!(read_meta(&d, id).unwrap()["name"], "小克");
        assert!(d.join(m["file"].as_str().unwrap()).is_file());
        let _ = std::fs::remove_dir_all(&d);
    }
}
