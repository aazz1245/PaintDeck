//! 把生成參數組成 ComfyUI API 節點圖（POST /prompt 的 "prompt" 欄位）。逐行對照舊版 anima_ui/app/graphs.py：
//! 同樣的參數必須產生完全一樣的節點圖（tests/golden_graphs.rs 拿 Python 版的輸出比對）。
//!
//! 五種模式：txt2img、img2img、inpaint、multiref（Qwen 2.1 限定）、upscale。
//! 兩個家族：anima（CLIPTextEncode＋qwen_image_vae，可用 LLLite、Turbo LoRA）、
//!           qwen21（TextEncodeQwenImage21＋2.1 專用 VAE；圖生圖把輸入圖當參考圖）、
//!           moss（MOSS-Image：moss_image 文字編碼器＋FLUX.2 VAE、AuraFlow 位移、跳第 22 層）。
//! Qwen 2.1 在 2.0.19 拿掉、2.1.3 裝回（使用者要求），跟 MOSS 並存：選哪個模型就走哪一套。
//!
//! 跟 Python 對齊的細節：
//! - Python 的 round() 遇到 .5 取偶數 → f64::round_ties_even
//! - `{a|b}` 用 pyrandom（跟 random.Random(seed) 一致）
//! - 每個欄位的整數／小數型別照舊版（ComfyUI 驗證會看型別，golden test 也會比）
use crate::py::truthy;
use crate::pyrandom::PyRandom;
use serde_json::{json, Map, Value};
use std::path::Path;

pub const CLIP: &str = "qwen_3_06b_base.safetensors";
pub const VAE: &str = "qwen_image_vae.safetensors";
pub const TURBO_LORA: &str = "anima-turbo-lora-v0.2.safetensors";
pub const QWEN21_TE: &str = "qwen3vl_8b_w4a8.safetensors";
pub const QWEN21_VAE: &str = "qwen_image_2.1_vae_bf16.safetensors";
pub const QWEN21_PIXELS: f64 = 1024.0 * 1024.0;
pub const DEPTH_MODEL: &str = "depth_anything_3_mono_large.safetensors";
/// 抽骨架（OpenPose／DWPose 格式，ComfyUI 原生 SDPose；Comfy-Org/SDPose，放 models\checkpoints）
pub const SDPOSE_CKPT: &str = "sdpose_wholebody_fp16.safetensors";
/// MOSS-Image（Comfy-Org/MOSS-Image 的 ComfyUI 版檔案）：Qwen3.5-9B 文字編碼器（w4a8）＋FLUX.2 VAE。
/// 官方建議：Euler、sgm_uniform、50 步、CFG 3、shift 5，負面那一路跳過第 22 層（SkipLayerGuidanceDiTSimple）。
/// ComfyUI 0.38 原本沒有 MOSS：D 槽與安裝精靈都補了官方 commit e087d8f 的 9 個檔（resources\extras\comfy_moss）
pub const MOSS_TE: &str = "qwen3.5_9b_w4a8_gptq.safetensors";
pub const MOSS_VAE: &str = "flux2-vae.safetensors";
const MOSS_SHIFT: f64 = 5.0;
const MOSS_SKIP_LAYERS: &str = "22";
const TILED_ABOVE: i64 = 2_400_000;
const TURBO_T: [f64; 6] = [1.0, 0.9375, 0.875, 0.75, 0.5, 0.25];
/// 官方 Qwen-Image-2.1-Turbo 的 8 步排程（Hugging Face model_index.json 的 sample_sigmas，不隨尺寸位移）
const OFFICIAL_TURBO_SIGMAS: [f64; 8] = [
    1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568,
];

pub fn is_turbo_lora(name: &str) -> bool {
    name.to_lowercase().contains("turbo")
}

/// 官方 Turbo：完整模型（qwen_image_2.1_turbo_*），或原版／微調模型掛官方 Turbo LoRA（qwen_image_2.1_turbo_lora_*）
pub fn is_official_qwen21_turbo(p: &Value) -> bool {
    let official = |n: &str| {
        let n = n.to_lowercase().replace('-', "_");
        n.contains("qwen_image_2.1_turbo")
    };
    if official(s(p.get("model"), "")) {
        return true;
    }
    match p.get("loras") {
        Some(Value::Array(ls)) => ls.iter().any(|l| {
            l.get("enabled").map(|v| truthy(Some(v))).unwrap_or(true)
                && f(l.get("strength"), 1.0) != 0.0
                && official(s(l.get("name"), ""))
        }),
        _ => false,
    }
}

/// 官方 Turbo 的排程；改圖（denoise < 1）從 denoise 開始、只留比它小的
pub fn official_turbo_sigmas(denoise: f64) -> String {
    let mut ts: Vec<f64> = if denoise >= 0.999 {
        OFFICIAL_TURBO_SIGMAS.to_vec()
    } else {
        std::iter::once(denoise)
            .chain(
                OFFICIAL_TURBO_SIGMAS
                    .iter()
                    .copied()
                    .filter(|t| *t < denoise),
            )
            .collect()
    };
    ts.push(0.0);
    ts.iter()
        .map(|t| format!("{t:.6}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn lllite(kind: &str) -> &'static str {
    match kind {
        "lineart" => "anima-lllite-lineart-1.safetensors",
        "scribble" => "anima-lllite-scribble-1.safetensors",
        "depth" => "anima-lllite-depth-1.safetensors",
        "pose" => "anima-lllite-pose-1.safetensors",
        "inpaint" => "anima-lllite-inpainting-v2.safetensors",
        _ => "anima-lllite-any-test-like-v2.safetensors",
    }
}

#[derive(Debug)]
pub struct GraphError(pub String);
impl std::fmt::Display for GraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
type R<T> = Result<T, GraphError>;
fn err<T>(m: impl Into<String>) -> R<T> {
    Err(GraphError(m.into()))
}

// ---------------------------------------------------------------- Python 行為的小工具（真值判斷在 py.rs）
/// Python float(v)
fn f(v: Option<&Value>, default: f64) -> f64 {
    match v {
        None => default,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(default),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(default),
        Some(Value::Bool(b)) => *b as i64 as f64,
        _ => default,
    }
}
/// Python int(v)（小數無條件捨去）
fn i(v: Option<&Value>, default: i64) -> i64 {
    match v {
        None => default,
        Some(Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| n.as_f64().map(|x| x.trunc() as i64).unwrap_or(default)),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(default),
        Some(Value::Bool(b)) => *b as i64,
        _ => default,
    }
}
fn s<'a>(v: Option<&'a Value>, default: &'a str) -> &'a str {
    v.and_then(|x| x.as_str()).unwrap_or(default)
}
/// p.get(k, default) 原樣傳下去（例如 sampler_name 不轉型）
fn raw(p: &Value, k: &str, default: Value) -> Value {
    p.get(k).cloned().unwrap_or(default)
}
/// Python: `p.get(k) or default`
fn or_f(p: &Value, k: &str, default: f64) -> f64 {
    if truthy(p.get(k)) {
        f(p.get(k), default)
    } else {
        default
    }
}

pub fn snap(v: f64, step: i64, lo: i64) -> i64 {
    lo.max(((v / step as f64).round_ties_even() as i64) * step)
}

/// 保持比例，把 w×h 縮放到大約 pixels 個像素，並對齊 step（Qwen 2.1 要 32）
pub fn fit_pixels(w: i64, h: i64, pixels: f64, step: i64) -> (i64, i64) {
    let sc = (pixels / (w * h) as f64).powf(0.5);
    (
        snap(w as f64 * sc, step, 256),
        snap(h as f64 * sc, step, 256),
    )
}

/// {紅|藍|綠} → 隨機挑一個；可巢狀，每張圖各抽一次
pub fn expand_wildcards(text: &str, rng: &mut PyRandom) -> String {
    let re = regex::Regex::new(r"\{([^{}]*\|[^{}]*)\}").unwrap();
    let mut t = text.to_string();
    while let Some(c) = re.captures(&t) {
        let m = c.get(0).unwrap();
        let opts: Vec<&str> = c.get(1).unwrap().as_str().split('|').collect();
        let pick = rng.choice(&opts).trim().to_string();
        t = format!("{}{}{}", &t[..m.start()], pick, &t[m.end()..]);
    }
    t
}

/// 版面框最多幾個
pub const LAYOUT_MAX: usize = 16;

/// MOSS-Image 版面框（生成頁、導演台拉的框）。params.layout：
/// `[{"type": "character"|"object"|"text", "desc": "外觀描述", "text": "要畫的字（type=text 才用）", "box": [x0, y0, x1, y1]}]`，box 是 0～1、左上角原點。
/// 組成官方的排版 JSON（design\MOSS官方資料\moss_layout_skill.md）：畫面中心當原點的像素、yxyx、左上 floor 右下 ceil，
/// 跟 ComfyUI 的 MOSSImageLayoutPrompt 節點算法一樣，壓成一行當正面提示詞。只有 MOSS 吃這個格式。
pub struct Layout {
    caption: String,
    items: Vec<(&'static str, String, String, [f64; 4])>,
}

impl Layout {
    /// 沒有能用的框就 None（照一般提示詞畫）。描述裡的 {紅|藍} 在這裡抽（組 JSON 之前，免得 | 和大括號弄壞 JSON）
    pub fn from_params(p: &Value, caption: &str, rng: &mut PyRandom) -> Option<Layout> {
        let mut items = vec![];
        for b in p.get("layout")?.as_array()?.iter().take(LAYOUT_MAX) {
            let kind = match s(b.get("type"), "object") {
                "character" => "character",
                "text" => "text",
                _ => "object",
            };
            let Some(v) = b.get("box").and_then(Value::as_array).filter(|a| a.len() == 4) else {
                continue;
            };
            let v: Vec<f64> = v.iter().map(|x| x.as_f64().unwrap_or(0.0).clamp(0.0, 1.0)).collect();
            let (x0, x1, y0, y1) = (v[0].min(v[2]), v[0].max(v[2]), v[1].min(v[3]), v[1].max(v[3]));
            let desc = expand_wildcards(s(b.get("desc"), ""), rng).trim().to_string();
            let text = if kind == "text" { s(b.get("text"), "").to_string() } else { String::new() };
            if x1 - x0 < 0.01 || y1 - y0 < 0.01 || (desc.is_empty() && text.trim().is_empty()) {
                continue;
            }
            items.push((kind, desc, text, [x0, y0, x1, y1]));
        }
        if items.is_empty() {
            return None;
        }
        Some(Layout { caption: caption.trim().to_string(), items })
    }

    /// w×h 畫面的排版 JSON（寬高不寫進去，生圖時用同樣的寬高）
    pub fn prompt(&self, w: i64, h: i64) -> String {
        // 0～1 → 像素邊（先四捨五入到小數 9 位再 floor／ceil，跟節點一樣）→ 減掉中心
        let edge = |v: f64, n: i64, up: bool| {
            let x = (v * n as f64 * 1e9).round() / 1e9;
            (if up { x.ceil() } else { x.floor() }) as i64 - n / 2
        };
        let items: Vec<Value> = self
            .items
            .iter()
            .map(|(kind, desc, text, [x0, y0, x1, y1])| {
                let mut m = Map::new();
                m.insert("label".into(), json!(kind));
                // 官方規則 caption 不能空：只寫了字的文字框補一句
                m.insert("caption".into(), json!(if desc.is_empty() { "clear, legible lettering" } else { desc.as_str() }));
                if *kind == "text" {
                    m.insert("text".into(), json!(text));
                }
                m.insert("bbox".into(), json!([edge(*y0, h, false), edge(*x0, w, false), edge(*y1, h, true), edge(*x1, w, true)]));
                Value::Object(m)
            })
            .collect();
        let caption = if self.caption.is_empty() {
            self.items.iter().map(|it| it.1.as_str()).filter(|d| !d.is_empty()).collect::<Vec<_>>().join(", ")
        } else {
            self.caption.clone()
        };
        json!({"summary": {"caption": caption}, "items": items, "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}).to_string()
    }
}

/// Qwen 2.1 Turbo（Noct Q Turbo 內建 Viggle v0.2.1）的 6 步排程，依尺寸位移
pub fn turbo_sigmas(w: i64, h: i64, denoise: f64) -> String {
    let mu = 0.5 + 0.4 * ((w as f64 / 16.0) * (h as f64 / 16.0) - 256.0) / 7936.0;
    let ts: Vec<f64> = if denoise >= 0.999 {
        TURBO_T.to_vec()
    } else {
        std::iter::once(denoise)
            .chain(TURBO_T.iter().copied().filter(|t| *t < denoise))
            .collect()
    };
    let e = mu.exp();
    let mut parts: Vec<String> = ts
        .iter()
        .map(|t| format!("{:.6}", e / (e + 1.0 / t - 1.0)))
        .collect();
    parts.push("0.000000".into());
    parts.join(", ")
}

// ---------------------------------------------------------------- 節點圖
pub type Ref = Value; // ["節點編號", 輸出序號]

pub struct Graph {
    pub family: String,
    pub nodes: Map<String, Value>,
    n: usize,
    clip: Option<Ref>,
    vae: Option<Ref>,
}

impl Graph {
    pub fn new(family: &str) -> Self {
        Graph {
            family: family.into(),
            nodes: Map::new(),
            n: 0,
            clip: None,
            vae: None,
        }
    }
    fn q(&self) -> bool {
        self.family == "qwen21"
    }
    /// 一張圖裡換家族（一鍵脫衣：先 Qwen 再 Anima）：文字編碼器、VAE 要重新載入對應家族的
    fn switch_family(&mut self, fam: &str) {
        self.family = fam.into();
        self.clip = None;
        self.vae = None;
    }
    fn moss(&self) -> bool {
        self.family == "moss"
    }
    /// 空白 latent：MOSS 用 FLUX.2 的 latent 空間（128 通道），其他家族用一般的
    fn empty_latent(&mut self, w: i64, h: i64) -> Ref {
        let cls = if self.moss() { "EmptyFlux2LatentImage" } else { "EmptyLatentImage" };
        self.add(cls, json!({"width": w, "height": h, "batch_size": 1}))
    }
    pub fn add(&mut self, cls: &str, inputs: Value) -> Ref {
        self.n += 1;
        let id = self.n.to_string();
        self.nodes
            .insert(id.clone(), json!({"class_type": cls, "inputs": inputs}));
        json!([id, 0])
    }
    fn slot(r: &Ref, i: i64) -> Ref {
        json!([r[0].clone(), i])
    }
    fn clip(&mut self) -> Ref {
        if self.clip.is_none() {
            let c = if self.q() {
                self.add(
                    "CLIPLoader",
                    json!({"clip_name": QWEN21_TE, "type": "qwen_image", "device": "default"}),
                )
            } else if self.moss() {
                self.add(
                    "CLIPLoader",
                    json!({"clip_name": MOSS_TE, "type": "moss_image", "device": "default"}),
                )
            } else {
                self.add(
                    "CLIPLoader",
                    json!({"clip_name": CLIP, "type": "stable_diffusion", "device": "default"}),
                )
            };
            self.clip = Some(c);
        }
        self.clip.clone().unwrap()
    }
    fn vae(&mut self) -> Ref {
        if self.vae.is_none() {
            let name = if self.q() {
                QWEN21_VAE
            } else if self.moss() {
                MOSS_VAE
            } else {
                VAE
            };
            self.vae = Some(self.add("VAELoader", json!({"vae_name": name})));
        }
        self.vae.clone().unwrap()
    }
    fn text(&mut self, t: &str) -> Ref {
        let clip = self.clip();
        self.add("CLIPTextEncode", json!({"text": t, "clip": clip}))
    }
    /// Qwen 2.1：正負提示詞一起編碼，參考圖同時給視覺編碼器與 VAE。回傳 (正向, 負向, 空 latent)
    fn qtext(&mut self, prompt: &str, negative: &str, images: &[Ref]) -> (Ref, Ref, Ref) {
        // 順序跟 Python 一樣：先準備 kw（有圖才建 VAE），呼叫 add 時才求 clip()，所以 VAE 節點編號在 CLIP 前面
        let mut kw = Map::new();
        for (k, im) in images.iter().enumerate() {
            kw.insert(format!("images.image_{}", k + 1), im.clone());
        }
        if !images.is_empty() {
            let v = self.vae();
            kw.insert("vae".into(), v);
        }
        let clip = self.clip();
        kw.insert("clip".into(), clip);
        kw.insert("prompt".into(), json!(prompt));
        kw.insert("negative_prompt".into(), json!(negative));
        kw.insert("resolution".into(), json!(0));
        let r = self.add("TextEncodeQwenImage21", Value::Object(kw));
        (r.clone(), Self::slot(&r, 1), Self::slot(&r, 2))
    }
    fn encode(&mut self, image: &Ref, w: i64, h: i64) -> Ref {
        let vae = self.vae();
        if w * h > TILED_ABOVE {
            return self.add("VAEEncodeTiled", json!({"pixels": image, "vae": vae, "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}));
        }
        self.add("VAEEncode", json!({"pixels": image, "vae": vae}))
    }
    fn decode(&mut self, latent: &Ref, w: i64, h: i64) -> Ref {
        let vae = self.vae();
        if w * h > TILED_ABOVE {
            return self.add("VAEDecodeTiled", json!({"samples": latent, "vae": vae, "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}));
        }
        self.add("VAEDecode", json!({"samples": latent, "vae": vae}))
    }
    fn scale(&mut self, image: &Ref, w: i64, h: i64, crop: &str, method: &str) -> Ref {
        self.add("ImageScale", json!({"image": image, "upscale_method": method, "width": w, "height": h, "crop": crop}))
    }
    fn mask_scale(&mut self, mask: &Ref, w: i64, h: i64) -> Ref {
        let img = self.add("MaskToImage", json!({"mask": mask}));
        let img = self.scale(&img, w, h, "disabled", "bilinear");
        self.add("ImageToMask", json!({"image": img, "channel": "red"}))
    }
    fn mask_blur(&mut self, mask: &Ref, radius: i64) -> Ref {
        if radius <= 0 {
            return mask.clone();
        }
        let img = self.add("MaskToImage", json!({"mask": mask}));
        let img = self.add("ImageBlur", json!({"image": img, "blur_radius": radius, "sigma": f64::max(0.5, radius as f64 / 2.0)}));
        self.add("ImageToMask", json!({"image": img, "channel": "red"}))
    }
}

/// LLLite：(patch 檔名, 控制圖, 遮罩, 強度, 開始, 結束)
type Lllite = (&'static str, Ref, Option<Ref>, f64, f64, f64);

fn model_chain(g: &mut Graph, p: &Value, lll: Vec<Lllite>) -> Ref {
    let model_name = s(p.get("model"), "");
    let mut m = g.add(
        "UNETLoader",
        json!({"unet_name": p.get("model"), "weight_dtype": "default"}),
    );
    for (patch, img, mask, st, a, b) in lll {
        let pl = g.add("ModelPatchLoader", json!({"name": patch}));
        let mut kw = json!({"model": m, "model_patch": pl, "image": img, "strength": st, "start_percent": a, "end_percent": b});
        if let Some(mk) = mask {
            kw["mask"] = mk;
        }
        m = g.add("AnimaLLLiteApply", kw);
    }
    let tl = p.get("turbo_lora");
    if truthy(tl) && !model_name.to_lowercase().contains("turbo") && g.family == "anima" {
        let name = tl.and_then(|v| v.as_str()).unwrap_or(TURBO_LORA);
        m = g.add(
            "LoraLoaderModelOnly",
            json!({"model": m, "lora_name": name, "strength_model": 1.0}),
        );
    }
    if let Some(Value::Array(ls)) = p.get("loras") {
        for l in ls {
            let enabled = l.get("enabled").map(|v| truthy(Some(v))).unwrap_or(true);
            let st = f(l.get("strength"), 1.0);
            if enabled && st != 0.0 {
                m = g.add(
                    "LoraLoaderModelOnly",
                    json!({"model": m, "lora_name": l.get("name"), "strength_model": st}),
                );
            }
        }
    }
    // 姿勢參考圖（Qwen 2.1）：3D 人偶的深度圖＋骨架，各接一個 Fun ControlNet。
    // 2026-10-10 實測：強度各 0.55、只管前 80% 步數，第一人稱和身體貼合明顯變好（報告\Qwen-Image-2.1-Turbo資料_20261010.md）
    if g.family == "qwen21" {
        if let Some(pc) = p.get("pose_control").filter(|v| v.is_object()) {
            let st = f(pc.get("strength"), 0.55);
            let mut patch: Option<Ref> = None;
            for k in ["depth", "pose"] {
                let Some(file) = pc.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()) else {
                    continue;
                };
                let pl = patch
                    .get_or_insert_with(|| {
                        g.add("ModelPatchLoader", json!({"name": POSE_CONTROLNET}))
                    })
                    .clone();
                let img = g.add(
                    "LoadImage",
                    json!({"image": format!("{POSE_INPUT}/{file}")}),
                );
                let vae = g.vae();
                m = g.add(
                    "ZImageFunControlnet",
                    json!({"model": m, "model_patch": pl, "vae": vae, "strength": st, "image": img, "end_percent": 0.8}),
                );
            }
        }
    }
    if g.moss() {
        // 原生 MOSS 的時間步倍率是 1：不能用 ModelSamplingSD3（它固定乘 1000，2026-10-17 實測整張變雜訊），AuraFlow 這個是倍率 1
        m = g.add("ModelSamplingAuraFlow", json!({"model": m, "shift": MOSS_SHIFT}));
        // 官方：負面那一路跳過第 22 層（CFG 1 時沒有負面那一路，不用接）
        if f(p.get("cfg"), 0.0) > 1.0 {
            m = g.add(
                "SkipLayerGuidanceDiTSimple",
                json!({"model": m, "double_layers": "", "single_layers": MOSS_SKIP_LAYERS, "start_percent": 0.0, "end_percent": 1.0}),
            );
        }
    }
    m
}

// ---------------------------------------------------------------- 換家族改圖（兩段：Qwen 2.1 改 → Anima 精修 → 差異遮罩貼回）
// 「一鍵脫衣」用這套引擎，改圖指令和精修 tag 是外部內容補丁（feature_strip），這裡只有中性的 graph 機制。
pub const STRIP_QWEN: &str = "qwen_image_2.1_turbo_int8_convrot.safetensors";
pub const STRIP_REFINE: &str = "anima-turbo-v1.1.safetensors";

/// 一鍵脫衣、四視圖編輯的 Qwen 那段：生成頁選的是 Qwen 就照它（模型、步數、CFG、LoRA），不然用官方 Turbo、不掛 LoRA
fn edit_qwen_params(p: &Value, fam: &str) -> Value {
    let mut qp = if fam == "qwen21" {
        p.clone()
    } else {
        json!({"model": STRIP_QWEN, "cfg": 1, "sampler": "euler", "scheduler": "simple", "steps": 8, "loras": []})
    };
    qp["pose_control"] = Value::Null;
    qp
}

// ---------------------------------------------------------------- 四視圖編輯
// 來源：使用者給的 ComfyUI 工作流「Qwen21_四视图编辑_文字与服装参考_统一版」的保持要求（原文簡體，照抄）。
// 2026-10-18 實測（E:\AI\anima_ui\data\lora_train\jgdx_v2\showcase\agentimg\fourview_*.py）：官方 Turbo、參考圖約 1280×1280，
// 點名衣物改色（「红色西装外套」）、圖2 換衣、全裸都成功，五個視角同步改；只寫「上衣」兩個種子都沒改到。
const SHEET_KEEP: &str = "【保持要求】\n以图1为待编辑原图，仅执行上面的修改要求。保持图1的人物身份、脸部、发型、身体比例、肩宽、腰胯比例、四肢长度、体型、站姿、表情、视角和四视图排版一致。\n四个视图呈现同一角色、同一套服装，服装的颜色、材质、剪裁与装饰在各视角对应，侧面和背面结构合理延续正面。局部特写与全身视图同步修改。\n未要求修改的内容保持原样，尽量延续图1的画风、光照与背景。不改变画面中的视图数量，不添加额外人物。";
const SHEET_REF: &str = "【有图2时】\n图2仅提供本次指定的服装或材质参考；人物身份、身材、姿势与构图仍以图1为准。若图2包含模特，不采用该模特的脸、发型、身材或姿势。衣服适配图1原有身体比例，宽松衣物可自然改变服装外轮廓。";

/// 四視圖編輯給 Qwen 的完整指令：本次修改要求＋保持要求（＋有圖2時的說明）
pub fn sheet_prompt(req: &str, has_ref: bool) -> String {
    let mut s = format!("【本次修改要求】\n{}\n\n{SHEET_KEEP}", req.trim());
    if has_ref {
        s.push_str("\n\n");
        s.push_str(SHEET_REF);
    }
    s
}

// ---------------------------------------------------------------- 差分、擴圖、修臉、去背
/// 差分（表情、動作）：一張角色圖、一個修改要求，Qwen 2.1 改圖重繪 1.0；保持要求照四視圖那份的寫法（簡體）
const DIFF_KEEP: &str = "【保持要求】\n以图1为待编辑原图，仅执行上面的修改要求。保持图1的人物身份、脸部特征、发型、发色、瞳色、服装、体型、画风、光照、镜头和背景一致；未要求修改的部分保持原样。不添加额外人物，不改变画面比例。";

/// 差分給 Qwen 的完整指令
pub fn diff_prompt(req: &str) -> String {
    format!("【本次修改要求】\n{}\n\n{DIFF_KEEP}", req.trim())
}

/// 擴圖時給 Qwen 2.1 的前綴（只進節點圖，不進圖庫記的提示詞）
const OUTPAINT_HINT: &str = "Extend the scene naturally into the empty gray borders so the whole frame is one seamless picture, with no gray areas or frames left.";

/// 修臉／修手用的偵測模型（ComfyUI 0.38 原生 SAM3_Detect；Comfy-Org/sam3.1，放 models\checkpoints）
pub const SAM3_CKPT: &str = "sam3.1_multiplex_fp16.safetensors";
/// 去背模型（ComfyUI 0.38 原生 RemoveBackground；Comfy-Org/BiRefNet，放 models\background_removal）
pub const BG_MODEL: &str = "birefnet.safetensors";

/// SAM3 偵測：每個詞（face、hand…）各找一次，每個物件一張黑白遮罩（原圖尺寸、分數高的在前），
/// 存成 temp 的圖（PreviewImage，不進 output、不會被收進圖庫）
pub fn detect_graph(image: &str, words: &[&str], threshold: f64) -> Map<String, Value> {
    let mut g = Graph::new("anima");
    let ck = g.add("CheckpointLoaderSimple", json!({"ckpt_name": SAM3_CKPT}));
    let li = g.add("LoadImage", json!({"image": image}));
    for w in words {
        let cond = g.add("CLIPTextEncode", json!({"text": w, "clip": Graph::slot(&ck, 1)}));
        let det = g.add(
            "SAM3_Detect",
            json!({"model": ck, "image": li, "conditioning": cond, "threshold": threshold.clamp(0.05, 0.95), "refine_iterations": 2, "individual_masks": true}),
        );
        let mi = g.add("MaskToImage", json!({"mask": det}));
        g.add("PreviewImage", json!({"images": mi}));
    }
    g.nodes
}

/// 一張黑白遮罩圖的白色外框（亮度 > 127）；用在 SAM3 讀回來的遮罩
pub fn bbox_of(img: &image::GrayImage) -> Option<(u32, u32, u32, u32)> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, p) in img.enumerate_pixels() {
        if p.0[0] > 127 {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
        }
    }
    (x0 < x1).then_some((x0, y0, x1, y1))
}

/// Qwen 2.1 Fun ControlNet（姿勢參考圖用）與參考圖在 ComfyUI input 底下的資料夾（MOSS 也用同一個資料夾的深度圖）
pub const POSE_CONTROLNET: &str = "qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors";
pub const POSE_INPUT: &str = "anima_pose";

#[allow(clippy::too_many_arguments)]
fn sample(
    g: &mut Graph,
    model: &Ref,
    pos: &Ref,
    neg: &Ref,
    latent: &Ref,
    p: &Value,
    seed: i64,
    denoise: f64,
    steps: Option<&Value>,
    size: (i64, i64),
) -> Ref {
    let model_name = s(p.get("model"), "").to_lowercase();
    let official = g.family == "qwen21" && is_official_qwen21_turbo(p);
    if official || (g.family == "qwen21" && model_name.contains("turbo")) {
        // 蒸餾模型對排程很敏感：官方 Turbo 用官方的 8 步，Noct Q Turbo（Viggle）用作者的 ManualSigmas
        let guider = g.add(
            "CFGGuider",
            json!({"model": model, "positive": pos, "negative": neg, "cfg": f(p.get("cfg"), 0.0)}),
        );
        let noise = g.add("RandomNoise", json!({"noise_seed": seed}));
        let sampler = g.add(
            "KSamplerSelect",
            json!({"sampler_name": raw(p, "sampler", json!("euler"))}),
        );
        let sigmas = g.add(
            "ManualSigmas",
            json!({"sigmas": if official { official_turbo_sigmas(denoise) } else { turbo_sigmas(size.0, size.1, denoise) }}),
        );
        return g.add("SamplerCustomAdvanced", json!({"noise": noise, "guider": guider, "sampler": sampler, "sigmas": sigmas, "latent_image": latent}));
    }
    let st = if truthy(steps) {
        i(steps, 0)
    } else {
        i(p.get("steps"), 0)
    };
    g.add("KSampler", json!({
        "model": model, "positive": pos, "negative": neg, "latent_image": latent, "seed": seed, "steps": st,
        "cfg": f(p.get("cfg"), 0.0), "sampler_name": raw(p, "sampler", json!("euler")),
        "scheduler": raw(p, "scheduler", json!("simple")), "denoise": denoise,
    }))
}

fn control_image(g: &mut Graph, c: &Value, w: i64, h: i64) -> Ref {
    let mut img = g.add("LoadImage", json!({"image": c.get("image")}));
    match s(c.get("preprocess"), "none") {
        "canny" => {
            img = g.add("Canny", json!({"image": img, "low_threshold": f(c.get("low"), 0.17), "high_threshold": f(c.get("high"), 0.45)}));
        }
        "depth" => {
            let dm = g.add(
                "LoadDA3Model",
                json!({"model_name": DEPTH_MODEL, "weight_dtype": "default"}),
            );
            let geo = g.add("DA3Inference", json!({"da3_model": dm, "image": img, "resolution": 504, "resize_method": "upper_bound_resize", "mode": "mono"}));
            img = g.add("DA3Render", json!({"da3_geometry": geo, "output": "depth", "output.normalization": "v2_style", "output.apply_sky_clip": false}));
        }
        "pose" => {
            // 照 ComfyUI 官方藍圖「Image to Pose Map (SDPose Multi-Person)」：先框人、每個框各抽一次骨架，再畫成 DWPose 那種彩色骨架圖。
            // 藍圖的框人用 RT-DETR，這裡改用修臉已經在用的 SAM3（少下載一個模型）；一個人都沒框到時 SDPose 自己改抽整張圖。
            // 不畫腳尖：Anima 的 pose LLLite 是拿 easy_dwpose 的圖訓練的，只有身體、手、臉。
            let sam = g.add("CheckpointLoaderSimple", json!({"ckpt_name": SAM3_CKPT}));
            let who = g.add("CLIPTextEncode", json!({"text": "person", "clip": Graph::slot(&sam, 1)}));
            let det = g.add("SAM3_Detect", json!({"model": sam, "image": img, "conditioning": who, "threshold": 0.4, "refine_iterations": 0, "individual_masks": true}));
            let sp = g.add("CheckpointLoaderSimple", json!({"ckpt_name": SDPOSE_CKPT}));
            let kp = g.add("SDPoseKeypointExtractor", json!({"model": sp, "vae": Graph::slot(&sp, 2), "image": img, "batch_size": 1, "bboxes": Graph::slot(&det, 1)}));
            img = g.add("SDPoseDrawKeypoints", json!({"keypoints": kp, "draw_body": true, "draw_hands": true, "draw_face": true, "draw_feet": false,
                                                       "stick_width": 4, "face_point_size": 2, "score_threshold": 0.5, "draw_head": true}));
        }
        _ => {}
    }
    if truthy(c.get("invert")) {
        img = g.add("ImageInvert", json!({"image": img}));
    }
    g.scale(&img, w, h, "center", "lanczos")
}

fn control_list(g: &mut Graph, p: &Value, w: i64, h: i64) -> Vec<Lllite> {
    if g.family != "anima" {
        return vec![];
    }
    // 構圖控制：一張（物件）或疊好幾張（陣列，例如深度＋骨架），依序接在模型上
    let items = match p.get("control") {
        Some(Value::Array(a)) => a.clone(),
        Some(c) => vec![c.clone()],
        None => vec![],
    };
    let mut out = vec![];
    for c in items.iter().filter(|c| truthy(Some(c)) && truthy(c.get("enabled")) && truthy(c.get("image"))) {
        let img = control_image(g, c, w, h);
        out.push((
            lllite(s(c.get("type"), "any")),
            img,
            None,
            f(c.get("strength"), 1.0),
            f(c.get("start"), 0.0),
            f(c.get("end"), 1.0),
        ));
    }
    // 體位庫的姿勢參考圖（3D 人偶的深度圖＋骨架）：深度 LLLite 鎖住兩個人的輪廓和前後，姿勢 LLLite 分出哪隻是左手右腳。
    // 2026-10-28 實測：只掛骨架太弱（作者也說 pose 那顆比較弱），深度圖才拉得動雙人體位；Anima 熟的體位（背後式）不掛反而最好
    if let Some(pc) = p.get("pose_control").filter(|v| v.is_object()) {
        for (k, st, end) in [("depth", f(pc.get("depth_strength"), 0.8), f(pc.get("depth_end"), 0.6)),
                             ("pose", f(pc.get("pose_strength"), 1.0), f(pc.get("pose_end"), 1.0))] {
            let Some(file) = pc.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()) else {
                continue;
            };
            let li = g.add("LoadImage", json!({"image": format!("{POSE_INPUT}/{file}")}));
            let img = g.scale(&li, w, h, "center", "lanczos");
            out.push((lllite(k), img, None, st, 0.0, end));
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn hires(
    g: &mut Graph,
    image: Ref,
    p: &Value,
    model: &Ref,
    pos: &Ref,
    neg: &Ref,
    seed: i64,
    w: i64,
    h: i64,
    lay: Option<&Layout>,
) -> (Ref, i64, i64) {
    let empty = json!({});
    let hf = p.get("hires").filter(|v| truthy(Some(v))).unwrap_or(&empty);
    if !truthy(hf.get("enabled")) {
        return (image, w, h);
    }
    let st = if g.family == "qwen21" { 32 } else { 16 };
    let sc = f(hf.get("scale"), 1.5);
    let (ww, hh) = (snap(w as f64 * sc, st, 256), snap(h as f64 * sc, st, 256));
    // 版面框的座標是像素：放大後要照新尺寸重算一次
    let pos = &match lay {
        Some(l) => g.text(&l.prompt(ww, hh)),
        None => pos.clone(),
    };
    let up = g.add(
        "UpscaleModelLoader",
        json!({"model_name": raw(hf, "upscaler", json!("4x-AnimeSharp.safetensors"))}),
    );
    let img = g.add(
        "ImageUpscaleWithModel",
        json!({"upscale_model": up, "image": image}),
    );
    let img = g.scale(&img, ww, hh, "disabled", "lanczos");
    let lat = g.encode(&img, ww, hh);
    let smp = sample(
        g,
        model,
        pos,
        neg,
        &lat,
        p,
        seed + 1,
        f(hf.get("denoise"), 0.4),
        hf.get("steps"),
        (ww, hh),
    );
    (g.decode(&smp, ww, hh), ww, hh)
}

pub(crate) fn image_size(path: &Path) -> R<(i64, i64)> {
    image::image_dimensions(path)
        .map(|(w, h)| (w as i64, h as i64))
        .map_err(|_| {
            GraphError(format!(
                "找不到輸入圖片：{}",
                path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            ))
        })
}

/// 遮罩的白色區域外框 (x0, y0, x1, y1)，跟 PIL getbbox 一樣右下角不含；沒塗東西回傳 None
fn mask_bbox(path: &Path) -> R<Option<(i64, i64, i64, i64)>> {
    let img = image::open(path).map_err(|_| GraphError("讀不到遮罩圖".into()))?;
    let rgb = img.to_rgb8();
    let (mut x0, mut y0, mut x1, mut y1) = (i64::MAX, i64::MAX, -1i64, -1i64);
    for (x, y, px) in rgb.enumerate_pixels() {
        // PIL convert("L")：L = (R*19595 + G*38470 + B*7471 + 0x8000) >> 16
        let l = (px[0] as u32 * 19595 + px[1] as u32 * 38470 + px[2] as u32 * 7471 + 0x8000) >> 16;
        if l > 127 {
            let (x, y) = (x as i64, y as i64);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    Ok(if x1 < 0 {
        None
    } else {
        Some((x0, y0, x1 + 1, y1 + 1))
    })
}

// ---------------------------------------------------------------- 影片（LTX-2.3：10Eros v1.5 DMD INT8）
// 2026-10-11 在 3070 8GB＋32GB 實測選出來的（報告\LTX實測、tools\ltx_test.py）：比 LTX-2.5 Uncensored 動作量約 2 倍、體位較對、快約 25 秒。
pub const VIDEO_CKPT: &str = "10Eros_v1.5_DMD_INT8_checkpoint.safetensors";
pub const VIDEO_TE: &str = "gemma-3-12b-it-ablit-norms-biproj-fp8mixed.safetensors";
pub const VIDEO_UPSCALER: &str = "ltx-2.3-spatial-upscaler-x2-1.1.safetensors";
/// LTX-2.3 官方兩段式蒸餾的 sigma 和取樣器：第一段（半解析度）8 步、第二段（放大後）3 步。
/// 2026-10-25 動作戲實測（HANDOFF 第一百一十二筆）比原本 10Eros 作者 V5 的 euler_ancestral 組劍、踢腿穩，慢約 15%
const VIDEO_SIGMAS_1: &str = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
const VIDEO_SIGMAS_2: &str = "0.85, 0.7250, 0.4219, 0.0";
const VIDEO_SAMPLER_1: &str = "euler_cfg_pp";
const VIDEO_SAMPLER_2: &str = "euler_ancestral_cfg_pp";
pub const VIDEO_FPS: i64 = 24;

/// 影片的節點圖：有 init_image＝圖生影片，沒有＝文生影片。兩段式：半解析度 8 步 → 潛空間放大 2 倍 → 3 步，
/// VAE 分塊 512（8GB 顯卡最快；不分塊或更大塊會爆顯存）。另外存一張封面（第一格）到 AnimaWeb/_poster/<poster>，給縮圖用。
fn build_video(p: &Value, input_dir: &Path, seed_offset: i64) -> R<(Map<String, Value>, Value)> {
    let seed = i(p.get("seed"), 0) + seed_offset;
    let prompt = s(p.get("prompt"), "").trim().to_string();
    if prompt.is_empty() {
        return err("影片要寫提示詞：描述畫面裡的動作和聲音（英文效果最好）");
    }
    let secs = f(p.get("video_seconds"), 5.0).clamp(1.0, 10.0);
    let frames = (secs * VIDEO_FPS as f64) as i64 / 8 * 8 + 1; // LTX 要 8n+1 格
    let pixels = match s(p.get("video_res"), "720p") {
        "480p" => 848.0 * 480.0,
        _ => 1280.0 * 720.0,
    };
    let init = p.get("init_image").filter(|v| truthy(Some(v))).cloned();
    let preview = truthy(p.get("video_preview"));
    // 兩段都要是 32 的倍數 → 最終尺寸取 64 的倍數
    let (w, h) = match &init {
        Some(name) => {
            let (ow, oh) = image_size(&input_dir.join(name.as_str().unwrap_or("")))?;
            fit_pixels(ow, oh, pixels, 64)
        }
        None => fit_pixels(
            i(p.get("width"), 1280).max(64),
            i(p.get("height"), 720).max(64),
            pixels,
            64,
        ),
    };
    let mut g = Graph::new("ltx23");
    let ck = g.add("CheckpointLoaderSimple", json!({"ckpt_name": VIDEO_CKPT}));
    // 影片 LoRA（動作、鏡頭…）：接在 checkpoint 後面，兩段取樣共用同一個 guider 都吃得到
    let loras: Vec<Value> = p
        .get("video_loras")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|l| l.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty()))
        .map(|l| json!({"name": l["name"], "strength": f(l.get("strength"), 1.0)}))
        .collect();
    let mut model = ck.clone();
    for l in &loras {
        model = g.add(
            "LoraLoaderModelOnly",
            json!({"model": model, "lora_name": l["name"], "strength_model": l["strength"]}),
        );
    }
    let vae = Graph::slot(&ck, 2);
    let clip = g.add(
        "LTXAVTextEncoderLoader",
        json!({"text_encoder": VIDEO_TE, "ckpt_name": VIDEO_CKPT, "device": "default"}),
    );
    let avae = g.add("LTXVAudioVAELoader", json!({"ckpt_name": VIDEO_CKPT}));
    let pos = g.add("CLIPTextEncode", json!({"clip": clip, "text": prompt}));
    // CFG 1 用不到負面：直接把正面歸零，省一次讀文字
    let neg = g.add("ConditioningZeroOut", json!({"conditioning": pos}));
    let cond = g.add(
        "LTXVConditioning",
        json!({"positive": pos, "negative": neg, "frame_rate": VIDEO_FPS as f64}),
    );
    let vlat = g.add(
        "EmptyLTXVLatentVideo",
        json!({"width": w / 2, "height": h / 2, "length": frames, "batch_size": 1}),
    );
    let alat = g.add(
        "LTXVEmptyLatentAudio",
        json!({"frames_number": frames, "frame_rate": VIDEO_FPS, "batch_size": 1, "audio_vae": avae}),
    );
    let guider = g.add(
        "LTXVDualCFGGuider",
        json!({"model": model, "positive": cond, "negative": Graph::slot(&cond, 1), "video_cfg": 1.0, "audio_cfg": 1.0}),
    );
    let sampler = g.add("KSamplerSelect", json!({"sampler_name": VIDEO_SAMPLER_1}));
    let mut v1 = vlat.clone();
    let mut pre = None;
    if let Some(name) = &init {
        let li = g.add("LoadImage", json!({"image": name}));
        let rs = g.add(
            "ResizeImageMaskNode",
            json!({"input": li, "resize_type": "scale longer dimension", "resize_type.longer_size": 1536, "scale_method": "lanczos"}),
        );
        let pp = g.add(
            "LTXVPreprocess",
            json!({"image": rs, "img_compression": 18}),
        );
        v1 = g.add(
            "LTXVImgToVideoInplace",
            json!({"vae": vae, "image": pp, "latent": vlat, "strength": 0.75, "bypass": false}),
        );
        pre = Some(pp);
    }
    let av1 = g.add(
        "LTXVConcatAVLatent",
        json!({"video_latent": v1, "audio_latent": alat}),
    );
    let sig1 = g.add("ManualSigmas", json!({"sigmas": VIDEO_SIGMAS_1}));
    let n1 = g.add("RandomNoise", json!({"noise_seed": seed}));
    let run1 = g.add(
        "SamplerCustomAdvanced",
        json!({"noise": n1, "guider": guider, "sampler": sampler, "sigmas": sig1, "latent_image": av1}),
    );
    let sep1 = g.add("LTXVSeparateAVLatent", json!({"av_latent": run1}));
    // 預覽（挑種子）：只跑第一段就解碼，半解析度；正式版用同一個種子重跑，第一段結果一樣，再接第二段放大
    let last = if preview {
        sep1.clone()
    } else {
        let upm = g.add(
            "LatentUpscaleModelLoader",
            json!({"model_name": VIDEO_UPSCALER}),
        );
        let up = g.add(
            "LTXVLatentUpsampler",
            json!({"samples": sep1, "upscale_model": upm, "vae": vae}),
        );
        let v2 = match &pre {
            Some(pp) => g.add(
                "LTXVImgToVideoInplace",
                json!({"vae": vae, "image": pp, "latent": up, "strength": 1.0, "bypass": false}),
            ),
            None => up,
        };
        let av2 = g.add(
            "LTXVConcatAVLatent",
            json!({"video_latent": v2, "audio_latent": Graph::slot(&sep1, 1)}),
        );
        let sig2 = g.add("ManualSigmas", json!({"sigmas": VIDEO_SIGMAS_2}));
        let n2 = g.add("RandomNoise", json!({"noise_seed": seed.wrapping_add(1)}));
        let sampler2 = g.add("KSamplerSelect", json!({"sampler_name": VIDEO_SAMPLER_2}));
        let run2 = g.add(
        "SamplerCustomAdvanced",
        json!({"noise": n2, "guider": guider, "sampler": sampler2, "sigmas": sig2, "latent_image": av2}),
    );
        g.add("LTXVSeparateAVLatent", json!({"av_latent": run2}))
    };
    let frames_img = g.add(
        "VAEDecodeTiled",
        json!({"samples": last, "vae": vae, "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 16}),
    );
    let audio = g.add(
        "LTXVAudioVAEDecode",
        json!({"samples": Graph::slot(&last, 1), "audio_vae": avae}),
    );
    let video = g.add(
        "CreateVideo",
        json!({"images": frames_img, "fps": VIDEO_FPS as f64, "audio": audio}),
    );
    g.add(
        "SaveVideo",
        json!({"video": video, "filename_prefix": if preview { "AnimaWeb/video_preview" } else { "AnimaWeb/video" }, "format": "auto", "format.codec": "auto"}),
    );
    if let Some(poster) = p.get("poster").and_then(Value::as_str) {
        let first = g.add(
            "ImageFromBatch",
            json!({"image": frames_img, "batch_index": 0, "length": 1}),
        );
        g.add(
            "SaveImage",
            json!({"images": first, "filename_prefix": format!("AnimaWeb/_poster/{poster}")}),
        );
        // 導演台：最後一格也存下來，當下一段的第一格（_poster 不進圖庫；用 - 不用 _，免得被當成封面）
        if truthy(p.get("save_last")) {
            let last = g.add(
                "ImageFromBatch",
                json!({"image": frames_img, "batch_index": frames - 1, "length": 1}),
            );
            g.add(
                "SaveImage",
                json!({"images": last, "filename_prefix": format!("AnimaWeb/_poster/{poster}-last")}),
            );
        }
    }
    let (ow, oh) = if preview { (w / 2, h / 2) } else { (w, h) };
    let mut info = json!({"prompt": prompt, "negative": "", "seed": seed, "width": ow, "height": oh, "mode": "video", "family": "ltx23",
                      "frames": frames, "fps": VIDEO_FPS, "preview": preview});
    if !loras.is_empty() {
        info["video_loras"] = json!(loras);
    }
    Ok((g.nodes, info))
}

/// 回傳 (nodes, info)。info 是實際使用的提示詞、種子、尺寸，存進圖庫。
pub fn build(p: &Value, input_dir: &Path, seed_offset: i64) -> R<(Map<String, Value>, Value)> {
    if s(p.get("mode"), "") == "video" {
        return build_video(p, input_dir, seed_offset);
    }
    let seed = i(p.get("seed"), 0) + seed_offset;
    let mut rng = PyRandom::new(seed);
    let mut prompt = expand_wildcards(s(p.get("prompt"), ""), &mut rng);
    let negative = expand_wildcards(s(p.get("negative"), ""), &mut rng);
    let mode = s(p.get("mode"), "txt2img").to_string();
    let mut fam = p
        .get("family")
        .and_then(|v| v.as_str())
        .filter(|x| !x.is_empty())
        .unwrap_or("anima")
        .to_string();
    let q = fam == "qwen21";
    let step = if q { 32 } else { 16 };
    let mut g = Graph::new(&fam);
    let inp = |name: &Value| input_dir.join(name.as_str().unwrap_or(""));
    let empty = json!({});

    let (img, w, h);
    match mode.as_str() {
        "txt2img" => {
            let (w0, h0) = (
                snap(f(p.get("width"), 0.0), step, 256),
                snap(f(p.get("height"), 0.0), step, 256),
            );
            let cl = control_list(&mut g, p, w0, h0);
            let model = model_chain(&mut g, p, cl);
            let lay = if g.moss() { Layout::from_params(p, &prompt, &mut rng) } else { None };
            let (pos, neg) = if q {
                let (a, b, _) = g.qtext(&prompt, &negative, &[]);
                (a, b)
            } else {
                let t = lay.as_ref().map_or_else(|| prompt.clone(), |l| l.prompt(w0, h0));
                (g.text(&t), g.text(&negative))
            };
            // 姿勢參考圖（MOSS）：MOSS 沒有 ControlNet，改成從 3D 人偶的深度圖出發、重繪 0.95（Qwen 2.1 走 model_chain 裡的 Fun ControlNet）。
            // 2026-10-17 實測（E:\AI\moss_test\exp_replace.py p1／p2）：0.95 是寫實照片、姿勢和鏡頭跟著深度圖；0.85 會留下深度圖的平塗和黑底
            let pose_depth = p
                .get("pose_control")
                .and_then(|pc| pc.get("depth"))
                .and_then(Value::as_str)
                .filter(|x| g.moss() && !x.is_empty());
            let (lat, denoise) = match pose_depth {
                Some(file) => {
                    let li = g.add("LoadImage", json!({"image": format!("{POSE_INPUT}/{file}")}));
                    let src = g.scale(&li, w0, h0, "center", "lanczos");
                    (g.encode(&src, w0, h0), f(p["pose_control"].get("denoise"), 0.95))
                }
                None => (g.empty_latent(w0, h0), 1.0),
            };
            let smp = sample(
                &mut g,
                &model,
                &pos,
                &neg,
                &lat,
                p,
                seed,
                denoise,
                None,
                (w0, h0),
            );
            let im = g.decode(&smp, w0, h0);
            (img, w, h) = hires(&mut g, im, p, &model, &pos, &neg, seed, w0, h0, lay.as_ref());
        }
        "img2img" => {
            let init = p.get("init_image").cloned().unwrap_or(Value::Null);
            let (ow, oh) = image_size(&inp(&init))?;
            let (w0, h0) = if s(p.get("size_mode"), "auto") == "auto" {
                fit_pixels(
                    ow,
                    oh,
                    or_f(p, "pixels", if q { QWEN21_PIXELS } else { 1024.0 * 1536.0 }),
                    step,
                )
            } else {
                (
                    snap(f(p.get("width"), 0.0), step, 256),
                    snap(f(p.get("height"), 0.0), step, 256),
                )
            };
            let li = g.add("LoadImage", json!({"image": init}));
            let src = g.scale(&li, w0, h0, "center", "lanczos");
            let cl = control_list(&mut g, p, w0, h0);
            let model = model_chain(&mut g, p, cl);
            let denoise = f(p.get("denoise"), if q { 1.0 } else { 0.6 });
            let lay = if g.moss() { Layout::from_params(p, &prompt, &mut rng) } else { None };
            let (pos, neg, lat);
            if q {
                let (a, b, e) = g.qtext(&prompt, &negative, std::slice::from_ref(&src));
                pos = a;
                neg = b;
                // 1.0：照參考圖整張重畫（官方改圖流程）；低於 1：從原圖像素出發
                lat = if denoise >= 0.999 {
                    e
                } else {
                    g.encode(&src, w0, h0)
                };
            } else {
                pos = g.text(&lay.as_ref().map_or_else(|| prompt.clone(), |l| l.prompt(w0, h0)));
                neg = g.text(&negative);
                lat = g.encode(&src, w0, h0);
            }
            let smp = sample(
                &mut g,
                &model,
                &pos,
                &neg,
                &lat,
                p,
                seed,
                denoise.min(1.0),
                None,
                (w0, h0),
            );
            let im = g.decode(&smp, w0, h0);
            (img, w, h) = hires(&mut g, im, p, &model, &pos, &neg, seed, w0, h0, lay.as_ref());
        }
        "inpaint" | "outpaint" => {
            // 擴圖＝局部重繪的特例：ImagePadForOutpaint 把畫布往外補灰、外圈當遮罩（往原圖內羽化），整張重畫遮罩那圈
            let outpaint = mode == "outpaint";
            let init = p.get("init_image").cloned().unwrap_or(Value::Null);
            let mask_name = p.get("mask").cloned().unwrap_or(Value::Null);
            let (mut ow, mut oh) = image_size(&inp(&init))?;
            let ip = p
                .get("inpaint")
                .filter(|v| truthy(Some(v)))
                .unwrap_or(&empty);
            let (orig, full_mask);
            if outpaint {
                let op = p.get("outpaint").filter(|v| v.is_object()).unwrap_or(&empty);
                // 節點要 8 的倍數：往上取
                let side = |k: &str| (i(op.get(k), 0).clamp(0, 2048) + 7) / 8 * 8;
                let (l, t, r, b) = (side("left"), side("top"), side("right"), side("bottom"));
                if l + t + r + b == 0 {
                    return err("擴圖：至少要選一邊往外擴");
                }
                let li = g.add("LoadImage", json!({"image": init}));
                let feather = i(op.get("feather"), 40).clamp(0, 400);
                let pad = g.add(
                    "ImagePadForOutpaint",
                    json!({"image": li, "left": l, "top": t, "right": r, "bottom": b, "feathering": feather}),
                );
                orig = pad.clone();
                full_mask = Graph::slot(&pad, 1);
                (ow, oh) = (ow + l + r, oh + t + b);
                if ow * oh > 4096 * 4096 {
                    return err("擴圖後超過 4096×4096，請把往外擴的像素改小");
                }
            } else {
                orig = g.add("LoadImage", json!({"image": init}));
                full_mask = g.add(
                    "LoadImageMask",
                    json!({"image": mask_name, "channel": "red"}),
                );
            }
            let (rx, ry, rw, rh, region, rmask);
            if !outpaint && s(ip.get("area"), "") == "masked" {
                let Some(bb) = mask_bbox(&inp(&mask_name))? else {
                    return err("遮罩是空的，請先在圖上塗出要重繪的區域");
                };
                let pad = i(ip.get("padding"), 64).clamp(0, 1024);
                let (x0, y0) = ((bb.0 - pad).max(0), (bb.1 - pad).max(0));
                let (x1, y1) = (ow.min(bb.2 + pad), oh.min(bb.3 + pad));
                (rx, ry, rw, rh) = (x0, y0, x1 - x0, y1 - y0);
                region = g.add(
                    "ImageCrop",
                    json!({"image": orig, "width": rw, "height": rh, "x": rx, "y": ry}),
                );
                let mi = g.add("MaskToImage", json!({"mask": full_mask}));
                let crop = g.add(
                    "ImageCrop",
                    json!({"image": mi, "width": rw, "height": rh, "x": rx, "y": ry}),
                );
                rmask = g.add("ImageToMask", json!({"channel": "red", "image": crop}));
            } else {
                (rx, ry, rw, rh) = (0, 0, ow, oh);
                region = orig.clone();
                rmask = full_mask.clone();
            }
            let (w0, h0) = fit_pixels(rw, rh, f(ip.get("pixels"), 1024.0 * 1024.0), step);
            let work = g.scale(&region, w0, h0, "disabled", "lanczos");
            let mut wmask = g.mask_scale(&rmask, w0, h0);
            let grow = i(ip.get("grow"), 8);
            if grow != 0 {
                let expand = 1i64.max((grow as f64 * w0 as f64 / rw as f64).trunc() as i64);
                wmask = g.add(
                    "GrowMask",
                    json!({"mask": wmask, "expand": expand, "tapered_corners": true}),
                );
            }
            let mut lll = vec![];
            if s(ip.get("method"), "lllite") == "lllite" && g.family == "anima" {
                lll.push((
                    lllite("inpaint"),
                    work.clone(),
                    Some(wmask.clone()),
                    f(ip.get("strength"), 1.0),
                    0.0,
                    1.0,
                ));
            }
            let model = model_chain(&mut g, p, lll);
            // Qwen 2.1：整塊區域當參考圖，重繪處才接得上周圍（擴圖時它會照參考圖把灰邊畫出來：補一句叫它延伸場景）
            let (pos, neg) = if q {
                let qp = if outpaint { format!("{OUTPAINT_HINT} {prompt}") } else { prompt.clone() };
                let (a, b, _) = g.qtext(&qp, &negative, std::slice::from_ref(&work));
                (a, b)
            } else {
                (g.text(&prompt), g.text(&negative))
            };
            let enc = g.encode(&work, w0, h0);
            let lat = g.add("SetLatentNoiseMask", json!({"samples": enc, "mask": wmask}));
            let smp = sample(
                &mut g,
                &model,
                &pos,
                &neg,
                &lat,
                p,
                seed,
                f(p.get("denoise"), 1.0),
                None,
                (w0, h0),
            );
            let out = g.decode(&smp, w0, h0);
            // 縮回原尺寸後貼回原圖：遮罩外的像素完全保留，邊緣用模糊遮罩過渡
            let out = g.scale(&out, rw, rh, "disabled", "lanczos");
            let cmask = if grow != 0 {
                g.add(
                    "GrowMask",
                    json!({"mask": rmask, "expand": grow, "tapered_corners": true}),
                )
            } else {
                rmask.clone()
            };
            let cmask = g.mask_blur(&cmask, i(ip.get("blur"), 12));
            img = g.add("ImageCompositeMasked", json!({"destination": orig, "source": out, "x": rx, "y": ry, "resize_source": false, "mask": cmask}));
            (w, h) = (ow, oh);
        }
        "multiref" => {
            // 多圖參考（只有 Qwen 2.1）：最多 10 張參考圖一起交給編碼器，提示詞用 <image1>… 指名
            if !q {
                return err("多圖參考只支援 Qwen 2.1 模型（Noct Q），請先在「模型」換成 Qwen 2.1");
            }
            let refs: Vec<&Value> = match p.get("refs") {
                Some(Value::Array(a)) => a
                    .iter()
                    .filter(|r| truthy(r.get("image")))
                    .take(10)
                    .collect(),
                _ => vec![],
            };
            if refs.is_empty() {
                return err("請先加入至少一張參考圖");
            }
            let auto = s(p.get("size_mode"), "auto") == "auto";
            let (rw0, rh0) = image_size(&inp(&refs[0]["image"]))?;
            let (w0, h0) = if auto {
                fit_pixels(rw0, rh0, or_f(p, "pixels", QWEN21_PIXELS), step)
            } else {
                (
                    snap(f(p.get("width"), 0.0), step, 256),
                    snap(f(p.get("height"), 0.0), step, 256),
                )
            };
            let mut imgs = vec![];
            for (k, r) in refs.iter().enumerate() {
                let (tw, th) = if k == 0 && auto {
                    (w0, h0)
                } else {
                    let (iw, ih) = image_size(&inp(&r["image"]))?;
                    fit_pixels(iw, ih, or_f(p, "ref_pixels", 512.0 * 1024.0), step)
                };
                let li = g.add("LoadImage", json!({"image": r["image"]}));
                imgs.push(g.scale(&li, tw, th, "center", "lanczos"));
            }
            let model = model_chain(&mut g, p, vec![]);
            let (pos, neg, mut lat) = g.qtext(&prompt, &negative, &imgs);
            if !auto {
                lat = g.add(
                    "EmptyLatentImage",
                    json!({"width": w0, "height": h0, "batch_size": 1}),
                );
            }
            let smp = sample(
                &mut g,
                &model,
                &pos,
                &neg,
                &lat,
                p,
                seed,
                1.0,
                None,
                (w0, h0),
            );
            img = g.decode(&smp, w0, h0);
            (w, h) = (w0, h0);
        }
        "strip" => {
            // 一鍵脫衣：Qwen 2.1 改圖脫掉 →（可選）Anima 低重繪精修 →（可選）只把改到的地方貼回 Qwen 那張
            let init = p.get("init_image").cloned().unwrap_or(Value::Null);
            let (ow, oh) = image_size(&inp(&init))?;
            let st = p.get("strip").filter(|v| v.is_object()).unwrap_or(&empty);
            // 改圖指令和精修 tag 由內容補丁算好塞進 params（server::api_gen::prepare），graph 本身不含露骨文字
            // 生成頁選的是 Qwen 模型就用它（連同步數、CFG、LoRA）；不然用官方 Turbo，LoRA 留給 Anima 精修那段
            let qp = edit_qwen_params(p, &fam);
            g.switch_family("qwen21");
            let (w0, h0) = fit_pixels(ow, oh, QWEN21_PIXELS, 32);
            let li = g.add("LoadImage", json!({"image": init}));
            let src = g.scale(&li, w0, h0, "center", "lanczos");
            let qprompt = s(st.get("qwen_prompt"), "").to_string();
            let qmodel = model_chain(&mut g, &qp, vec![]);
            let (qpos, qneg, qlat) = g.qtext(&qprompt, "", std::slice::from_ref(&src));
            let qs = sample(&mut g, &qmodel, &qpos, &qneg, &qlat, &qp, seed, 1.0, None, (w0, h0));
            let qimg = g.decode(&qs, w0, h0);
            let refine = st.get("refine").map(|v| truthy(Some(v))).unwrap_or(true);
            if !refine {
                (img, w, h) = (qimg, w0, h0);
            } else {
                // 精修：Anima Turbo 8 步、CFG 1；生成頁是 Anima 時，它掛的 LoRA（畫風）一起用
                let rmodel = s(st.get("refine_model"), STRIP_REFINE).to_string();
                let turbo = rmodel.to_lowercase().contains("turbo");
                let ap = json!({
                    "model": rmodel, "turbo_lora": !turbo, "steps": if turbo { 8 } else { 10 }, "cfg": 1,
                    "sampler": "euler", "scheduler": "simple",
                    "loras": if fam == "anima" { p.get("loras").cloned().unwrap_or(json!([])) } else { json!([]) },
                });
                g.switch_family("anima");
                let (aw, ah) = fit_pixels(w0, h0, 1024.0 * 1536.0, 16);
                let qup = g.scale(&qimg, aw, ah, "disabled", "lanczos");
                let amodel = model_chain(&mut g, &ap, vec![]);
                // 不用生成頁的提示詞框：那裡常留著上一張的服裝 tag，精修會把衣服畫回去
                let tags = s(st.get("refine_tags"), "");
                let apos = g.text(tags);
                let aneg = g.text("");
                let alat = g.encode(&qup, aw, ah);
                let den = f(st.get("refine_denoise"), 0.35).clamp(0.1, 0.8);
                let asmp = sample(&mut g, &amodel, &apos, &aneg, &alat, &ap, seed, den, None, (aw, ah));
                let rimg = g.decode(&asmp, aw, ah);
                if st.get("merge").map(|v| truthy(Some(v))).unwrap_or(true) {
                    // 改到的地方＝原圖和 Qwen 結果任一色版差超過門檻；先縮一點去掉線條錯位的雜點，再撐大、縮回補洞，最後柔化邊緣
                    let diff = g.add("ImageBlend", json!({"image1": src, "image2": qimg, "blend_factor": 1.0, "blend_mode": "difference"}));
                    let th = f(st.get("threshold"), 0.15);
                    let mut m: Option<Ref> = None;
                    for ch in ["red", "green", "blue"] {
                        let c = g.add("ImageToMask", json!({"image": diff, "channel": ch}));
                        let t = g.add("ThresholdMask", json!({"mask": c, "value": th}));
                        m = Some(match m {
                            None => t,
                            Some(prev) => g.add("MaskComposite", json!({"destination": prev, "source": t, "x": 0, "y": 0, "operation": "or"})),
                        });
                    }
                    let mut m = m.unwrap();
                    for e in [-2, 20, -14] {
                        m = g.add("GrowMask", json!({"mask": m, "expand": e, "tapered_corners": true}));
                    }
                    let m = g.mask_blur(&m, 6);
                    let m = g.mask_scale(&m, aw, ah);
                    img = g.add("ImageCompositeMasked", json!({"destination": qup, "source": rimg, "x": 0, "y": 0, "resize_source": false, "mask": m}));
                } else {
                    img = rimg;
                }
                (w, h) = (aw, ah);
            }
            prompt = qprompt;
            fam = "qwen21".into();
        }
        "sheet" => {
            // 四視圖編輯：圖1＝角色設定稿（構圖、尺寸照它），圖2＝可選的服裝參考；Qwen 改圖重繪 1.0
            let init = p.get("init_image").cloned().unwrap_or(Value::Null);
            let (ow, oh) = image_size(&inp(&init))?;
            let sh = p.get("sheet").filter(|v| v.is_object()).unwrap_or(&empty);
            let req = s(sh.get("req"), "").trim().to_string();
            if req.is_empty() {
                return err("請先寫「修改要求」（或從常用要求挑一個）");
            }
            let qp = edit_qwen_params(p, &fam);
            g.switch_family("qwen21");
            let (w0, h0) = fit_pixels(ow, oh, 1280.0 * 1280.0, 32);
            let li = g.add("LoadImage", json!({"image": init}));
            let mut imgs = vec![g.scale(&li, w0, h0, "center", "lanczos")];
            let rf = sh.get("ref").filter(|v| truthy(Some(v))).cloned();
            if let Some(rf) = &rf {
                let (rw, rh) = image_size(&inp(rf))?;
                let (tw, th) = fit_pixels(rw, rh, 1024.0 * 1024.0, 32);
                let ri = g.add("LoadImage", json!({"image": rf}));
                imgs.push(g.scale(&ri, tw, th, "center", "lanczos"));
            }
            let sp = sheet_prompt(&req, rf.is_some());
            let model = model_chain(&mut g, &qp, vec![]);
            let (pos, neg, lat) = g.qtext(&sp, "", &imgs);
            let smp = sample(&mut g, &model, &pos, &neg, &lat, &qp, seed, 1.0, None, (w0, h0));
            img = g.decode(&smp, w0, h0);
            (w, h) = (w0, h0);
            prompt = sp;
            fam = "qwen21".into();
        }
        "diff" => {
            // 差分：一張角色圖改表情／動作，Qwen 2.1 改圖重繪 1.0（生成頁不是 Qwen 時用官方 Turbo）
            let init = p.get("init_image").cloned().unwrap_or(Value::Null);
            let (ow, oh) = image_size(&inp(&init))?;
            let req = p.get("diff").map(|d| s(d.get("req"), "")).unwrap_or("").trim().to_string();
            if req.is_empty() {
                return err("差分：請先選或寫一個要改的表情／動作");
            }
            let qp = edit_qwen_params(p, &fam);
            g.switch_family("qwen21");
            let (w0, h0) = fit_pixels(ow, oh, QWEN21_PIXELS, 32);
            let li = g.add("LoadImage", json!({"image": init}));
            let src = g.scale(&li, w0, h0, "center", "lanczos");
            let dp = diff_prompt(&req);
            let model = model_chain(&mut g, &qp, vec![]);
            let (pos, neg, lat) = g.qtext(&dp, "", std::slice::from_ref(&src));
            let smp = sample(&mut g, &model, &pos, &neg, &lat, &qp, seed, 1.0, None, (w0, h0));
            img = g.decode(&smp, w0, h0);
            (w, h) = (w0, h0);
            prompt = dp;
            fam = "qwen21".into();
        }
        "detail" => {
            // 修臉／修手：/api/detail 先用 SAM3 找出每個物件的遮罩（存在 input），這裡每個遮罩各裁一塊、放大重畫、貼回；
            // 一段接一段（下一段的底圖是上一段貼好的），共用同一組模型，不用 LLLite（低重繪不需要）
            let init = p.get("init_image").cloned().unwrap_or(Value::Null);
            let (ow, oh) = image_size(&inp(&init))?;
            let dt = p.get("detail").filter(|v| v.is_object()).unwrap_or(&empty);
            let masks: Vec<Value> = dt
                .get("masks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|m| truthy(Some(m)))
                .take(8)
                .cloned()
                .collect();
            if masks.is_empty() {
                return err("修細節：沒有偵測到要修的地方");
            }
            let den = f(p.get("denoise"), 0.4).clamp(0.05, 1.0);
            let grow = i(dt.get("grow"), 8).clamp(0, 64);
            let blur = i(dt.get("blur"), 8).clamp(0, 64);
            let pixels = f(dt.get("pixels"), 1024.0 * 1024.0).clamp(256.0 * 256.0, 1536.0 * 1536.0);
            let extra = s(dt.get("extra"), "").trim();
            let text = if extra.is_empty() { prompt.clone() } else { format!("{prompt}, {extra}") };
            let model = model_chain(&mut g, p, vec![]);
            let shared = (!q).then(|| (g.text(&text), g.text(&negative)));
            let mut cur = g.add("LoadImage", json!({"image": init}));
            for (k, m) in masks.iter().enumerate() {
                let Some(bb) = mask_bbox(&inp(m))? else {
                    continue;
                };
                // 外框四周多留一點（物件越大留越多），重畫時才看得到周圍、接得上
                let pad = 24.max((bb.2 - bb.0).max(bb.3 - bb.1) / 3);
                let (x0, y0) = ((bb.0 - pad).max(0), (bb.1 - pad).max(0));
                let (x1, y1) = (ow.min(bb.2 + pad), oh.min(bb.3 + pad));
                let (rw, rh) = (x1 - x0, y1 - y0);
                let region = g.add("ImageCrop", json!({"image": cur, "width": rw, "height": rh, "x": x0, "y": y0}));
                let lm = g.add("LoadImageMask", json!({"image": m, "channel": "red"}));
                let mi = g.add("MaskToImage", json!({"mask": lm}));
                let crop = g.add("ImageCrop", json!({"image": mi, "width": rw, "height": rh, "x": x0, "y": y0}));
                let rmask = g.add("ImageToMask", json!({"channel": "red", "image": crop}));
                let (w0, h0) = fit_pixels(rw, rh, pixels, step);
                let work = g.scale(&region, w0, h0, "disabled", "lanczos");
                let mut wmask = g.mask_scale(&rmask, w0, h0);
                if grow > 0 {
                    let expand = 1i64.max((grow as f64 * w0 as f64 / rw as f64).trunc() as i64);
                    wmask = g.add("GrowMask", json!({"mask": wmask, "expand": expand, "tapered_corners": true}));
                }
                let (pos, neg) = match &shared {
                    Some(x) => x.clone(),
                    None => {
                        let (a, b, _) = g.qtext(&text, &negative, std::slice::from_ref(&work));
                        (a, b)
                    }
                };
                let enc = g.encode(&work, w0, h0);
                let lat = g.add("SetLatentNoiseMask", json!({"samples": enc, "mask": wmask}));
                let smp = sample(&mut g, &model, &pos, &neg, &lat, p, seed + k as i64, den, None, (w0, h0));
                let out = g.decode(&smp, w0, h0);
                let out = g.scale(&out, rw, rh, "disabled", "lanczos");
                let cmask = if grow > 0 {
                    g.add("GrowMask", json!({"mask": rmask, "expand": grow, "tapered_corners": true}))
                } else {
                    rmask.clone()
                };
                let cmask = g.mask_blur(&cmask, blur);
                cur = g.add(
                    "ImageCompositeMasked",
                    json!({"destination": cur, "source": out, "x": x0, "y": y0, "resize_source": false, "mask": cmask}),
                );
            }
            img = cur;
            (w, h) = (ow, oh);
        }
        "rembg" => {
            // 一鍵去背：BiRefNet 出前景遮罩 → 當透明度接回原圖（官方藍圖 Remove Background (BiRefNet) 的接法），存成透明 PNG
            let init = p.get("init_image").cloned().unwrap_or(Value::Null);
            let (ow, oh) = image_size(&inp(&init))?;
            let li = g.add("LoadImage", json!({"image": init}));
            let bm = g.add("LoadBackgroundRemovalModel", json!({"bg_removal_name": s(p.get("bg_model"), BG_MODEL)}));
            let m = g.add("RemoveBackground", json!({"bg_removal_model": bm, "image": li}));
            let inv = g.add("InvertMask", json!({"mask": m}));
            img = g.add("JoinImageWithAlpha", json!({"image": li, "alpha": inv}));
            (w, h) = (ow, oh);
        }
        "upscale" => {
            let init = p.get("init_image").cloned().unwrap_or(Value::Null);
            let (ow, oh) = image_size(&inp(&init))?;
            let up = p
                .get("upscale")
                .filter(|v| truthy(Some(v)))
                .unwrap_or(&empty);
            let sc = f(up.get("scale"), 2.0);
            let st = if q { 32 } else { 8 };
            let (w0, h0) = (snap(ow as f64 * sc, st, 64), snap(oh as f64 * sc, st, 64));
            let loader = g.add(
                "UpscaleModelLoader",
                json!({"model_name": raw(up, "upscaler", json!("4x-AnimeSharp.safetensors"))}),
            );
            let li = g.add("LoadImage", json!({"image": init}));
            let im = g.add(
                "ImageUpscaleWithModel",
                json!({"upscale_model": loader, "image": li}),
            );
            let mut im = g.scale(&im, w0, h0, "disabled", "lanczos");
            if truthy(up.get("refine")) {
                let model = model_chain(&mut g, p, vec![]);
                let (pos, neg) = if q {
                    let (a, b, _) = g.qtext(&prompt, &negative, &[]);
                    (a, b)
                } else {
                    (g.text(&prompt), g.text(&negative))
                };
                let lat = g.encode(&im, w0, h0);
                let smp = sample(
                    &mut g,
                    &model,
                    &pos,
                    &neg,
                    &lat,
                    p,
                    seed,
                    f(up.get("denoise"), 0.3),
                    None,
                    (w0, h0),
                );
                im = g.decode(&smp, w0, h0);
            }
            (img, w, h) = (im, w0, h0);
        }
        other => return err(format!("未知的模式：{other}")),
    }
    g.add(
        "SaveImage",
        json!({"images": img, "filename_prefix": format!("AnimaWeb/{mode}")}),
    );
    let info = json!({"prompt": prompt, "negative": negative, "seed": seed, "width": w, "height": h, "mode": mode, "family": fam});
    Ok((g.nodes, info))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moss_txt2img_graph() {
        let dir = std::env::temp_dir();
        let p = json!({"mode": "txt2img", "family": "moss", "model": "moss_image_sft_int8_convrot.safetensors", "prompt": "a cat", "negative": "",
                       "seed": 1, "width": 1024, "height": 1024, "steps": 50, "cfg": 3, "sampler": "euler", "scheduler": "sgm_uniform"});
        let (n, info) = build(&p, &dir, 0).unwrap();
        let by = |c: &str| n.values().find(|v| v["class_type"] == c).cloned();
        let clip = by("CLIPLoader").unwrap();
        assert_eq!(clip["inputs"]["type"], "moss_image");
        assert_eq!(clip["inputs"]["clip_name"], MOSS_TE);
        assert_eq!(by("VAELoader").unwrap()["inputs"]["vae_name"], MOSS_VAE);
        assert!(by("EmptyFlux2LatentImage").is_some() && by("EmptyLatentImage").is_none());
        assert_eq!(by("ModelSamplingAuraFlow").unwrap()["inputs"]["shift"], 5.0);
        assert!(by("ModelSamplingSD3").is_none());
        assert_eq!(by("SkipLayerGuidanceDiTSimple").unwrap()["inputs"]["single_layers"], "22");
        let ks = by("KSampler").unwrap();
        assert_eq!(ks["inputs"]["scheduler"], "sgm_uniform");
        assert_eq!(info["family"], "moss");
        // CFG 1：沒有負面那一路，不接跳層
        let mut p1 = p.clone();
        p1["cfg"] = json!(1);
        let (n1, _) = build(&p1, &dir, 0).unwrap();
        assert!(!n1.values().any(|v| v["class_type"] == "SkipLayerGuidanceDiTSimple"));
        assert!(n1.values().any(|v| v["class_type"] == "ModelSamplingAuraFlow"));
    }

    #[test]
    fn moss_layout_prompt() {
        // 官方 layout.md 的例子：1536×1024 的杯子 [176,224,800,864]（xyxy 像素）→ [-288,-592,352,32]
        let p = json!({"layout": [
            {"type": "object", "desc": "a {white|white} ceramic cup", "box": [176.0 / 1536.0, 224.0 / 1024.0, 800.0 / 1536.0, 864.0 / 1024.0]},
            {"type": "text", "desc": "", "text": "把日常，过成诗。", "box": [0.6, 0.25, 0.9, 0.45]},
            {"type": "character", "desc": "", "box": [0.1, 0.1, 0.5, 0.5]},
            {"type": "character", "desc": "too small", "box": [0.1, 0.1, 0.105, 0.5]}]});
        let mut rng = PyRandom::new(1);
        let l = Layout::from_params(&p, " warm studio photo ", &mut rng).unwrap();
        let v: Value = serde_json::from_str(&l.prompt(1536, 1024)).unwrap();
        assert_eq!(v["summary"]["caption"], "warm studio photo");
        assert_eq!(v["bbox_coord_space"], "abs_centralized");
        assert_eq!(v["bbox_format"], "yxyx");
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "沒描述的框、太小的框不要");
        assert_eq!(items[0], json!({"label": "object", "caption": "a white ceramic cup", "bbox": [-288, -592, 352, 32]}));
        assert_eq!(items[1]["label"], "text");
        assert_eq!(items[1]["text"], "把日常，过成诗。");
        assert_eq!(items[1]["caption"], "clear, legible lettering");
        // 一行、鍵的順序照官方
        let s = l.prompt(1536, 1024);
        assert!(!s.contains('\n') && s.starts_with("{\"summary\""));

        // 接進節點圖：MOSS 才包成 JSON；圖庫記的 prompt 還是使用者寫的那句；高解析修復照放大後的尺寸重算
        let dir = std::env::temp_dir();
        let mut q = json!({"mode": "txt2img", "family": "moss", "model": "m.safetensors", "prompt": "a cat {red|red} sofa", "negative": "",
                           "seed": 1, "width": 1024, "height": 1024, "steps": 25, "cfg": 3, "sampler": "euler", "scheduler": "sgm_uniform",
                           "layout": [{"type": "character", "desc": "a cat", "box": [0.25, 0.25, 0.75, 0.75]}],
                           "hires": {"enabled": true, "scale": 1.5, "denoise": 0.4}});
        let texts = |n: &Map<String, Value>| -> Vec<String> {
            n.values().filter(|v| v["class_type"] == "CLIPTextEncode").map(|v| v["inputs"]["text"].as_str().unwrap().to_string()).collect()
        };
        let (n, info) = build(&q, &dir, 0).unwrap();
        assert_eq!(info["prompt"], "a cat red sofa");
        let t = texts(&n);
        let lays: Vec<Value> = t.iter().filter_map(|x| serde_json::from_str::<Value>(x).ok()).collect();
        assert_eq!(lays.len(), 2);
        assert_eq!(lays[0]["summary"]["caption"], "a cat red sofa");
        assert_eq!(lays[0]["items"][0]["bbox"], json!([-256, -256, 256, 256]));
        assert_eq!(lays[1]["items"][0]["bbox"], json!([-384, -384, 384, 384]));
        q["family"] = json!("anima");
        let (n, _) = build(&q, &dir, 0).unwrap();
        assert!(texts(&n).iter().all(|x| !x.starts_with('{')), "Anima 不吃排版 JSON");
        q["family"] = json!("moss");
        q["layout"] = json!([]);
        let (n, _) = build(&q, &dir, 0).unwrap();
        assert!(texts(&n).contains(&"a cat red sofa".to_string()));
    }

    #[test]
    fn moss_img2img_and_no_multiref() {
        let dir = std::env::temp_dir();
        let img = dir.join("aw_test_moss_i2i.png");
        image::RgbImage::new(832, 1216).save(&img).unwrap();
        let p = json!({"mode": "img2img", "family": "moss", "model": "moss_image_sft_int8_convrot.safetensors", "prompt": "a cat", "negative": "",
                       "seed": 1, "steps": 25, "cfg": 3, "sampler": "euler", "scheduler": "sgm_uniform", "init_image": "aw_test_moss_i2i.png",
                       "size_mode": "auto", "pixels": 1048576, "denoise": 0.85});
        let (n, info) = build(&p, &dir, 0).unwrap();
        let ks = n.values().find(|v| v["class_type"] == "KSampler").unwrap();
        assert_eq!(ks["inputs"]["denoise"], 0.85);
        assert!(n.values().any(|v| v["class_type"] == "VAEEncode"));
        assert!(!n.values().any(|v| v["class_type"] == "EmptyFlux2LatentImage"));
        assert_eq!(info["width"].as_i64().unwrap() % 16, 0);
        // 姿勢參考圖：MOSS 從深度圖出發重繪 0.95；Anima 改接 LLLite（深度＋骨架），還是從空白開始畫
        let pose = json!({"mode": "txt2img", "family": "moss", "model": "m.safetensors", "prompt": "a", "negative": "", "seed": 1, "steps": 25, "cfg": 3,
                          "width": 832, "height": 1216, "pose_control": {"depth": "cowgirl_depth.png", "pose": "cowgirl_pose.png"}});
        let (n, _) = build(&pose, &dir, 0).unwrap();
        assert!(n.values().any(|v| v["class_type"] == "LoadImage" && v["inputs"]["image"] == "anima_pose/cowgirl_depth.png"));
        assert_eq!(n.values().find(|v| v["class_type"] == "KSampler").unwrap()["inputs"]["denoise"], 0.95);
        let mut a = pose.clone();
        a["family"] = json!("anima");
        let (n, _) = build(&a, &dir, 0).unwrap();
        assert_eq!(n.values().filter(|v| v["class_type"] == "AnimaLLLiteApply").count(), 2);
        assert_eq!(n.values().find(|v| v["class_type"] == "KSampler").unwrap()["inputs"]["denoise"], 1.0);
        let mut m = p.clone();
        m["mode"] = json!("multiref");
        assert!(build(&m, &dir, 0).unwrap_err().0.contains("只支援 Qwen 2.1"));
        let _ = std::fs::remove_file(img);
    }

    #[test]
    fn strip_graph() {
        let dir = std::env::temp_dir();
        let img = dir.join("aw_test_strip.png");
        image::RgbImage::new(1024, 1536).save(&img).unwrap();
        // 改圖指令和精修 tag 由內容補丁算好塞進 params（prepare）；graph 只負責把它們放進節點
        let p = json!({"mode": "strip", "family": "anima", "model": "anima-turbo-v1.1.safetensors", "prompt": "", "negative": "", "seed": 5,
                       "init_image": "aw_test_strip.png", "loras": [{"name": "style.safetensors", "strength": 0.8}],
                       "strip": {"qwen_prompt": "改圖指令 A", "refine_tags": "refine tags A"}});
        let (n, info) = build(&p, &dir, 0).unwrap();
        let all = |c: &str| n.values().filter(|v| v["class_type"] == c).cloned().collect::<Vec<_>>();
        // 兩段：Qwen 官方 Turbo 改圖＋Anima 精修，各自的文字編碼器
        let unets: Vec<_> = all("UNETLoader").iter().map(|v| v["inputs"]["unet_name"].as_str().unwrap().to_string()).collect();
        assert_eq!(unets, vec![STRIP_QWEN.to_string(), STRIP_REFINE.to_string()]);
        assert_eq!(all("CLIPLoader").len(), 2);
        // params 的 qwen_prompt 進 Qwen 文字編碼，refine_tags 進 Anima 文字編碼
        let te = &all("TextEncodeQwenImage21")[0]["inputs"];
        assert_eq!(te["prompt"], "改圖指令 A");
        assert!(te.get("images.image_1").is_some());
        assert!(n.values().any(|v| v["inputs"]["text"] == "refine tags A"));
        // Anima 生成頁掛的 LoRA 只套在精修那段
        assert_eq!(all("LoraLoaderModelOnly").len(), 1);
        assert_eq!(all("KSampler")[0]["inputs"]["denoise"], 0.35);
        assert_eq!(all("ImageBlend")[0]["inputs"]["blend_mode"], "difference");
        assert_eq!(all("ImageCompositeMasked").len(), 1);
        assert_eq!(all("SaveImage")[0]["inputs"]["filename_prefix"], "AnimaWeb/strip");
        assert_eq!(info["mode"], "strip");
        assert_eq!(info["family"], "qwen21");
        // 精修那段約 150 萬像素：1024×1536 的原圖會回到原尺寸
        assert_eq!((info["width"].as_i64().unwrap(), info["height"].as_i64().unwrap()), (1024, 1536));
        // 不精修：只有 Qwen 那段，沒有貼回
        let mut p2 = p.clone();
        p2["strip"] = json!({"refine": false, "qwen_prompt": "只改這段"});
        let (n2, info2) = build(&p2, &dir, 0).unwrap();
        assert!(!n2.values().any(|v| v["class_type"] == "KSampler" || v["class_type"] == "ImageBlend"));
        assert!(n2.values().any(|v| v["class_type"] == "TextEncodeQwenImage21" && v["inputs"]["prompt"] == "只改這段"));
        assert_eq!(info2["width"].as_i64().unwrap() % 32, 0);
        // 精修但不貼回
        let mut p3 = p.clone();
        p3["strip"] = json!({"merge": false, "refine_denoise": 0.4, "qwen_prompt": "x", "refine_tags": "y"});
        let (n3, _) = build(&p3, &dir, 0).unwrap();
        assert!(!n3.values().any(|v| v["class_type"] == "ImageCompositeMasked"));
        let _ = std::fs::remove_file(img);
    }

    #[test]
    fn sheet_graph() {
        let dir = std::env::temp_dir();
        let sheet = dir.join("aw_test_sheet.png");
        let cloth = dir.join("aw_test_sheet_cloth.png");
        image::RgbImage::new(1536, 1024).save(&sheet).unwrap();
        image::RgbImage::new(832, 1216).save(&cloth).unwrap();
        let p = json!({"mode": "sheet", "family": "anima", "model": "anima-turbo-v1.1.safetensors", "prompt": "", "negative": "", "seed": 3,
                       "init_image": "aw_test_sheet.png", "loras": [{"name": "style.safetensors", "strength": 0.8}],
                       "sheet": {"req": "把上衣改成黑色", "ref": null}});
        let (n, info) = build(&p, &dir, 0).unwrap();
        let all = |n: &Map<String, Value>, c: &str| n.values().filter(|v| v["class_type"] == c).cloned().collect::<Vec<_>>();
        assert_eq!(all(&n, "UNETLoader")[0]["inputs"]["unet_name"], STRIP_QWEN);
        assert!(all(&n, "LoraLoaderModelOnly").is_empty());  // Anima 的 LoRA 不套到 Qwen
        let te = &all(&n, "TextEncodeQwenImage21")[0]["inputs"];
        let pr = te["prompt"].as_str().unwrap();
        assert!(pr.starts_with("【本次修改要求】\n把上衣改成黑色") && pr.contains("四视图排版") && !pr.contains("【有图2时】"));
        assert!(te.get("images.image_1").is_some() && te.get("images.image_2").is_none());
        assert_eq!(all(&n, "ManualSigmas").len(), 1);  // 官方 Turbo 8 步
        assert_eq!(info["mode"], "sheet");
        assert_eq!(info["family"], "qwen21");
        let (w, h) = (info["width"].as_i64().unwrap(), info["height"].as_i64().unwrap());
        assert!(w % 32 == 0 && h % 32 == 0 && w > h, "{w}x{h}");
        // 有服裝參考：第二張圖、加「有图2时」那段
        let mut p2 = p.clone();
        p2["sheet"]["ref"] = json!("aw_test_sheet_cloth.png");
        let (n2, _) = build(&p2, &dir, 0).unwrap();
        let te2 = &all(&n2, "TextEncodeQwenImage21")[0]["inputs"];
        assert!(te2.get("images.image_2").is_some() && te2["prompt"].as_str().unwrap().contains("【有图2时】"));
        // 沒寫要求要擋
        let mut p3 = p.clone();
        p3["sheet"]["req"] = json!("  ");
        assert!(build(&p3, &dir, 0).unwrap_err().0.contains("修改要求"));
        let _ = std::fs::remove_file(sheet);
        let _ = std::fs::remove_file(cloth);
    }

    #[test]
    fn video_graph_text_and_image() {
        let dir = std::env::temp_dir();
        // 文生影片：5 秒 → 121 格（8n+1），兩段都要 32 的倍數，有封面
        let (n, info) = build(&json!({"mode": "video", "prompt": "a cat blinks", "seed": 7, "video_seconds": 5, "poster": "abc"}), &dir, 0).unwrap();
        let cls: Vec<&str> = n
            .values()
            .map(|v| v["class_type"].as_str().unwrap())
            .collect();
        for c in [
            "CheckpointLoaderSimple",
            "LTXAVTextEncoderLoader",
            "SaveVideo",
            "ImageFromBatch",
            "LTXVLatentUpsampler",
        ] {
            assert!(cls.contains(&c), "少了 {c}");
        }
        assert!(!cls.contains(&"LoadImage"));
        assert_eq!(info["frames"], 121);
        let (w, h) = (
            info["width"].as_i64().unwrap(),
            info["height"].as_i64().unwrap(),
        );
        assert!(w % 64 == 0 && h % 64 == 0 && w > h, "{w}x{h}");
        let save = n.values().find(|v| v["class_type"] == "SaveImage").unwrap();
        assert_eq!(save["inputs"]["filename_prefix"], "AnimaWeb/_poster/abc");
        // 沒寫提示詞要擋
        assert!(build(&json!({"mode": "video", "prompt": " "}), &dir, 0).is_err());
        // 圖生影片：直式圖 → 直式影片，兩次 LTXVImgToVideoInplace
        let img = dir.join("aw_test_video_src.png");
        image::RgbImage::new(768, 1344).save(&img).unwrap();
        let (n, info) = build(&json!({"mode": "video", "prompt": "she smiles", "init_image": "aw_test_video_src.png", "video_res": "480p"}), &dir, 0).unwrap();
        let k = n
            .values()
            .filter(|v| v["class_type"] == "LTXVImgToVideoInplace")
            .count();
        assert_eq!(k, 2);
        assert!(info["height"].as_i64().unwrap() > info["width"].as_i64().unwrap());
        // 預覽：沒有第二段（放大器、第二個取樣器），尺寸是一半
        let (n, info2) = build(&json!({"mode": "video", "prompt": "she smiles", "init_image": "aw_test_video_src.png", "video_res": "480p", "video_preview": true}), &dir, 0).unwrap();
        assert_eq!(
            n.values()
                .filter(|v| v["class_type"] == "SamplerCustomAdvanced")
                .count(),
            1
        );
        assert!(!n.values().any(|v| v["class_type"] == "LTXVLatentUpsampler"));
        assert_eq!(
            info2["width"].as_i64().unwrap() * 2,
            info["width"].as_i64().unwrap()
        );
        let _ = std::fs::remove_file(img);
    }

    #[test]
    fn video_graph_loras() {
        let dir = std::env::temp_dir();
        // 影片 LoRA 接在 checkpoint 後面串起來，兩段取樣用同一個 guider（都吃到 LoRA）；強度沒給是 1
        let (n, info) = build(&json!({"mode": "video", "prompt": "a cat blinks", "seed": 7,
            "video_loras": [{"name": "ltx\\camera_dolly.safetensors", "strength": 0.8}, {"name": "motion.safetensors"}]}), &dir, 0).unwrap();
        let ls: Vec<&Value> = n.values().filter(|v| v["class_type"] == "LoraLoaderModelOnly").collect();
        assert_eq!(ls.len(), 2);
        let ck = n.iter().find(|(_, v)| v["class_type"] == "CheckpointLoaderSimple").map(|(k, _)| k.clone()).unwrap();
        let first = ls.iter().find(|v| v["inputs"]["lora_name"] == "ltx\\camera_dolly.safetensors").unwrap();
        assert_eq!(first["inputs"]["model"], json!([ck, 0]));
        assert_eq!(first["inputs"]["strength_model"], 0.8);
        let second = ls.iter().find(|v| v["inputs"]["lora_name"] == "motion.safetensors").unwrap();
        assert_eq!(second["inputs"]["strength_model"], 1.0);
        let second_id = n.iter().find(|(_, v)| v["inputs"]["lora_name"] == "motion.safetensors").map(|(k, _)| k.clone()).unwrap();
        let guider = n.values().find(|v| v["class_type"] == "LTXVDualCFGGuider").unwrap();
        assert_eq!(guider["inputs"]["model"], json!([second_id, 0]));
        assert_eq!(info["video_loras"].as_array().unwrap().len(), 2);
        // 沒有 LoRA：guider 直接接 checkpoint，也沒有 LoraLoader
        let (n, info) = build(&json!({"mode": "video", "prompt": "a cat blinks"}), &dir, 0).unwrap();
        assert!(!n.values().any(|v| v["class_type"] == "LoraLoaderModelOnly"));
        let guider = n.values().find(|v| v["class_type"] == "LTXVDualCFGGuider").unwrap();
        assert_eq!(n[guider["inputs"]["model"][0].as_str().unwrap()]["class_type"], "CheckpointLoaderSimple");
        assert!(info.get("video_loras").is_none());
    }

    #[test]
    fn video_graph_official_sampling() {
        // 2026-10-25 起照 LTX-2.3 官方兩段式：第一段 euler_cfg_pp＋8 步，第二段 euler_ancestral_cfg_pp 從 0.85 起
        let (n, _) = build(&json!({"mode": "video", "prompt": "a cat blinks", "seed": 7}), &std::env::temp_dir(), 0).unwrap();
        let runs: Vec<&Value> = n.values().filter(|v| v["class_type"] == "SamplerCustomAdvanced").collect();
        assert_eq!(runs.len(), 2);
        let mut got: Vec<(String, String)> = runs
            .iter()
            .map(|r| {
                let at = |slot: &str| &n[r["inputs"][slot][0].as_str().unwrap()]["inputs"];
                (at("sampler")["sampler_name"].as_str().unwrap().to_string(), at("sigmas")["sigmas"].as_str().unwrap().to_string())
            })
            .collect();
        got.sort();
        assert_eq!(got, vec![
            ("euler_ancestral_cfg_pp".to_string(), "0.85, 0.7250, 0.4219, 0.0".to_string()),
            ("euler_cfg_pp".to_string(), "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0".to_string()),
        ]);
    }

    /// 測試用的輸入資料夾：一張 w×h 的圖＋（可選）幾張遮罩（白色矩形）
    fn play_dir(tag: &str, w: u32, h: u32, rects: &[(u32, u32, u32, u32)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aw_test_{tag}"));
        std::fs::create_dir_all(&dir).unwrap();
        image::RgbImage::new(w, h).save(dir.join("in.png")).unwrap();
        for (k, r) in rects.iter().enumerate() {
            let mut m = image::GrayImage::new(w, h);
            for y in r.1..r.3 {
                for x in r.0..r.2 {
                    m.put_pixel(x, y, image::Luma([255]));
                }
            }
            m.save(dir.join(format!("m{k}.png"))).unwrap();
        }
        dir
    }

    fn by_class(n: &Map<String, Value>, c: &str) -> Vec<Value> {
        n.values().filter(|v| v["class_type"] == c).cloned().collect()
    }

    #[test]
    fn pose_control_graph() {
        let dir = std::env::temp_dir();
        let p = json!({"mode": "txt2img", "family": "anima", "model": "anima-turbo-v1.1.safetensors", "prompt": "1girl", "negative": "",
                       "seed": 1, "width": 832, "height": 1216, "steps": 8, "cfg": 1, "sampler": "euler", "scheduler": "simple",
                       "control": {"enabled": true, "type": "pose", "preprocess": "none", "image": "skel.png", "strength": 1.0, "end": 0.8}});
        let (n, _) = build(&p, &dir, 0).unwrap();
        let ll = &by_class(&n, "AnimaLLLiteApply")[0]["inputs"];
        let patch = &n[ll["model_patch"][0].as_str().unwrap()];
        assert_eq!(patch["inputs"]["name"], "anima-lllite-pose-1.safetensors");
        assert_eq!(ll["end_percent"], 0.8);
        // 自己畫好的骨架圖：直接用，不抽
        assert!(by_class(&n, "SDPoseKeypointExtractor").is_empty());
        // 從照片抽骨架：SAM3 框人 → SDPose 抽點 → 畫成骨架圖，再接 LLLite
        let mut q = p.clone();
        q["control"]["preprocess"] = json!("pose");
        let (n, _) = build(&q, &dir, 0).unwrap();
        let ex = &by_class(&n, "SDPoseKeypointExtractor")[0]["inputs"];
        assert_eq!(n[ex["model"][0].as_str().unwrap()]["inputs"]["ckpt_name"], SDPOSE_CKPT);
        assert_eq!(ex["vae"][1], 2);
        let det = &n[ex["bboxes"][0].as_str().unwrap()];
        assert_eq!((det["class_type"].as_str(), ex["bboxes"][1].as_i64()), (Some("SAM3_Detect"), Some(1)));
        let draw = by_class(&n, "SDPoseDrawKeypoints");
        assert_eq!(draw.len(), 1);
        // 控制圖縮成畫面大小後才進 LLLite
        let ll = &by_class(&n, "AnimaLLLiteApply")[0]["inputs"];
        let scaled = &n[ll["image"][0].as_str().unwrap()];
        assert_ne!(scaled["class_type"], "SDPoseDrawKeypoints");
        // 疊兩張（陣列）：深度＋骨架各一個 LLLite，照順序接
        let mut two = p.clone();
        two["control"] = json!([{"enabled": true, "type": "depth", "preprocess": "none", "image": "d.png", "strength": 0.8, "end": 0.6},
                                {"enabled": true, "type": "pose", "preprocess": "none", "image": "skel.png"}]);
        let (n, _) = build(&two, &dir, 0).unwrap();
        let names: Vec<String> = by_class(&n, "ModelPatchLoader").iter().map(|v| v["inputs"]["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"anima-lllite-depth-1.safetensors".into()) && names.contains(&"anima-lllite-pose-1.safetensors".into()));
        assert_eq!(by_class(&n, "AnimaLLLiteApply").len(), 2);
        // 體位庫的姿勢參考圖：Anima 也吃（深度 0.8／前 60%，骨架 1.0）
        let mut pc = p.clone();
        pc["control"] = Value::Null;
        pc["pose_control"] = json!({"depth": "cowgirl_depth.png", "pose": "cowgirl_pose.png"});
        let (n, _) = build(&pc, &dir, 0).unwrap();
        let ll = by_class(&n, "AnimaLLLiteApply");
        assert_eq!(ll.len(), 2);
        let depth = ll.iter().find(|v| n[v["inputs"]["model_patch"][0].as_str().unwrap()]["inputs"]["name"] == "anima-lllite-depth-1.safetensors").unwrap();
        assert_eq!((depth["inputs"]["strength"].as_f64(), depth["inputs"]["end_percent"].as_f64()), (Some(0.8), Some(0.6)));
        assert!(by_class(&n, "LoadImage").iter().any(|v| v["inputs"]["image"] == format!("{POSE_INPUT}/cowgirl_pose.png")));
        // Qwen 2.1／MOSS 沒有 LLLite：控制整段不進圖
        let mut m = q.clone();
        m["family"] = json!("moss");
        m["model"] = json!("moss_image_sft_int8_convrot.safetensors");
        let (n, _) = build(&m, &dir, 0).unwrap();
        assert!(by_class(&n, "SDPoseKeypointExtractor").is_empty() && by_class(&n, "AnimaLLLiteApply").is_empty());
    }

    #[test]
    fn outpaint_graph() {
        let dir = play_dir("outpaint", 640, 480, &[]);
        let base = json!({"mode": "outpaint", "family": "anima", "model": "anima-turbo-v1.1.safetensors", "prompt": "a beach", "negative": "",
                          "seed": 3, "steps": 8, "cfg": 1, "sampler": "euler", "scheduler": "simple", "init_image": "in.png",
                          "outpaint": {"left": 100, "right": 0, "top": 0, "bottom": 64}, "inpaint": {"method": "lllite"}});
        let (n, info) = build(&base, &dir, 0).unwrap();
        let pad = &by_class(&n, "ImagePadForOutpaint")[0]["inputs"];
        // 100 → 104（8 的倍數往上取）
        assert_eq!((pad["left"].as_i64(), pad["bottom"].as_i64(), pad["feathering"].as_i64()), (Some(104), Some(64), Some(40)));
        assert_eq!((info["width"].as_i64(), info["height"].as_i64()), (Some(744), Some(544)));
        assert!(by_class(&n, "LoadImageMask").is_empty(), "擴圖不用遮罩檔");
        assert!(by_class(&n, "ImageCrop").is_empty(), "擴圖整張重畫");
        assert_eq!(by_class(&n, "KSampler")[0]["inputs"]["denoise"], 1.0);
        assert_eq!(info["prompt"], "a beach");
        // 遮罩接 ImagePadForOutpaint 的第 2 個輸出
        let comp = &by_class(&n, "ImageCompositeMasked")[0]["inputs"];
        assert_eq!(comp["destination"][1], 0);
        // 沒選邊：報錯
        let mut none = base.clone();
        none["outpaint"] = json!({});
        assert!(build(&none, &dir, 0).is_err());
        // Qwen 2.1：節點圖補延伸場景的句子，圖庫記的提示詞不變
        let mut q = base.clone();
        q["family"] = json!("qwen21");
        let (n, info) = build(&q, &dir, 0).unwrap();
        let te = by_class(&n, "TextEncodeQwenImage21");
        assert!(te[0]["inputs"]["prompt"].as_str().unwrap().starts_with(OUTPAINT_HINT));
        assert_eq!(info["prompt"], "a beach");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn detail_graph() {
        let dir = play_dir("detail", 1024, 1024, &[(400, 200, 500, 320), (100, 800, 140, 860), (0, 0, 0, 0)]);
        let p = json!({"mode": "detail", "family": "anima", "model": "anima-turbo-v1.1.safetensors", "prompt": "1girl", "negative": "",
                       "seed": 9, "steps": 8, "cfg": 1, "sampler": "euler", "scheduler": "simple", "init_image": "in.png",
                       "detail": {"masks": ["m0.png", "m1.png", "m2.png"], "extra": "detailed face"}});
        let (n, info) = build(&p, &dir, 0).unwrap();
        // 空遮罩那張跳過：兩段
        let ks = by_class(&n, "KSampler");
        assert_eq!(ks.len(), 2);
        assert_eq!(ks[0]["inputs"]["denoise"], 0.4);
        assert_ne!(ks[0]["inputs"]["seed"], ks[1]["inputs"]["seed"]);
        assert_eq!(by_class(&n, "UNETLoader").len(), 1, "共用一組模型");
        assert_eq!(by_class(&n, "CLIPTextEncode")[0]["inputs"]["text"], "1girl, detailed face");
        // 第一塊：外框 100×120，四周留 max(24, 120/3=40)
        let crop = &by_class(&n, "ImageCrop")[0]["inputs"];
        assert_eq!((crop["x"].as_i64(), crop["y"].as_i64(), crop["width"].as_i64(), crop["height"].as_i64()), (Some(360), Some(160), Some(180), Some(200)));
        // 第二段貼在第一段的結果上
        let comps = by_class(&n, "ImageCompositeMasked");
        assert_eq!(comps.len(), 2);
        let last = by_class(&n, "SaveImage")[0]["inputs"]["images"][0].as_str().unwrap().to_string();
        assert_eq!(n[&last]["class_type"], "ImageCompositeMasked");
        let prev = n[&last]["inputs"]["destination"][0].as_str().unwrap().to_string();
        assert_eq!(n[&prev]["class_type"], "ImageCompositeMasked");
        assert_eq!((info["width"].as_i64(), info["height"].as_i64()), (Some(1024), Some(1024)));
        let mut empty = p.clone();
        empty["detail"]["masks"] = json!([]);
        assert!(build(&empty, &dir, 0).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rembg_diff_detect_graphs() {
        let dir = play_dir("rembg", 512, 768, &[]);
        let p = json!({"mode": "rembg", "family": "anima", "model": "x.safetensors", "prompt": "", "negative": "", "seed": 1, "init_image": "in.png"});
        let (n, info) = build(&p, &dir, 0).unwrap();
        assert_eq!(by_class(&n, "LoadBackgroundRemovalModel")[0]["inputs"]["bg_removal_name"], BG_MODEL);
        assert_eq!(by_class(&n, "JoinImageWithAlpha").len(), 1);
        assert!(by_class(&n, "UNETLoader").is_empty() && by_class(&n, "KSampler").is_empty());
        assert_eq!((info["width"].as_i64(), info["height"].as_i64()), (Some(512), Some(768)));

        let d = json!({"mode": "diff", "family": "anima", "model": "anima-turbo-v1.1.safetensors", "prompt": "", "negative": "", "seed": 1,
                       "init_image": "in.png", "diff": {"req": "把表情改成开心的大笑"}});
        let (n, info) = build(&d, &dir, 0).unwrap();
        assert_eq!(by_class(&n, "UNETLoader")[0]["inputs"]["unet_name"], STRIP_QWEN);
        let te = by_class(&n, "TextEncodeQwenImage21");
        assert!(te[0]["inputs"]["prompt"].as_str().unwrap().contains("开心的大笑") && te[0]["inputs"]["prompt"].as_str().unwrap().contains("保持要求"));
        assert_eq!(info["family"], "qwen21");
        let mut e = d.clone();
        e["diff"] = json!({"req": "  "});
        assert!(build(&e, &dir, 0).is_err());

        let g = detect_graph("in.png", &["face", "hand"], 0.5);
        let det = g.values().find(|v| v["class_type"] == "SAM3_Detect").unwrap();
        assert_eq!(det["inputs"]["individual_masks"], true);
        assert_eq!(g.values().filter(|v| v["class_type"] == "PreviewImage").count(), 2);
        assert_eq!(g.values().filter(|v| v["class_type"] == "CheckpointLoaderSimple").count(), 1);
        assert!(!g.values().any(|v| v["class_type"] == "SaveImage"), "偵測結果不能進 output");
        let mut m = image::GrayImage::new(50, 40);
        assert_eq!(bbox_of(&m), None);
        m.put_pixel(10, 5, image::Luma([255]));
        m.put_pixel(20, 30, image::Luma([200]));
        assert_eq!(bbox_of(&m), Some((10, 5, 21, 31)));
        let _ = std::fs::remove_dir_all(dir);
    }
}
