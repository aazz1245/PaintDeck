//! 生圖玩法裡要後端幫忙的部分（2026-10-20）：
//!   GET  /api/play/models   修臉用的 SAM3、去背用的 BiRefNet 裝了沒（ComfyUI 的模型清單）
//!   POST /api/detail        修臉／修手：SAM3 找出每張臉（手）的遮罩 → 存進 input → 排一張 mode=detail 的生圖任務
//!   POST /api/play/save_grid X/Y 對照表在網頁拼好的格子圖存進圖庫（multipart：image＝PNG、meta＝JSON {prompt, xy}）
//! 擴圖、差分、去背直接走 /api/generate（mode outpaint／diff／rembg，節點圖在 graphs.rs）。
use super::api_director::random_seed;
use super::{api_gen, bad, blocking, ok, ApiResult, Body, Shared};
use crate::graphs;
use crate::py::truthy;
use axum::extract::{Multipart, State};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// 偵測任務最多等多久（前面可能還排著別的圖）
const DETECT_WAIT: Duration = Duration::from_secs(900);
/// 一次最多修幾個地方（graphs.rs 的 detail 也只收 8 個）
const MAX_PARTS: usize = 8;

/// ComfyUI 的清單裡有沒有生圖站要的這個檔（或同一家改過名字的版本，見 comfy::pick_alternative）；沒有的話 Err 是講清楚缺什麼、放哪、去哪下載的白話
fn have(list: &[Value], name: &str) -> Result<(), String> {
    let names: Vec<String> = list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect();
    crate::comfy::pick_alternative(name, &names).map(|_| ())
}

pub async fn models(State(app): State<Shared>) -> ApiResult {
    let sam = app.comfy.options("CheckpointLoaderSimple", "ckpt_name").await.unwrap_or_default();
    let bg = app.comfy.options("LoadBackgroundRemovalModel", "bg_removal_name").await.unwrap_or_default();
    ok(json!({"sam3": have(&sam, graphs::SAM3_CKPT).is_ok(), "bg": have(&bg, graphs::BG_MODEL).is_ok(), "sam3_name": graphs::SAM3_CKPT, "bg_name": graphs::BG_MODEL}))
}

/// 等 ComfyUI 的 /history 出現這個任務，回傳那一筆（失敗回 ComfyUI 的錯誤訊息）；what＝錯誤訊息開頭（「偵測」「TTS」）
pub(super) async fn wait_history(app: &Shared, pid: &str, what: &str) -> Result<Value, String> {
    let start = Instant::now();
    loop {
        if let Ok(h) = app.comfy.get(&format!("/history/{pid}")).await {
            if let Some(e) = h.get(pid) {
                let st = &e["status"];
                if st["status_str"] == "error" {
                    let msg = st["messages"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|m| m[0] == "execution_error")
                        .and_then(|m| m[1]["exception_message"].as_str())
                        .unwrap_or("請看 ComfyUI 視窗的訊息")
                        .trim()
                        .to_string();
                    return Err(format!("{what}失敗：{msg}"));
                }
                if truthy(st.get("completed")) || st["status_str"] == "success" {
                    return Ok(e.clone());
                }
            }
        }
        if start.elapsed() > DETECT_WAIT {
            let _ = app.comfy.post("/queue", &json!({"delete": [pid]})).await;
            return Err(format!("{what}等太久了（ComfyUI 前面排了很多張）：等佇列空一點再試"));
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
}

/// {params: 原圖的生成參數，init_image＝input 裡的檔名, what: "face"|"hand"|"both", threshold?, denoise?, extra?}
pub async fn detail(State(app): State<Shared>, Body(b): Body) -> ApiResult {
    if !app.comfy.live().online {
        return Err(bad("ComfyUI 沒有連線。解法：重新開啟「繪匣 PaintDeck」。"));
    }
    let Some(Value::Object(mut p)) = b.get("params").cloned() else {
        return Err(bad("送來的資料格式不對：缺少 params"));
    };
    let init = p.get("init_image").and_then(Value::as_str).unwrap_or("").to_string();
    if init.is_empty() || init.contains(['/', '\\']) || init.contains("..") {
        return Err(bad("缺少要修的圖"));
    }
    let src = app.paths.input.join(&init);
    let (iw, ih) = blocking(move || image::image_dimensions(&src))
        .await
        .map_err(|_| bad("找不到要修的圖（input 裡的暫存檔可能被清掉了），請重新選一次圖"))?;
    let sam = app.comfy.options("CheckpointLoaderSimple", "ckpt_name").await.unwrap_or_default();
    // 檔名不一樣（改過名字、別的版本）也行：送出時 comfy.rs 會換成 ComfyUI 手上有的那個
    have(&sam, graphs::SAM3_CKPT).map_err(bad)?;
    let what = b.get("what").and_then(Value::as_str).unwrap_or("face");
    let words: Vec<&str> = match what {
        "hand" => vec!["hand"],
        "both" => vec!["face", "hand"],
        _ => vec!["face"],
    };
    let th = b.get("threshold").and_then(Value::as_f64).unwrap_or(0.4);
    let nodes = graphs::detect_graph(&init, &words, th);
    let pid = app.comfy.submit(&Value::Object(nodes), &json!({})).await.map_err(|e| bad(e.0))?;
    let h = wait_history(&app, &pid, "偵測").await.map_err(bad)?;

    // PreviewImage 的結果在 temp；照節點編號排（先臉後手），每個物件一張
    let mut outs: Vec<(i64, Value)> = h["outputs"]
        .as_object()
        .map(|o| o.iter().map(|(k, v)| (k.parse().unwrap_or(0), v.clone())).collect())
        .unwrap_or_default();
    outs.sort_by_key(|x| x.0);
    let mut pngs = vec![];
    for (_, o) in outs {
        for im in o["images"].as_array().into_iter().flatten() {
            let s = |k: &str| im[k].as_str().unwrap_or("").to_string();
            pngs.push(app.comfy.view(&s("filename"), &s("subfolder"), &s("type")).await.map_err(|e| bad(e.0))?);
        }
    }
    let input = app.paths.input.clone();
    let stamp = format!("{:x}", random_seed());
    let masks = blocking(move || -> Result<Vec<String>, String> {
        let mut list = vec![];
        for (k, bytes) in pngs.iter().enumerate() {
            let img = image::load_from_memory(bytes).map_err(|e| format!("讀不了偵測結果：{e}"))?.to_luma8();
            let img = if img.dimensions() == (iw, ih) {
                img
            } else {
                image::imageops::resize(&img, iw, ih, image::imageops::FilterType::Nearest)
            };
            let Some(bb) = graphs::bbox_of(&img) else {
                continue;
            };
            // 小於畫面 1/2000 的當雜點
            let area = (bb.2 - bb.0) as u64 * (bb.3 - bb.1) as u64;
            if area * 2000 < iw as u64 * ih as u64 {
                continue;
            }
            let name = format!("aw_detail_{stamp}_{k}.png");
            img.save(input.join(&name)).map_err(|e| format!("存遮罩失敗：{e}"))?;
            list.push((area, name));
        }
        // 大的先修
        list.sort_by_key(|x| std::cmp::Reverse(x.0));
        Ok(list.into_iter().take(MAX_PARTS).map(|x| x.1).collect())
    })
    .await
    .map_err(bad)?;
    if masks.is_empty() {
        let thing = match what {
            "hand" => "手",
            "both" => "臉或手",
            _ => "臉",
        };
        return Err(bad(format!("這張圖找不到{thing}（偵測門檻 {th}）。臉太小、太側面或被擋住時會找不到")));
    }

    // 生圖參數：照原圖的模型、LoRA、提示詞，換成 detail 模式；跟這次無關的欄位拿掉
    // 一鍵脫衣、四視圖、差分記的提示詞是給 Qwen 的改圖指令，不能拿來重畫臉：改用空白＋extra
    let mode = p.get("mode").and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(r) = p.shift_remove("prompt_resolved") {
        if truthy(Some(&r)) {
            p.insert("prompt".into(), r);
        }
    }
    if matches!(mode.as_str(), "strip" | "sheet" | "diff" | "rembg") {
        p.insert("prompt".into(), json!(""));
    }
    for k in [
        "refs", "mask", "inpaint", "upscale", "control", "hires", "layout", "strip", "sheet", "diff", "outpaint", "pose_control",
        "video_preview", "poster", "size_mode", "pixels", "ref_pixels", "director", "agent", "comic", "idea", "pe_prompt", "detail",
    ] {
        p.shift_remove(k);
    }
    let extra = b.get("extra").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let n = masks.len();
    p.insert("mode".into(), json!("detail"));
    p.insert("init_image".into(), json!(init));
    p.insert("detail".into(), json!({"masks": masks, "what": what, "extra": extra, "from_mode": mode}));
    p.insert("denoise".into(), json!(b.get("denoise").and_then(Value::as_f64).unwrap_or(0.4).clamp(0.05, 1.0)));
    p.insert("seed".into(), json!(random_seed()));
    let jobs = api_gen::submit_jobs(&app, p, 1).await?;
    ok(json!({"jobs": jobs, "found": n}))
}

pub async fn save_grid(State(app): State<Shared>, mut mp: Multipart) -> ApiResult {
    let (mut png, mut meta) = (None, json!({}));
    while let Some(f) = mp.next_field().await.map_err(|e| bad(format!("讀不到上傳的資料：{e}")))? {
        match f.name() {
            Some("image") => png = Some(f.bytes().await.map_err(|e| bad(format!("讀不到上傳的圖：{e}")))?),
            Some("meta") => meta = serde_json::from_str(&f.text().await.unwrap_or_default()).unwrap_or(json!({})),
            _ => {}
        }
    }
    let png = png.ok_or_else(|| bad("沒有上傳對照表的圖"))?;
    let fname = format!("xy_{}_{:04x}_00001_.png", chrono::Local::now().format("%Y%m%d_%H%M%S"), random_seed() & 0xffff);
    let dst = app.paths.output.join("AnimaWeb").join(&fname);
    let (w, h) = blocking(move || -> Result<(u32, u32), String> {
        let im = image::load_from_memory(&png).map_err(|e| format!("不是可讀取的圖片：{e}"))?;
        std::fs::create_dir_all(dst.parent().unwrap_or(&dst)).map_err(|e| e.to_string())?;
        im.save_with_format(&dst, image::ImageFormat::Png).map_err(|e| format!("存檔失敗：{e}"))?;
        Ok((im.width(), im.height()))
    })
    .await
    .map_err(bad)?;
    let prompt = meta.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
    let params = json!({"mode": "xy", "model": "X/Y 對照表", "prompt": prompt, "seed": 0, "width": w, "height": h, "xy": meta.get("xy").cloned().unwrap_or(Value::Null)});
    let info = json!({"mode": "xy", "prompt": prompt, "negative": "", "seed": 0, "width": w, "height": h});
    let iid = app.db.add_image(&fname, "AnimaWeb", "output", &info, &params, None)?;
    let image = app.db.image(iid)?.map(Value::Object).unwrap_or(Value::Null);
    app.hub.send(json!({"type": "image", "job": Value::Null, "image": image}));
    ok(image)
}
