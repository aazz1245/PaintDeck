//! H3 影片台的 API（2026-10-22）：導演頁的「H3 影片」分頁。設計在 design\H3影片台設計.md。
//! 節點圖在 h3.rs；雲端的上傳素材、送圖收成品在 api_cloud.rs（upload_input、run_graph）。
//!
//! - GET  /api/h3/info：玩法範本、雲端／本機能不能跑、有哪些模型
//! - POST /api/h3/media：素材（圖庫的圖或影片、上傳的檔）放進 input，影片轉 24fps、截到 15 秒
//! - POST /api/h3/generate：背景送出（雲端或本機），進度從 websocket 收 type=h3
//! - POST /api/h3/stop：停掉某個工作
//! - POST /api/h3/write：用改寫腦袋把中文想法寫成 H3 官方格式的提示詞
use super::{bad, blocking, ok, ApiResult, Body, Shared};
use crate::director::tx;
use crate::h3;
use axum::extract::State;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// 玩法牆的範本（resources\h3\templates.json）
const TEMPLATES: &str = include_str!("../../../resources/h3/templates.json");
/// 要雲端勾「H3 進階包」才有的玩法
pub const ADVANCED: &[&str] = &["swap", "vfx", "style", "live", "control"];
/// 一次最多出幾支
const MAX_COUNT: i64 = 4;
/// 參考素材最長幾秒（H3 每段參考 2～15 秒）
const MAX_SECS: f64 = 15.0;

#[derive(Default)]
pub struct H3 {
    tasks: Mutex<HashMap<String, CancellationToken>>,
}

impl H3 {
    pub(crate) fn put(&self, id: &str, t: CancellationToken) {
        self.tasks.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), t);
    }
    pub(crate) fn take(&self, id: &str) -> Option<CancellationToken> {
        self.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove(id)
    }
    /// 這個工作的停止信號（不除名：停止要等背景工作自己收尾、除名）
    pub(crate) fn token(&self, id: &str) -> Option<CancellationToken> {
        self.tasks.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }
    /// 這個工作還在跑
    pub(crate) fn has(&self, id: &str) -> bool {
        self.tasks.lock().unwrap_or_else(|e| e.into_inner()).contains_key(id)
    }
    /// 有工作在跑（上傳素材、等雲端）：雲端閒置自動關機要算它在忙
    pub fn any_running(&self) -> bool {
        !self.tasks.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }
}

fn emit(app: &Shared, task: &str, state: &str, msg: impl Into<String>, extra: Value) {
    let mut v = json!({"type": "h3", "task": task, "state": state, "msg": msg.into()});
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        for (k, x) in e {
            o.insert(k.clone(), x.clone());
        }
    }
    app.hub.send(v);
}

/// 雲端或 ComfyUI 的錯誤 → 白話（顯存不夠、模型沒裝）
pub fn friendly_error(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("out of memory") || l.contains("outofmemory") || l.contains("allocation on device") {
        return format!("顯存不夠：改成「標準」或「快速」畫質、縮短秒數，或換 RTX PRO 6000 96GB 的卡（原始訊息：{}）", short(e));
    }
    if l.contains("value not in list") && (l.contains("h3") || l.contains("10eros") || l.contains("minimax")) {
        return format!("雲端或本機沒有這個 H3 模型或 LoRA：雲端的話到「雲端設定」勾 H3 影片包（進階玩法要勾 H3 進階包）再開機（原始訊息：{}）", short(e));
    }
    if l.contains("does not exist") && l.contains("class_type") || l.contains("node") && l.contains("not found") {
        return format!("缺 H3 需要的節點：雲端要勾 H3 影片包；本機的 ComfyUI 要更新到有 MiniMax H3 節點的版本（原始訊息：{}）", short(e));
    }
    e.to_string()
}

fn short(e: &str) -> String {
    e.chars().take(300).collect()
}

// ---------------------------------------------------------------- 素材
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Kind {
    Image,
    Video,
    Audio,
}

pub fn kind_of(name: &str) -> Option<Kind> {
    let ext = Path::new(name).extension()?.to_str()?.to_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" => Some(Kind::Image),
        "mp4" | "webm" | "mov" | "mkv" | "m4v" | "gif" => Some(Kind::Video),
        "wav" | "mp3" | "flac" | "ogg" | "m4a" | "aac" | "opus" => Some(Kind::Audio),
        _ => None,
    }
}

/// 送出的素材名：只收 /api/h3/media 放進 input 的檔（h3_ 開頭、沒有路徑、認得的副檔名）
fn media_name_ok(n: &str) -> bool {
    n.starts_with("h3_") && !n.contains(['/', '\\']) && super::basename(n) == n && kind_of(n).is_some()
}

/// 轉檔的暫存檔：同一個資料夾、每次不同名（h3_xx.<亂數>.part.mp4），轉成功才改名成正式檔
fn part_path(dst: &Path) -> PathBuf {
    let stem = dst.file_stem().and_then(|s| s.to_str()).unwrap_or("h3");
    let ext = dst.extension().and_then(|s| s.to_str()).unwrap_or("bin");
    dst.with_file_name(format!("{stem}.{:x}.part.{ext}", super::api_director::random_seed()))
}

/// ffmpeg 正規化素材的參數：影片轉 24fps（H3 只認 24）、截到 15 秒、H.264＋AAC；聲音截到 15 秒、轉成 wav
pub fn ffmpeg_args(src: &Path, dst: &Path, kind: Kind) -> Vec<String> {
    // 只准讀本機檔（素材是使用者給的檔，不讓它帶 ffmpeg 去連別的網址）
    let mut a: Vec<String> =
        ["-y", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-i"].map(String::from).into_iter().chain([src.display().to_string()]).collect();
    let secs = format!("{MAX_SECS}");
    match kind {
        Kind::Video => a.extend(
            ["-t", &secs, "-map", "0:v:0", "-map", "0:a:0?", "-r", "24", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
                .map(String::from),
        ),
        Kind::Audio => a.extend(["-t", &secs, "-vn", "-ac", "2", "-ar", "48000"].map(String::from)),
        Kind::Image => {}
    }
    a.push(dst.display().to_string());
    a
}

fn run_tool(exe: &Path, args: &[String]) -> Result<String, String> {
    let mut c = std::process::Command::new(exe);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().map_err(|e| format!("執行 {} 失敗：{e}", exe.display()))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).chars().take(400).collect());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// ffprobe：(寬, 高, 秒數, 有沒有聲音)
fn probe(ffprobe: &Path, f: &Path) -> Result<(i64, i64, f64, bool), String> {
    let out = run_tool(
        ffprobe,
        &["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json"].map(String::from).into_iter().chain([f.display().to_string()]).collect::<Vec<_>>(),
    )?;
    let v: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let vid = streams.iter().find(|s| s["codec_type"] == "video");
    let w = vid.and_then(|s| s["width"].as_i64()).unwrap_or(0);
    let h = vid.and_then(|s| s["height"].as_i64()).unwrap_or(0);
    let secs = tx(&v["format"]["duration"]).parse().unwrap_or(0.0);
    let audio = streams.iter().any(|s| s["codec_type"] == "audio");
    Ok((w, h, secs, audio))
}

/// {gallery_id} 或 {file_name, data_b64}：素材放進 input（h3_<雜湊>.<副檔名>），回 {name, kind, w, h, secs, audio}
pub async fn media(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let (bytes, orig) = if let Some(id) = b.get("gallery_id").and_then(crate::py::int) {
        let r = app.db.image(id)?.ok_or_else(|| super::not_found("找不到這個圖庫項目"))?;
        let f = super::api_gallery::file_of(&app.paths, &r);
        let name = f.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let data = tokio::fs::read(&f).await.map_err(|_| bad("這個圖庫項目的檔案已經不在硬碟上了"))?;
        (data, name)
    } else {
        let name = tx(&b["file_name"]);
        let data = base64::engine::general_purpose::STANDARD.decode(tx(&b["data_b64"]).as_bytes()).map_err(|_| bad("檔案內容讀不懂（base64 壞了）"))?;
        if data.is_empty() {
            return Err(bad("檔案是空的"));
        }
        (data, name)
    };
    let kind = kind_of(&orig).ok_or_else(|| bad(format!("不認得這種檔案：{orig}（圖：png、jpg、webp；影片：mp4、webm、mov；聲音：wav、mp3、flac、m4a）")))?;
    let hash = Sha256::digest(&bytes).iter().take(6).map(|b| format!("{b:02x}")).collect::<String>();
    let ext = Path::new(&orig).extension().and_then(|e| e.to_str()).unwrap_or("bin").to_lowercase();
    let input = app.paths.input.clone();
    let tools = crate::studio::tools(&app.paths.data);
    let r = blocking(move || -> Result<Value, String> {
        std::fs::create_dir_all(&input).map_err(|e| e.to_string())?;
        if kind == Kind::Image {
            let name = format!("h3_{hash}.{ext}");
            let dst = input.join(&name);
            if !dst.exists() {
                std::fs::write(&dst, &bytes).map_err(|e| format!("存素材失敗：{e}"))?;
            }
            let (w, h) = image::image_dimensions(&dst).map_err(|e| format!("這張圖讀不懂：{e}"))?;
            return Ok(json!({"name": name, "kind": "image", "w": w, "h": h, "secs": 0, "audio": false}));
        }
        let ffmpeg = tools.ffmpeg.clone().ok_or("找不到 ffmpeg：到剪輯台按「下載剪輯工具」，或打開「安裝與修復」再按一次開始安裝")?;
        let ffprobe = tools.ffprobe.clone().ok_or("找不到 ffprobe")?;
        let (name, k) = if kind == Kind::Video { (format!("h3_{hash}.mp4"), "video") } else { (format!("h3_{hash}.wav"), "audio") };
        let dst = input.join(&name);
        if !dst.exists() {
            // 原檔、轉出來的檔都用各自的暫存名：同一個檔同時放兩格也不會互蓋；轉成功才改成正式檔名（失敗不留半截檔）
            let part = part_path(&dst);
            let src = part.with_extension(format!("src.{ext}"));
            std::fs::write(&src, &bytes).map_err(|e| format!("存素材失敗：{e}"))?;
            let res = run_tool(&ffmpeg, &ffmpeg_args(&src, &part, kind)).and_then(|_| std::fs::rename(&part, &dst).map_err(|e| e.to_string()));
            let _ = std::fs::remove_file(&src);
            if let Err(e) = res {
                let _ = std::fs::remove_file(&part);
                return Err(format!("轉檔失敗：{e}"));
            }
        }
        let (w, h, secs, audio) = probe(&ffprobe, &dst)?;
        if secs < 2.0 && kind == Kind::Video {
            return Err(format!("參考影片太短（{secs:.1} 秒）：H3 要 2～15 秒"));
        }
        Ok(json!({"name": name, "kind": k, "w": w, "h": h, "secs": secs, "audio": audio || kind == Kind::Audio}))
    })
    .await
    .map_err(bad)?;
    ok(r)
}

/// params 裡用到的所有素材檔名（雲端要先上傳）
pub fn media_names(p: &Value) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut add = |v: &Value| {
        if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            if !out.iter().any(|x| x == s) {
                out.push(s.to_string());
            }
        }
    };
    for k in ["first", "last", "source", "prev"] {
        add(&p[k]);
    }
    for k in ["images", "videos", "audios"] {
        for v in p["refs"][k].as_array().into_iter().flatten() {
            add(v);
        }
    }
    for k in p["keys"].as_array().into_iter().flatten() {
        add(&k["image"]);
    }
    for it in p["items"].as_array().into_iter().flatten() {
        add(&it["name"]);
    }
    out
}

/// 雲端要勾「H3 進階玩法」才有的東西：舊玩法看模式；素材板看有沒有用社群 LoRA（換角色、特效、換畫風、動態桌布）或骨架控制
pub fn needs_advanced(p: &Value) -> bool {
    let mode = mode_of(p);
    if mode != "board" {
        return ADVANCED.contains(&mode.as_str());
    }
    let items = p["items"].as_array().cloned().unwrap_or_default();
    !tx(&p["lora_mode"]).is_empty()
        || items.iter().any(|it| tx(&it["use"]) == "control" || (tx(&it["use"]) == "guide" && !tx(&it["lora"]).is_empty()))
}

// ---------------------------------------------------------------- 資訊
fn h3ish(n: &str) -> bool {
    let l = n.to_lowercase();
    l.contains("h3") || l.contains("10eros") || l.contains("minimax")
}

/// 本機 ComfyUI 有沒有 H3 節點
async fn local_nodes(app: &Shared) -> bool {
    app.comfy.options("MiniMaxH3ReferenceToVideo", "ref_image_size").await.map(|v| !v.is_empty()).unwrap_or(false)
}

/// 本機的 H3 模型：一般檔＋GGUF 量化版（裝了 ComfyUI-GGUF 才有 UnetLoaderGGUF）
async fn local_models(app: &Shared) -> Vec<String> {
    let mut v = app.comfy.options("UNETLoader", "unet_name").await.unwrap_or_default();
    v.extend(app.comfy.options("UnetLoaderGGUF", "unet_name").await.unwrap_or_default());
    v.into_iter().filter_map(|x| x.as_str().map(str::to_owned)).filter(|n| h3ish(n)).collect()
}

/// 生成頁的比例 → H3 的比例選項（挑最接近的）
fn aspect_of(p: &Map<String, Value>) -> &'static str {
    let n = |k: &str| p.get(k).and_then(Value::as_f64).filter(|x| *x > 0.0);
    let Some(r) = n("width").zip(n("height")).map(|(w, h)| w / h) else { return "16:9" };
    [("16:9", 16.0 / 9.0), ("9:16", 9.0 / 16.0), ("1:1", 1.0), ("4:3", 4.0 / 3.0), ("3:4", 3.0 / 4.0), ("21:9", 21.0 / 9.0)]
        .into_iter()
        .min_by(|a, b| (a.1 - r).abs().total_cmp(&(b.1 - r).abs()))
        .map(|a| a.0)
        .unwrap_or("16:9")
}

/// 生成頁「動起來」選了 H3（video_engine "h3"）：生成頁的參數換成 H3 的。
/// 有首幀＝圖生影片、沒有＝文生影片；480p＝快速、其他＝高畫質；提示詞沒照 H3 格式就包成一個鏡頭；
/// 沒指定 h3_model 時本機有 GGUF 量化版就用它（8GB 卡跑得動，3 秒約 15 分鐘）
pub fn from_gen(p: &Map<String, Value>, local_models: &[String]) -> Result<Value, String> {
    let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let raw = s("prompt");
    if raw.is_empty() {
        return Err("請寫動作和聲音的描述".into());
    }
    let prompt = if raw.contains("integrated_multimodal_description") {
        raw
    } else {
        format!("integrated_multimodal_description: [Shot 1] {raw}\n\noverall_soundscape: natural sounds that match the scene.\n\nnon_diegetic_music: N/A")
    };
    let first = s("init_image");
    if first.contains(['/', '\\']) || first.contains("..") {
        return Err(format!("首幀圖名稱不對：{first}"));
    }
    let model = match s("h3_model") {
        m if !m.is_empty() => m,
        _ => local_models.iter().find(|m| m.to_lowercase().ends_with(".gguf")).cloned().unwrap_or_else(|| h3::MODEL.to_string()),
    };
    let mut h = json!({
        "h3_mode": if first.is_empty() { "t2v" } else { "i2v" },
        "prompt": prompt,
        "seconds": p.get("video_seconds").and_then(Value::as_f64).unwrap_or(5.0).clamp(1.0, 15.0),
        "quality": if s("video_res") == "480p" { "fast" } else { "high" },
        "aspect": aspect_of(p),
        "model": model,
        "steps": 8, "sampler": "res_multistep", "scheduler": "simple",
        "seed": p.get("seed").and_then(crate::py::int).filter(|x| *x >= 0).unwrap_or_else(super::api_director::random_seed),
        "mode": "video", "video_engine": "h3", "save_last": true, "idea": s("idea"),
    });
    if !first.is_empty() {
        h["first"] = json!(first);
    }
    Ok(h)
}

/// 生成頁送來的 H3 影片：換成 H3 參數，排進本機 ComfyUI；回傳跟生成頁一樣的 [{job, seed}]
pub async fn submit_from_gen(app: &Shared, p: &Map<String, Value>, count: i64) -> Result<Vec<Value>, super::ApiError> {
    if !app.comfy.live().online {
        return Err(bad("ComfyUI 沒有連線。解法：重新開啟「繪匣 PaintDeck」。"));
    }
    if !local_nodes(app).await {
        return Err(bad("本機的 ComfyUI 沒有 MiniMax H3 節點：更新 ComfyUI，或改用 LTX"));
    }
    let models = local_models(app).await;
    let h = from_gen(p, &models).map_err(bad)?;
    let m = h["model"].as_str().unwrap_or("").to_string();
    if !models.contains(&m) {
        return Err(bad(format!("本機 ComfyUI 找不到 H3 模型 {m}：到「導演 → H3 影片」看說明下載，或改用 LTX")));
    }
    {
        let (hh, input) = (h.clone(), app.paths.input.clone());
        blocking(move || h3::build(&hh, &input, 0)).await.map_err(|e| bad(e.0))?;
    }
    let r = run_local(app, &h, count.clamp(1, MAX_COUNT)).await.map_err(bad)?;
    let seed = h["seed"].as_i64().unwrap_or(0);
    Ok(r["jobs"].as_array().into_iter().flatten().enumerate().map(|(i, j)| json!({"job": j, "seed": seed + i as i64})).collect())
}

pub async fn info(State(app): State<Shared>) -> ApiResult {
    let templates: Value = serde_json::from_str(TEMPLATES).unwrap_or(json!([]));
    let live = app.agent.cloud.live_packs();
    let (cloud_models, cloud_loras, cloud_selflift) = if live.is_some_and(|p| p.h3) {
        (
            [
                super::api_cloud::remote_options(&app, "UNETLoader", "unet_name").await,
                super::api_cloud::remote_options(&app, "UnetLoaderGGUF", "unet_name").await,
            ]
            .concat()
            .into_iter()
            .filter(|n| h3ish(n))
            .collect::<Vec<_>>(),
            super::api_cloud::remote_options(&app, "LoraLoaderModelOnly", "lora_name").await,
            !super::api_cloud::remote_options(&app, "SelfLiftH3Sampler", "upscaler_model").await.is_empty(),
        )
    } else {
        (vec![], vec![], false)
    };
    let online = app.comfy.live().online;
    let names = |v: Vec<Value>| v.into_iter().filter_map(|x| x.as_str().map(str::to_owned)).collect::<Vec<_>>();
    let (local_nodes, local_models, local_loras, local_selflift) = if online {
        let nodes = local_nodes(&app).await;
        let models = local_models(&app).await;
        let loras = names(app.comfy.options("LoraLoaderModelOnly", "lora_name").await.unwrap_or_default());
        // 「SelfLift 兩段取樣」要裝 SelfLiftH3Sampler 自訂節點
        let selflift = app.comfy.options("SelfLiftH3Sampler", "upscaler_model").await.map(|v| !v.is_empty()).unwrap_or(false);
        (nodes, models, loras, selflift)
    } else {
        (false, vec![], vec![], false)
    };
    ok(json!({
        "templates": templates,
        "modes": h3::MODES,
        "advanced": ADVANCED,
        "cloud": app.agent.cloud.status(),
        "cloud_packs": live.map(|p| p.to_value()),
        "cloud_models": cloud_models,
        "cloud_loras": cloud_loras,
        "cloud_selflift": cloud_selflift,
        "local": {"online": online, "nodes": local_nodes, "models": local_models, "loras": local_loras, "selflift": local_selflift},
        "defaults": {"model": h3::MODEL, "official_ref2va": h3::OFFICIAL_REF2VA, "steps": 8, "sampler": "res_multistep", "scheduler": "simple",
                     "seconds": 5, "quality": "std", "aspect": "16:9", "mode_loras": h3::MODE_LORAS.iter().map(|(m, f, t)| json!({"mode": m, "file": f, "trigger": t})).collect::<Vec<_>>()},
    }))
}

// ---------------------------------------------------------------- 送出
fn mode_of(p: &Value) -> String {
    match tx(&p["h3_mode"]).as_str() {
        "" => "t2v".into(),
        m => m.to_string(),
    }
}

/// {params, count, where: "cloud"|"local"} → {task}；背景跑，進度：{"type":"h3","task","state":"queued|running|done|queued_local|error|stopped","msg", "ids"?/"jobs"?}
pub async fn generate(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let Some(Value::Object(mut p)) = b.get("params").cloned() else {
        return Err(bad("送來的資料格式不對：缺少 params"));
    };
    let count = b.get("count").and_then(crate::py::int).unwrap_or(1).clamp(1, MAX_COUNT);
    let cloud = b["where"] != "local";
    if p.get("seed").and_then(crate::py::int).is_none_or(|s| s < 0) {
        p.insert("seed".into(), json!(super::api_director::random_seed()));
    }
    p.insert("mode".into(), json!("video"));
    p.insert("video_engine".into(), json!("h3"));
    p.insert("save_last".into(), json!(true));
    let p = Value::Object(p);
    let mode = mode_of(&p);
    let names = media_names(&p);
    if let Some(n) = names.iter().find(|n| !media_name_ok(n)) {
        return Err(bad(format!("素材名稱不對：{n}（素材要從格子放，不能手填路徑）")));
    }
    // 先組一次：參數錯了直接回錯誤，不用等背景
    {
        let (pp, input) = (p.clone(), app.paths.input.clone());
        blocking(move || h3::build(&pp, &input, 0)).await.map_err(|e| bad(e.0))?;
    }
    for n in &names {
        if !app.paths.input.join(n).is_file() {
            return Err(bad(format!("素材 {n} 不見了：重新放一次")));
        }
    }
    if cloud {
        let packs = app.agent.cloud.live_packs().ok_or_else(|| bad("雲端還沒開好：按「開雲端」，等燈號變綠"))?;
        if !packs.h3 {
            return Err(bad("雲端這台沒裝 H3 影片包：關機後到雲端設定勾「H3 影片」再開"));
        }
        if needs_advanced(&p) && !packs.h3x {
            return Err(bad("這個玩法要「H3 進階包」：關機後到雲端設定勾「H3 進階玩法」再開"));
        }
    } else {
        if !app.comfy.live().online {
            return Err(bad("本機的 ComfyUI 沒有連線"));
        }
        let ok_nodes = app.comfy.options("MiniMaxH3ReferenceToVideo", "ref_image_size").await.map(|v| !v.is_empty()).unwrap_or(false);
        if !ok_nodes {
            return Err(bad("本機的 ComfyUI 沒有 MiniMax H3 節點：更新 ComfyUI，或改用雲端"));
        }
    }
    let task = format!("h3-{:x}", super::api_director::random_seed());
    let token = CancellationToken::new();
    if cloud {
        // 從現在起算在用（閒置自動關機也會看 app.h3 有沒有工作）
        app.agent.cloud.touch();
    }
    app.h3.put(&task, token.clone());
    emit(&app, &task, "queued", if cloud { "準備上傳素材…" } else { "送到本機 ComfyUI…" }, json!({"count": count, "mode": mode}));
    let (a, t) = (app.clone(), task.clone());
    tokio::spawn(async move {
        let r = if cloud { run_cloud(&a, &t, &p, count, &names, &token).await } else { run_local(&a, &p, count).await };
        a.h3.take(&t);
        match r {
            Ok(extra) if cloud => emit(&a, &t, "done", "完成", extra),
            // 本機只是排進 ComfyUI 的佇列：進度、停止都在右上角的任務面板（網頁顯示「已排入」、不給停止鍵）
            Ok(extra) => emit(&a, &t, "queued_local", "已排進本機 ComfyUI：進度和停止在右上角的任務面板", extra),
            Err(e) if token.is_cancelled() => emit(&a, &t, "stopped", e, json!({})),
            Err(e) => emit(&a, &t, "error", friendly_error(&e), json!({})),
        }
    });
    ok(json!({"ok": true, "task": task}))
}

fn one(p: &Value, i: i64) -> Value {
    let mut pp = p.clone();
    pp["poster"] = json!(format!("{:016x}", super::api_director::random_seed() as u64 ^ (i as u64) << 48));
    pp
}

async fn run_cloud(app: &Shared, task: &str, p: &Value, count: i64, names: &[String], token: &CancellationToken) -> Result<Value, String> {
    for (k, n) in names.iter().enumerate() {
        if token.is_cancelled() {
            return Err("已停止".into());
        }
        emit(app, task, "running", format!("上傳素材 {}／{}…", k + 1, names.len()), json!({}));
        super::api_cloud::upload_input(app, &app.paths.input.join(n)).await?;
    }
    let mut ids: Vec<i64> = vec![];
    for i in 0..count {
        let pp = one(p, i);
        let (q, input) = (pp.clone(), app.paths.input.clone());
        let (nodes, info) = blocking(move || h3::build(&q, &input, i)).await.map_err(|e| e.0)?;
        let mut params = pp.clone();
        params["seed"] = info["seed"].clone();
        params["prompt_resolved"] = info["prompt"].clone();
        let label = if count > 1 { format!("第 {}／{count} 支：", i + 1) } else { String::new() };
        let (a, t) = (app.clone(), task.to_string());
        let status = move |m: String| emit(&a, &t, "running", format!("{label}{m}"), json!({}));
        let (_, got) = super::api_cloud::run_graph(app, nodes, &params, &info, token, &status).await?;
        ids.extend(got);
        emit(app, task, "running", format!("已完成 {}／{count} 支", i + 1), json!({"ids": ids}));
    }
    Ok(json!({"ids": ids}))
}

async fn run_local(app: &Shared, p: &Value, count: i64) -> Result<Value, String> {
    app.pe.release_for_generation().await;
    // H3 模型＋文字編碼器很大：先清掉上一個任務留下的模型
    let _ = app.comfy.post("/free", &json!({"unload_models": true, "free_memory": true})).await;
    let mut jobs: Vec<String> = vec![];
    for i in 0..count {
        let pp = one(p, i);
        let (q, input) = (pp.clone(), app.paths.input.clone());
        let (nodes, info) = blocking(move || h3::build(&q, &input, i)).await.map_err(|e| e.0)?;
        let mut params = pp.clone();
        params["seed"] = info["seed"].clone();
        params["prompt_resolved"] = info["prompt"].clone();
        let pid = app.comfy.submit(&Value::Object(nodes), &json!({"anima_params": params})).await.map_err(|e| e.0)?;
        app.db.add_job(&pid, &params, &info).map_err(|e| e.to_string())?;
        app.comfy.sync_job(&pid).await;
        jobs.push(pid);
    }
    *app.last_family.lock().unwrap_or_else(|e| e.into_inner()) = "h3".into();
    Ok(json!({"jobs": jobs}))
}

pub async fn stop(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let task = tx(&b["task"]);
    match app.h3.take(&task) {
        Some(t) => {
            t.cancel();
            ok(json!({"ok": true}))
        }
        None => Err(bad("這個工作已經結束了")),
    }
}

// ---------------------------------------------------------------- AI 幫我寫
/// 模式 → 官方指南的模式名稱、用哪份系統提示詞
pub fn writer_of(mode: &str) -> (&'static str, &'static str) {
    match mode {
        "t2v" => ("T2VA", "agent_h3_base"),
        "i2v" | "continue" => ("I2VA", "agent_h3_base"),
        "fl2v" => ("FL2VA", "agent_h3_base"),
        "board" => ("Board", "agent_h3_board"),
        _ => ("Ref2VA", "agent_h3_ref"),
    }
}

/// 送給腦袋的那段請求（模式、秒數、素材清單、想法）
pub fn writer_request(mode: &str, secs: f64, media: &[Value], idea: &str, trigger: Option<&str>) -> String {
    let (name, _) = writer_of(mode);
    let mut t = format!("Mode: {name}\nDuration: {:.2} seconds\n", h3::frames(secs) as f64 / h3::FPS as f64);
    if mode == "continue" {
        t.push_str("This clip continues directly from the end of the previous clip (no cut, no reset); <Picture 1> is the previous clip's last frame.\n");
    }
    if !media.is_empty() {
        t.push_str("Media (in order):\n");
        for m in media {
            let label = tx(&m["label"]);
            let role = tx(&m["role"]);
            // 素材板裡不進提示詞編號的（接續、整段改造、骨架控制、釘住的聲音）：沒有標籤
            let label = if label.is_empty() { "(not named in the prompt)".to_string() } else { label };
            t.push_str(&format!("- {label}: {role}\n"));
        }
    }
    if let Some(trig) = trigger {
        t.push_str(&format!("The final prompt must start with the trigger word \"{trig}\".\n"));
    }
    t.push_str(&format!("\nRequest:\n{}", idea.trim()));
    t
}

/// 去掉模型多包的 ``` 圍欄和前後說明
pub fn clean_prompt(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("```text").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

/// 素材板的寫手回的 JSON 分鏡：{summary, style, shots:[…], soundscape, music, notes?}；讀不懂回 None（網頁改放純文字）
pub fn board_plan_of(s: &str) -> Option<Value> {
    let t = clean_prompt(s);
    let (a, b) = (t.find('{')?, t.rfind('}')?);
    let v: Value = serde_json::from_str(t.get(a..=b)?).ok()?;
    let shots = v["shots"].as_array()?;
    (!shots.is_empty() && shots.iter().all(|x| x.is_object())).then_some(v)
}

/// {idea, mode, seconds, media: [{label, role, name?}], brain: 9b|35b|cloud, path?, plan?} → {prompt}；素材板（mode board）→ {plan} 或 {prompt}
/// 「AI 幫我寫」用哪顆腦袋：b.brain 是 9b／35b／cloud；雲端的話要開好、而且有裝助手的腦袋（拍攝單 AI 潤飾也用）
pub(super) fn brain_of(app: &Shared, b: &Value) -> Result<(String, Option<crate::pe::Remote>), super::ApiError> {
    let brain = match tx(&b["brain"]).as_str() {
        "35b" => "35b",
        "cloud" => "cloud",
        _ => "9b",
    }
    .to_string();
    let remote = if brain == "cloud" {
        if app.agent.cloud.live_packs().is_some_and(|p| !p.agent) {
            return Err(bad("雲端這台沒裝助手的腦袋：改用本機的 9B／35B，或雲端勾「生圖助手」"));
        }
        Some(app.agent.cloud.endpoints().ok_or_else(|| bad("雲端還沒開好"))?.remote())
    } else {
        None
    };
    Ok((brain, remote))
}

pub async fn write(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    let idea = tx(&b["idea"]);
    if idea.trim().is_empty() {
        return Err(bad("先用中文寫想要的畫面、動作、台詞或聲音"));
    }
    let mode = match tx(&b["mode"]).as_str() {
        "" => "t2v".to_string(),
        m => m.to_string(),
    };
    let secs = b.get("seconds").and_then(Value::as_f64).unwrap_or(5.0);
    let media: Vec<Value> = b["media"].as_array().cloned().unwrap_or_default();
    let trigger = h3::MODE_LORAS.iter().find(|(m, ..)| *m == mode).map(|(_, _, t)| *t);
    let (_, sys_id) = writer_of(&mode);
    let system = app.pe.agent_text(sys_id);
    let mut req = writer_request(&mode, secs, &media, &idea, trigger);
    if mode == "board" {
        // 素材板：哪一條路（參考路六段、關鍵幀路三段）、使用者已經寫的分鏡（擴寫，不要丟）
        let path = match tx(&b["path"]).as_str() {
            "" => "Ref2VA".to_string(),
            x => x.to_string(),
        };
        req = req.replacen("Mode: Board\n", &format!("Mode: Board (prompt path: {path})\n"), 1);
        if b["plan"]["shots"].as_array().is_some_and(|a| !a.is_empty()) {
            req.push_str(&format!("\n\nCurrent plan (keep what the user wrote, fill the gaps, rewrite in English):\n{}", b["plan"]));
        }
    }
    let mut parts = vec![json!({"type": "text", "text": req})];
    // 圖片素材給腦袋看（最多 6 張，長邊 768）
    for m in media.iter().filter(|m| kind_of(&tx(&m["name"])) == Some(Kind::Image)).take(6) {
        let f: PathBuf = app.paths.input.join(super::basename(&tx(&m["name"])));
        let fp = f.clone();
        if let Ok(Ok(part)) = tokio::task::spawn_blocking(move || crate::pe::image_url_jpeg(&fp, 768)).await {
            parts.push(json!({"type": "text", "text": format!("{}:", tx(&m["label"]))}));
            parts.push(part);
        }
    }
    let msgs = json!([{"role": "system", "content": system}, {"role": "user", "content": parts}]);
    let (brain, remote) = brain_of(&app, &b)?;
    let rid = format!("h3w-{:x}", super::api_director::random_seed());
    let (content, _) = app.pe.agent_chat(&rid, &msgs, 6144, 0.6, false, &brain, remote.as_ref()).await.map_err(bad)?;
    if mode == "board" {
        if let Some(plan) = board_plan_of(&content) {
            return ok(json!({"plan": plan}));
        }
    }
    let prompt = clean_prompt(&content);
    if prompt.is_empty() {
        return Err(bad("腦袋沒寫出東西：換一顆腦袋或把想法寫具體一點再試"));
    }
    ok(json!({"prompt": prompt}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gen_params_become_h3() {
        let p = |v: Value| v.as_object().unwrap().clone();
        let models = vec!["10Eros_Max_h3_TURBO-hybrid_beta5_int8.safetensors".to_string(), "10Eros-Max-Turbo-Beta5-Q3_K_M.gguf".to_string()];
        let h = from_gen(&p(json!({"prompt": "she waves", "init_image": "a.png", "video_seconds": 3, "video_res": "480p", "seed": 7})), &models).unwrap();
        assert_eq!((h["h3_mode"].as_str(), h["first"].as_str(), h["quality"].as_str(), h["seconds"].as_f64()), (Some("i2v"), Some("a.png"), Some("fast"), Some(3.0)));
        assert_eq!(h["model"], "10Eros-Max-Turbo-Beta5-Q3_K_M.gguf", "本機有 GGUF 就優先");
        assert_eq!(h["seed"], 7);
        assert!(h["prompt"].as_str().unwrap().starts_with("integrated_multimodal_description: [Shot 1] she waves"));
        // 沒圖＝文生影片、照寬高挑比例、720p＝高畫質、已經是 H3 格式就不包
        let h = from_gen(&p(json!({"prompt": "integrated_multimodal_description: x", "width": 832, "height": 1216, "video_res": "720p"})), &[]).unwrap();
        assert_eq!((h["h3_mode"].as_str(), h["aspect"].as_str(), h["quality"].as_str()), (Some("t2v"), Some("3:4"), Some("high")));
        assert_eq!(h["prompt"], "integrated_multimodal_description: x");
        assert_eq!(h["model"], h3::MODEL);
        assert!(h["seed"].as_i64().unwrap() >= 0);
        // 指定模型、擋路徑、沒提示詞
        assert_eq!(from_gen(&p(json!({"prompt": "x", "h3_model": "m.safetensors"})), &models).unwrap()["model"], "m.safetensors");
        assert!(from_gen(&p(json!({"prompt": "x", "init_image": "..\\a.png"})), &models).is_err());
        assert!(from_gen(&p(json!({"prompt": " "})), &models).is_err());
    }

    #[test]
    fn templates_parse() {
        // 玩法牆的範本：讀得進來、id 不重複、模式都認得、提示詞裡的 {欄位} 都有填空（{secs} 程式自己填）、素材說明括號成對（沒被切掉一半）
        let t: Vec<Value> = serde_json::from_str(TEMPLATES).unwrap();
        let mut ids = std::collections::HashSet::new();
        for x in &t {
            let id = tx(&x["id"]);
            assert!(ids.insert(id.clone()), "重複的 id：{id}");
            assert!(h3::MODES.contains(&tx(&x["mode"]).as_str()), "{id}");
            let keys: Vec<String> = x["inputs"].as_array().into_iter().flatten().map(|i| tx(&i["key"])).collect();
            let tpl = tx(&x["template_en"]);
            let mut rest = tpl.as_str();
            while let Some(i) = rest.find('{') {
                rest = &rest[i + 1..];
                let k: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
                if !k.is_empty() && rest[k.len()..].starts_with('}') {
                    assert!(k == "secs" || keys.contains(&k), "{id} 的 {{{k}}} 沒有填空");
                }
            }
            for s in x["slots"].as_array().into_iter().flatten() {
                let role = tx(&s["role"]);
                assert!(!role.is_empty() && role.matches('（').count() == role.matches('）').count(), "{id} 的素材說明：{role}");
            }
        }
    }

    #[test]
    fn busy_while_task_runs() {
        // 雲端閒置自動關機要把 H3 的工作也算進「在忙」（審查第 3 點：傳大影片時被刪機）
        let h = H3::default();
        assert!(!h.any_running());
        h.put("t", CancellationToken::new());
        assert!(h.any_running());
        h.take("t");
        assert!(!h.any_running());
    }

    #[test]
    fn media_name_must_be_ours() {
        // 送出的素材只能是 /api/h3/media 放進 input 的檔（審查第 11 點：別的路徑會被傳上雲端）
        assert!(media_name_ok("h3_0a1b2c.png") && media_name_ok("h3_0a1b2c.mp4") && media_name_ok("h3_0a1b2c.wav"));
        assert!(!media_name_ok("../../.ssh/h3_x.png"));
        assert!(!media_name_ok("sub\\h3_x.png"));
        assert!(!media_name_ok("id_ed25519"));
        assert!(!media_name_ok("h3_x.exe"));
        assert!(!media_name_ok("x.png"));
    }

    #[test]
    fn convert_writes_part_first() {
        // 轉檔先寫到各自的暫存檔、成功才改名（審查第 12 點：半截檔被當快取、兩格同檔互蓋）
        let a = part_path(Path::new("in/h3_ab.mp4"));
        let b = part_path(Path::new("in/h3_ab.mp4"));
        assert_ne!(a, b);
        let n = a.file_name().unwrap().to_str().unwrap();
        assert!(n.starts_with("h3_ab.") && n.ends_with(".part.mp4"), "{n}");
        assert_eq!(a.parent(), Some(Path::new("in")));
    }

    #[test]
    fn friendly_error_maps() {
        assert!(friendly_error("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate").starts_with("顯存不夠"));
        assert!(friendly_error("Value not in list: unet_name: '10Eros_Max_h3.safetensors' not in []").contains("H3 影片包"));
        assert_eq!(friendly_error("別的錯"), "別的錯");
    }

    #[test]
    fn ffmpeg_args_for_media() {
        let v = ffmpeg_args(Path::new("a.mov"), Path::new("b.mp4"), Kind::Video).join(" ");
        assert!(v.contains("-r 24") && v.contains("-t 15") && v.ends_with("b.mp4") && v.contains("0:a:0?"), "{v}");
        assert!(v.contains("-protocol_whitelist file -i a.mov"), "{v}");
        let a = ffmpeg_args(Path::new("a.mp3"), Path::new("b.wav"), Kind::Audio).join(" ");
        assert!(a.contains("-t 15") && a.contains("-vn") && !a.contains("-r 24"), "{a}");
        assert_eq!(kind_of("x.MP4"), Some(Kind::Video));
        assert_eq!(kind_of("x.webp"), Some(Kind::Image));
        assert_eq!(kind_of("x.flac"), Some(Kind::Audio));
        assert_eq!(kind_of("x.exe"), None);
    }

    #[test]
    fn board_helpers() {
        let p = json!({"h3_mode": "board", "items": [{"kind": "image", "name": "a.png", "use": "ref"}, {"kind": "video", "name": "v.mp4", "use": "guide", "lora": "vfx"}]});
        assert_eq!(media_names(&p), vec!["a.png", "v.mp4"]);
        assert!(needs_advanced(&p));
        assert!(!needs_advanced(&json!({"h3_mode": "board", "items": [{"kind": "video", "name": "v.mp4", "use": "guide", "lora": ""}]})));
        assert!(needs_advanced(&json!({"h3_mode": "board", "lora_mode": "live", "items": []})));
        assert!(needs_advanced(&json!({"h3_mode": "swap"})) && !needs_advanced(&json!({"h3_mode": "i2v"})));
        let plan = board_plan_of("好的：\n```json\n{\"summary\": \"s\", \"shots\": [{\"start\": 0, \"picture\": \"p\"}]}\n```").unwrap();
        assert_eq!(plan["shots"][0]["picture"], "p");
        assert!(board_plan_of("{\"shots\": []}").is_none() && board_plan_of("no json").is_none());
        let m = vec![json!({"label": "", "role": "continues from the previous clip"})];
        let t = writer_request("board", 5.0, &m, "點子", None);
        assert!(t.starts_with("Mode: Board\n") && t.contains("- (not named in the prompt): continues"), "{t}");
        assert_eq!(writer_of("board"), ("Board", "agent_h3_board"));
    }

    #[test]
    fn media_names_collects_all() {
        let p = json!({"first": "a.png", "last": "b.png", "refs": {"images": ["a.png", "c.png"], "videos": ["v.mp4"], "audios": ["s.wav"]},
                       "keys": [{"image": "k.png", "secs": 1}], "source": "src.mp4", "prev": ""});
        assert_eq!(media_names(&p), vec!["a.png", "b.png", "src.mp4", "c.png", "v.mp4", "s.wav", "k.png"]);
    }

    #[test]
    fn writer_request_text() {
        let m = vec![json!({"label": "<Picture 1>", "role": "the character", "name": "a.png"})];
        let t = writer_request("swap", 10.0, &m, "換成我的角色", Some("body_swap:"));
        assert!(t.starts_with("Mode: Ref2VA\nDuration: 10.12 seconds"), "{t}");
        assert!(t.contains("- <Picture 1>: the character") && t.contains("body_swap:") && t.ends_with("換成我的角色"));
        assert_eq!(writer_of("fl2v"), ("FL2VA", "agent_h3_base"));
        assert_eq!(clean_prompt("```text\nhello\n```"), "hello");
    }
}
