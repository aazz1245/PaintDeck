//! RunningHub（2026-10-27）：把生圖站自己組的 ComfyUI 節點圖整份丟上 RunningHub 跑（官方 OpenAPI 的 `workflow` 欄位），
//! 不用租整台機器、不用等下載模型，照秒扣 RH 幣。這裡只有純邏輯：網址、改素材名和模型名、解析回應。API 在 server\api_runninghub.rs。
//! 文件：https://www.runninghub.ai/runninghub-api-doc-en/ （國際版；中國版 runninghub.cn 路徑一樣）。
//! 消費級會員 Key（免費帳號也有，官方權益表寫 API 呼叫資格「無」、免費版並發 1）可以呼叫 ComfyUI 工作流 API，照秒扣 RH 幣；一個任務是一台新機器，所以長片那種「上一段的 latent 留在機器上」的接法不能用。
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// 站台：國際版（預設）、中國版
pub const SITES: &[(&str, &str)] = &[("ai", "www.runninghub.ai"), ("cn", "www.runninghub.cn")];
/// 機器：default＝24GB、plus＝48GB、ultra＝84GB（H3 至少要 plus）
pub const INSTANCES: &[&str] = &["default", "plus", "ultra"];
/// 每秒扣幾個 RH 幣：default／plus 照官方「API 金鑰呼叫權益比較」表（2026-10-27 使用者截圖：Standard 0.2、Plus 0.4）；ultra 表上沒寫，先抓兩倍，只拿來估價
pub const COINS_PER_SEC: &[(&str, f64)] = &[("default", 0.2), ("plus", 0.4), ("ultra", 0.8)];

/// 建任務一定要帶一個存在的 workflowId（只送 workflow 會回 301 must not be null），整份 workflow 會蓋掉它的內容。
/// 預設用官方文件範例那個公開工作流（2026-10-27 實測可用、失敗不扣幣）；設定裡可以換成自己帳號的
pub const DEFAULT_WORKFLOW: &str = "1904136902449209346";
/// RunningHub 上沒有 10Eros：預設改用它們公開 H3 工作流在用的主模型＋Turbo LoRA（2026-10-27 用 getJsonApiFormat 讀公開工作流查到的檔名）
pub const H3_MODEL: &str = "minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors";
pub const H3_TURBO: &str = "minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors";

/// H3 參數在 RunningHub 上跑：沒選模型就換成 RunningHub 有的，8 步以內補 Turbo LoRA
pub fn h3_defaults(p: &mut Value) {
    if p["model"].as_str().is_none_or(|m| m.trim().is_empty()) {
        p["model"] = json!(H3_MODEL);
    }
    let steps = p["steps"].as_i64().unwrap_or(8);
    let has = p["loras"].as_array().is_some_and(|a| a.iter().any(|l| l["name"].as_str() == Some(H3_TURBO)));
    if p["model"] == H3_MODEL && steps <= 10 && !has {
        let mut list = p["loras"].as_array().cloned().unwrap_or_default();
        list.insert(0, json!({"name": H3_TURBO, "strength": 1.0}));
        p["loras"] = json!(list);
    }
}

/// 要先上傳的素材欄位（LoadImage 的 image、LoadAudio 的 audio、LoadVideo 的 file／video）
const FILE_KEYS: &[&str] = &["image", "audio", "video", "file"];
/// 模型檔名欄位：RunningHub 上的檔名可能跟我們的不一樣，照使用者填的對照表換
const MODEL_KEYS: &[&str] = &["unet_name", "clip_name", "clip_name1", "clip_name2", "vae_name", "lora_name", "ckpt_name", "model_name"];

pub fn host(site: &str) -> &'static str {
    SITES.iter().find(|(k, _)| *k == site).map_or(SITES[0].1, |(_, h)| h)
}

pub fn base(site: &str) -> String {
    format!("https://{}", host(site))
}

pub fn instance(v: &str) -> &'static str {
    INSTANCES.iter().copied().find(|x| *x == v).unwrap_or("plus")
}

/// 節點圖裡用到的素材檔名（照出現順序、不重複）
pub fn input_files(nodes: &Map<String, Value>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for n in nodes.values() {
        let cls = n["class_type"].as_str().unwrap_or("");
        if !cls.starts_with("Load") || cls.contains("Latent") {
            continue;
        }
        for k in FILE_KEYS {
            if let Some(f) = n["inputs"][*k].as_str() {
                if !f.is_empty() && !out.iter().any(|x| x == f) {
                    out.push(f.to_string());
                }
            }
        }
    }
    out
}

/// 素材換成上傳後 RunningHub 給的名字；模型照對照表換（沒填的照舊）
pub fn rewrite(nodes: &mut Map<String, Value>, files: &HashMap<String, String>, models: &Map<String, Value>) {
    for n in nodes.values_mut() {
        let Some(inputs) = n.get_mut("inputs").and_then(Value::as_object_mut) else { continue };
        for (k, v) in inputs.iter_mut() {
            let Some(s) = v.as_str() else { continue };
            if FILE_KEYS.contains(&k.as_str()) {
                if let Some(to) = files.get(s) {
                    *v = json!(to);
                }
            } else if MODEL_KEYS.contains(&k.as_str()) {
                if let Some(to) = models.get(s).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
                    *v = json!(to);
                }
            }
        }
    }
}

/// POST /task/openapi/create 的內容：整份節點圖放 workflow（字串），不用先在網站存工作流
pub fn create_body(key: &str, nodes: &Map<String, Value>, inst: &str, workflow_id: &str) -> Value {
    let wid = Some(workflow_id.trim()).filter(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_digit())).unwrap_or(DEFAULT_WORKFLOW);
    json!({"apiKey": key, "workflowId": wid, "workflow": Value::Object(nodes.clone()).to_string(), "instanceType": instance(inst), "addMetadata": false})
}

/// 錯誤碼 → 看得懂的話（官方 API Error Code Reference）
pub fn err_msg(code: i64, msg: &str) -> String {
    let why = match code {
        801 => "RunningHub 說這個帳號的 API Key 不能呼叫（官方文件寫免費帳號不能用 API，要升級會員）",
        802 | 806 | 1002 => "API Key 不對或被停用：到 RunningHub 的 API Key 頁重新複製一次",
        416 | 812 => "RH 幣（錢包）不夠了：到 RunningHub 儲值或等每月的會員幣",
        421 | 415 | 1003 | 1011 => "RunningHub 現在同時跑的任務滿了：等一下再送",
        433 | 1101 => "RunningHub 檢查節點圖沒過（通常是那邊沒有這個節點或模型）",
        435 => "機器種類不對：H3 要選 48GB（plus）或 84GB（ultra）",
        809 | 1008 => "素材檔太大：RunningHub 收不下",
        1501 | 1505 => "RunningHub 的內容審核擋下來了",
        _ => "",
    };
    match (why.is_empty(), msg.trim().is_empty()) {
        (true, true) => format!("RunningHub 回錯誤 {code}"),
        (true, false) => format!("RunningHub 回錯誤 {code}：{}", msg.trim()),
        (false, true) => format!("{why}（{code}）"),
        (false, false) => format!("{why}（{code}：{}）", msg.trim()),
    }
}

fn code_of(v: &Value) -> i64 {
    v["code"].as_i64().or_else(|| v["code"].as_str().and_then(|s| s.parse().ok())).unwrap_or(-1)
}

/// 建任務的回應 → taskId。promptTips 裡有 node_errors 就把哪顆節點、哪個欄位錯講出來
pub fn parse_create(v: &Value) -> Result<String, String> {
    let code = code_of(v);
    if code != 0 {
        return Err(err_msg(code, v["msg"].as_str().unwrap_or("")));
    }
    let d = &v["data"];
    if let Some(tips) = d["promptTips"].as_str().and_then(|t| serde_json::from_str::<Value>(t).ok()) {
        let errs: Vec<String> = tips["node_errors"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(id, e)| {
                let why: Vec<String> = e["errors"].as_array().into_iter().flatten()
                    .map(|x| format!("{} {}", x["message"].as_str().unwrap_or(""), x["details"].as_str().unwrap_or("")).trim().to_string())
                    .collect();
                format!("節點 {id}（{}）：{}", e["class_type"].as_str().unwrap_or("?"), why.join("；"))
            })
            .collect();
        if !errs.is_empty() {
            return Err(format!("RunningHub 檢查節點圖沒過（多半是那邊沒有這個模型或節點；模型名可以在 RunningHub 設定的「模型對照」改）：{}", errs.join("｜")));
        }
    }
    match &d["taskId"] {
        Value::String(s) if !s.is_empty() => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err("RunningHub 沒回任務編號".into()),
    }
}

#[derive(Debug, PartialEq)]
pub struct Out {
    pub url: String,
    pub kind: String,
    pub node: String,
}

#[derive(Debug, PartialEq)]
pub enum Poll {
    Waiting(&'static str),
    Done(Vec<Out>),
    Failed(String),
}

/// POST /task/openapi/outputs 的回應：0＋有資料＝好了；804 跑著；813 排隊；805 失敗（failedReason 有哪顆節點、什麼錯）
pub fn parse_outputs(v: &Value) -> Poll {
    let code = code_of(v);
    match code {
        0 => {
            let outs: Vec<Out> = v["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| {
                    let url = o["fileUrl"].as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://"))?;
                    Some(Out { url: url.to_string(), kind: o["fileType"].as_str().unwrap_or("").to_string(), node: o["nodeId"].as_str().map(str::to_string).or_else(|| o["nodeId"].as_i64().map(|n| n.to_string())).unwrap_or_default() })
                })
                .collect();
            if outs.is_empty() { Poll::Waiting("等 RunningHub 給成品…") } else { Poll::Done(outs) }
        }
        804 => Poll::Waiting("RunningHub 跑著…"),
        813 => Poll::Waiting("RunningHub 排隊中…"),
        805 => {
            let r = &v["data"]["failedReason"];
            let node = r["node_name"].as_str().unwrap_or("");
            let msg = r["exception_message"].as_str().unwrap_or("").trim();
            Poll::Failed(match (node.is_empty(), msg.is_empty()) {
                (true, true) => "RunningHub 上的任務失敗或被取消了".into(),
                _ => format!("RunningHub 上的任務失敗：{node} {msg}").trim().to_string(),
            })
        }
        _ => Poll::Failed(err_msg(code, v["msg"].as_str().unwrap_or(""))),
    }
}

/// 成品存回本機用的位置：封面（節點的 filename_prefix 是 AnimaWeb/_poster/…）照 ComfyUI 的命名放回 _poster，其他照網址的檔名
pub fn local_name(nodes: &Map<String, Value>, out: &Out) -> (String, String) {
    let tail = out.url.split(['?', '#']).next().unwrap_or("").rsplit('/').next().unwrap_or("").to_string();
    let ext = tail.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()));
    let prefix = nodes.get(&out.node).and_then(|n| n["inputs"]["filename_prefix"].as_str()).unwrap_or("");
    if let Some(p) = prefix.strip_prefix("AnimaWeb/_poster/") {
        return ("AnimaWeb/_poster".into(), format!("{p}_00001_.{}", ext.as_deref().unwrap_or("png")));
    }
    let safe: String = tail.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')).collect();
    let safe = safe.trim_start_matches('.').to_string();
    let name = if safe.trim_matches('.').is_empty() { format!("runninghub.{}", ext.as_deref().unwrap_or("bin")) } else { safe };
    (String::new(), name)
}

/// 估價：秒數 × 每秒幣數
pub fn coins_for(inst: &str, secs: f64) -> f64 {
    let rate = COINS_PER_SEC.iter().find(|(k, _)| *k == instance(inst)).map_or(0.4, |(_, r)| *r);
    (secs.max(0.0) * rate * 10.0).round() / 10.0
}

/// multipart/form-data（上傳素材用；reqwest 沒開 multipart 功能，自己組）
pub fn multipart(boundary: &str, fields: &[(&str, &str)], file_field: &str, file_name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(bytes.len() + 512);
    for (k, v) in fields {
        b.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes());
    }
    let mime = match file_name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("mp4") => "video/mp4",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        _ => "application/octet-stream",
    };
    let safe: String = file_name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')).collect();
    b.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{safe}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
    b.extend_from_slice(bytes);
    b.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph() -> Map<String, Value> {
        json!({
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "h3_bf16.safetensors", "weight_dtype": "default"}},
            "2": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
            "3": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
            "4": {"class_type": "LoadAudio", "inputs": {"audio": "v.wav"}},
            "5": {"class_type": "H3ContinuousLoadLatent", "inputs": {"latent_path": "x/lat.safetensors"}},
            "6": {"class_type": "SaveImage", "inputs": {"images": ["2", 0], "filename_prefix": "AnimaWeb/_poster/abc123"}},
            "7": {"class_type": "SaveVideo", "inputs": {"video": ["9", 0], "filename_prefix": "AnimaWeb/video"}},
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn inputs_are_listed_once_and_rewritten_with_models() {
        let mut g = graph();
        assert_eq!(input_files(&g), ["a.png", "v.wav"]);
        let files = HashMap::from([("a.png".to_string(), "api/9f.png".to_string())]);
        let models = json!({"h3_bf16.safetensors": "minimax/h3_bf16.safetensors", "nope.safetensors": ""});
        rewrite(&mut g, &files, models.as_object().unwrap());
        assert_eq!(g["2"]["inputs"]["image"], "api/9f.png");
        assert_eq!(g["3"]["inputs"]["image"], "api/9f.png");
        assert_eq!(g["4"]["inputs"]["audio"], "v.wav", "沒上傳的不動");
        assert_eq!(g["1"]["inputs"]["unet_name"], "minimax/h3_bf16.safetensors");
        assert_eq!(g["6"]["inputs"]["filename_prefix"], "AnimaWeb/_poster/abc123", "存檔名不是模型也不是素材");
        let body = create_body("k", &g, "weird", "abc");
        assert_eq!(body["instanceType"], "plus", "亂填的機器種類退回 48GB");
        assert_eq!(body["workflowId"], DEFAULT_WORKFLOW, "不是數字的工作流編號用預設");
        assert_eq!(create_body("k", &g, "plus", " 123 ")["workflowId"], "123");
        let mut p = json!({"steps": 8});
        h3_defaults(&mut p);
        assert_eq!(p["model"], H3_MODEL);
        assert_eq!(p["loras"][0]["name"], H3_TURBO);
        h3_defaults(&mut p);
        assert_eq!(p["loras"].as_array().unwrap().len(), 1, "不重複補");
        let mut own = json!({"model": "mine.safetensors", "steps": 8});
        h3_defaults(&mut own);
        assert!(own.get("loras").is_none(), "自己選的模型不動");
        let back: Value = serde_json::from_str(body["workflow"].as_str().unwrap()).unwrap();
        assert_eq!(back["2"]["inputs"]["image"], "api/9f.png");
        assert_eq!(host("cn"), "www.runninghub.cn");
        assert_eq!(base("x"), "https://www.runninghub.ai");
    }

    #[test]
    fn create_reply_reports_task_or_node_errors() {
        let ok = json!({"code": 0, "msg": "success", "data": {"taskId": "1910246754753896450", "taskStatus": "QUEUED", "promptTips": "{\"result\": true, \"error\": null, \"outputs_to_execute\": [\"9\"], \"node_errors\": {}}"}});
        assert_eq!(parse_create(&ok).unwrap(), "1910246754753896450");
        assert_eq!(parse_create(&json!({"code": 0, "data": {"taskId": 42}})).unwrap(), "42");
        let bad = json!({"code": 0, "data": {"taskId": "1", "promptTips": "{\"node_errors\": {\"1\": {\"class_type\": \"UNETLoader\", \"errors\": [{\"message\": \"Value not in list\", \"details\": \"unet_name: 'h3.safetensors' not in []\"}]}}}"}});
        let e = parse_create(&bad).unwrap_err();
        assert!(e.contains("節點 1（UNETLoader）") && e.contains("not in list") && e.contains("模型對照"), "{e}");
        let free = parse_create(&json!({"code": 801, "msg": "APIKEY_UNSUPPORTED_FREE_USER"})).unwrap_err();
        assert!(free.contains("不能呼叫") && free.contains("801"), "{free}");
        assert!(parse_create(&json!({"code": 999, "msg": ""})).unwrap_err().contains("999"));
    }

    #[test]
    fn outputs_reply_states() {
        assert_eq!(parse_outputs(&json!({"code": 804, "msg": "APIKEY_TASK_IS_RUNNING"})), Poll::Waiting("RunningHub 跑著…"));
        assert_eq!(parse_outputs(&json!({"code": 813})), Poll::Waiting("RunningHub 排隊中…"));
        assert_eq!(parse_outputs(&json!({"code": 0, "data": []})), Poll::Waiting("等 RunningHub 給成品…"));
        let done = parse_outputs(&json!({"code": 0, "data": [
            {"fileUrl": "https://rh-images.xiaoyaoyou.com/x/output/AnimaWeb_video_00001_.mp4", "fileType": "mp4", "taskCostTime": "212", "nodeId": "7"},
            {"fileUrl": "javascript:alert(1)", "fileType": "png", "nodeId": "6"}]}));
        assert_eq!(done, Poll::Done(vec![Out { url: "https://rh-images.xiaoyaoyou.com/x/output/AnimaWeb_video_00001_.mp4".into(), kind: "mp4".into(), node: "7".into() }]));
        match parse_outputs(&json!({"code": 805, "data": {"failedReason": {"node_name": "SamplerCustomAdvanced", "exception_message": "CUDA out of memory"}}})) {
            Poll::Failed(m) => assert!(m.contains("SamplerCustomAdvanced") && m.contains("out of memory"), "{m}"),
            p => panic!("{p:?}"),
        }
        assert!(matches!(parse_outputs(&json!({"code": 416, "msg": "TASK_CREATE_FAILED_BY_NOT_ENOUGH_WALLET"})), Poll::Failed(m) if m.contains("RH 幣")));
    }

    #[test]
    fn outputs_land_where_comfy_would_put_them() {
        let g = graph();
        let poster = Out { url: "https://cdn.example/out/abc123_00001_.PNG?sign=1".into(), kind: "png".into(), node: "6".into() };
        assert_eq!(local_name(&g, &poster), ("AnimaWeb/_poster".into(), "abc123_00001_.png".into()));
        let vid = Out { url: "https://cdn.example/out/AnimaWeb_video_00001_.mp4".into(), kind: "mp4".into(), node: "7".into() };
        assert_eq!(local_name(&g, &vid), (String::new(), "AnimaWeb_video_00001_.mp4".into()));
        let odd = Out { url: "https://cdn.example/out/..%2F..%2Fevil".into(), kind: "".into(), node: "99".into() };
        let (sub, name) = local_name(&g, &odd);
        assert!(sub.is_empty() && !name.contains('/') && !name.contains('\\') && !name.starts_with(".."), "{name}");
        assert_eq!(coins_for("plus", 300.0), 120.0);
        assert_eq!(coins_for("default", 10.0), 2.0);
    }

    #[test]
    fn multipart_body_has_fields_and_file() {
        let b = multipart("BND", &[("apiKey", "k"), ("fileType", "input")], "file", "a b.png", b"PNGDATA");
        let s = String::from_utf8_lossy(&b);
        assert!(s.starts_with("--BND\r\nContent-Disposition: form-data; name=\"apiKey\"\r\n\r\nk\r\n"));
        assert!(s.contains("name=\"file\"; filename=\"ab.png\"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--BND--\r\n"), "{s}");
    }
}
