//! 導演台（2026-10-11）：長劇情 → 分段（一段＝一個鏡頭＝一支 LTX-2.3 影片）→ 每段第一格＋圖生影片 → 接成長片。
//!
//! 這裡放不碰網路的部分：給通用模型（35B／9B 去審查版）的工作說明、組請求內容、讀回 JSON、專案與角色卡的存檔。
//! 執行（叫模型、送 ComfyUI、等任務）在 server\api_director.rs。
//!
//! 存檔位置（都在資料資料夾，不動 anima.db，舊站照樣能開）：
//!   data\director\characters.json      舊版角色卡清單（第一次讀角色時搬進資產庫，之後只讀不改；搬完寫 characters.migrated）
//!   data\director\chars\<id>_src.png   舊版角色原圖／<id>_sheet.png 多視圖設定圖（同上，只讀）
//!   data\director\projects\<id>.json   專案（劇情、參數、每段的提示詞與結果）
//! 用的時候複製到 ComfyUI input（檔名加 adir_ 前綴）。
use crate::py::{now, truthy};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// JSON 值 → 文字；null／沒有＝空字串（py::str_of 會寫成 "None"）
pub fn tx(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

/// 導演台放進 ComfyUI input 的檔名前綴（角色圖、每段第一格／最後一格、要接起來的影片）。
/// 不用子資料夾：AI 改寫讀參考圖時只取檔名（pe::Service::load_images）
pub const INPUT_PREFIX: &str = "adir_";

// ================================================================ 給模型的工作說明
/// 分段：只決定段落和每段的大意，提示詞下一步一段一段寫（一次寫全部會太長、品質也掉）
pub const SYSTEM_PLAN: &str = r#"You are a film director and storyboard artist. Split the user's story into consecutive shots for an AI video model. Each shot becomes ONE continuous clip of about {seconds} seconds made by image-to-video (LTX-2.3).

Rules:
- Number of shots: {count}
- A shot is one continuous camera take with one main action that fits in {seconds} seconds. No hard cuts inside a shot.
- "continue": true when the shot picks up exactly where the previous shot ends (same place, same moment, same camera setup), so the previous clip's last frame becomes this shot's first frame. Use false for a cut to a new angle, place or time. The first shot is always false.
- "characters": names of the characters visible in the shot, spelled exactly as in the character list.
- "title": at most 8 characters, "summary": 2-3 sentences. Both in Traditional Chinese (Taiwan usage).
- Make every summary concrete. When the story is vague ("跳舞", "打鬥", "親熱", "玩耍"), decide the exact kind and the specific moves yourself (for example an idol dance: side steps with hip sways, a spin, pointing at the crowd, a jump with both arms up) and spread different moves across the shots so nothing repeats and each shot leads into the next.
- "scene": short English description of the location, time of day and lighting, so later shots stay consistent.
- Follow the story faithfully, including mature or explicit content when the story has it. All characters are adults.

Output only JSON, no other text:
{"segments":[{"title":"","summary":"","characters":[],"continue":false,"scene":""}]}"#;

/// 每一段：第一格圖的提示詞＋影片提示詞（英文給模型，中文給使用者看）
pub const SYSTEM_SHOT: &str = r#"You write the prompts for ONE shot of an AI short film. The shot is one continuous {seconds}-second clip made by image-to-video (LTX-2.3): first a still image (the first frame) is made, then it is animated.

Output only JSON, no other text:
{"frame":"","frame_zh":"","video":"","video_zh":""}

"frame": the first frame. {frame_rule}
  Describe the composition and shot size, each character's look (use the given character descriptions), pose and expression, outfit, the setting, lighting and colors. Visual style: {style}.{refs_rule}{continue_rule}
"video": ONE paragraph of natural English for LTX-2.3 image-to-video, 120-200 words, following these rules:
  - Start with "Style: {video_style}, " and then go straight into the action (never "The scene opens with" / "The video starts").
  - Fill all {seconds} seconds: break the action into {beats} consecutive beats in chronological order, joined with "as", "then", "while". Use present-progressive verbs ("is spinning", "is waving"). Make every beat concrete and physical: hands, arms, legs, head turn, eyes and mouth, and how hair and clothing follow the motion. Keep it achievable in {seconds} seconds.
  - Be specific, never vague: do not write just "dances", "performs", "moves", "fights" or "plays". Name each move in order and give it a clear start and end: which hand or leg, which direction, how far, how fast (for example "she steps to the right and sways her hips twice, sweeps her right arm up over her head, then does a quick half turn to the left and points at the crowd").
  - Describe only what changes from the first frame. Do not restate static appearance; call each character by name or a short label.
  - Weave the soundscape into the actions as they happen, not at the end: specific sounds with a visible source (for example "heels tapping on the stage", "the crowd cheering"), loudness matching the action.
  - If anyone talks, sings, shouts or cheers in this shot, write the exact words in quotes, who says them and how (voice, and the language if not English). Write the words in the language they are spoken, romanized if needed (Japanese: "Minna, arigatou!", not "Thank you!" in Japanese).
  - Camera: {camera_rule} Always state, as flowing prose, the shot type (wide / medium / medium close-up / close-up), the viewpoint (front-facing, side view, low-angle…) matching the first frame, and whether the camera moves or stays static.
  - Lighting: keep the first frame's lighting{light}; mention only changes (flashing spotlights, a door letting in daylight).
  - Only what is seen and heard: show feelings as visible actions instead of naming them; no smells or touch; no timestamps; no scene cuts; mild, natural wording.
"frame_zh", "video_zh": faithful Traditional Chinese (Taiwan usage) translations for the user to read; translate every English word (keep only the quoted spoken lines as they are).

Follow the story faithfully, including mature or explicit content when the shot has it. All characters are adults; never describe anyone as a child or teenager."#;

/// 看角色圖寫外觀（給之後每段的提示詞引用）
pub const SYSTEM_DESCRIBE: &str = r#"Look at the character in the image and describe ONLY their permanent appearance so an artist can draw the same character again: apparent age group (adult), gender, body type, skin tone, face, eye color, hair color, length and style, distinctive features (ears, horns, tattoos, scars), and the outfit with colors and materials. Do not describe the pose, expression, background, lighting or art style.

Output only JSON, no other text:
{"desc":"one English paragraph, 40-80 words","desc_zh":"同樣內容的繁體中文（台灣用語）"}"#;

/// 畫風代號 → 寫給模型的英文
pub fn style_words(style: &str) -> &'static str {
    match style {
        "anime" => "anime illustration, clean line art, cel shading",
        "3d" => "high-quality 3D CG render, realistic materials, cinematic",
        _ => "photorealistic, cinematic film still, natural skin texture",
    }
}

// ================================================================ 組請求內容
fn chars_text(chars: &[Value]) -> String {
    if chars.is_empty() {
        return "(none given: invent consistent looks and keep them the same in every shot)".into();
    }
    chars
        .iter()
        .map(|c| format!("- {}: {}", tx(&c["name"]), tx(&c["desc"])))
        .collect::<Vec<_>>()
        .join("\n")
}

fn settings_text(s: &Value) -> String {
    let mut out = vec![format!("Style: {}", style_words(s["style"].as_str().unwrap_or("")))];
    let visual = tx(&s["visual"]);
    if !visual.trim().is_empty() {
        out.push(format!("Visual style notes: {}", visual.trim()));
    }
    let extra = tx(&s["extra"]);
    if !extra.trim().is_empty() {
        out.push(format!("Extra requirements: {}", extra.trim()));
    }
    out.join("\n")
}

/// 「段數」設定 → 給模型的規則（0＝自動）
pub fn count_rule(n: i64, story_chars: usize) -> String {
    if n > 0 {
        format!("exactly {n} shots")
    } else {
        // 自動：大約每 120 字一段，限制在 3～24 段
        let guess = (story_chars / 120).clamp(3, 24);
        format!("decide by the story's pacing (roughly {guess}, between 2 and 30)")
    }
}

pub fn plan_messages(p: &Value, chars: &[Value]) -> (String, String) {
    let s = &p["settings"];
    let secs = s["seconds"].as_i64().unwrap_or(5);
    let story = tx(&p["story"]);
    let sys = SYSTEM_PLAN
        .replace("{seconds}", &secs.to_string())
        .replace("{count}", &count_rule(s["segments"].as_i64().unwrap_or(0), story.chars().count()));
    let user = format!(
        "Characters:\n{}\n\n{}\n\nStory:\n{}",
        chars_text(chars),
        settings_text(s),
        story.trim()
    );
    (sys, user)
}

/// 生第一格用的是不是 Anima（寫 tag）；Qwen 2.1、MOSS-Image 寫英文段落
pub fn frame_rule(anima: bool) -> &'static str {
    if anima {
        "Write Danbooru-style tags separated by commas (start with: masterpiece, best quality), then one or two English sentences."
    } else {
        "Write one detailed English paragraph (80-150 words)."
    }
}

/// 一段的提示詞請求。refs＝這段會當參考圖的角色（照順序是 <image1>、<image2>…）
pub fn shot_messages(p: &Value, idx: usize, chars: &[Value], anima: bool, refs: &[String]) -> (String, String) {
    let s = &p["settings"];
    let secs = s["seconds"].as_i64().unwrap_or(5);
    let segs = p["segments"].as_array().cloned().unwrap_or_default();
    let seg = segs.get(idx).cloned().unwrap_or(Value::Null);
    let list = |k: &str| -> String {
        s[k].as_array()
            .map(|a| a.iter().map(tx).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default()
    };
    let (camera, light) = (list("camera"), list("light"));
    let refs_rule = if refs.is_empty() {
        String::new()
    } else {
        let names: Vec<String> = refs.iter().enumerate().map(|(i, n)| format!("<image{}> = {n}", i + 1)).collect();
        format!("\n  Reference images are given for some characters ({}). Mention each of them in \"frame\" with its tag, for example \"the woman from <image1>\". Never use these tags in \"video\" or \"video_zh\": there, call them by name.", names.join(", "))
    };
    let continue_rule = if truthy(seg.get("continue")) && idx > 0 {
        "\n  This shot continues directly from the previous clip's last frame, which is reused as the first frame: keep \"frame\" short (one sentence) or empty."
    } else {
        ""
    };
    // 官方 i2v 提示詞強化器：沒指定就不要自己加運鏡
    let camera_rule = if camera.is_empty() {
        "keep the camera static unless the story asks for a movement; do not invent camera moves.".to_string()
    } else {
        format!("use this camera movement: {camera}.")
    };
    let beats = match secs {
        ..=3 => "2-3",
        4..=6 => "3-4",
        _ => "5-6",
    };
    let style = s["style"].as_str().unwrap_or("");
    let video_style = match style {
        "anime" => "anime, 2D cel-shaded animation",
        "3d" => "3D CG animation",
        _ => "realistic, cinematic",
    };
    let sys = SYSTEM_SHOT
        .replace("{video_style}", video_style)
        .replace("{beats}", beats)
        .replace("{camera_rule}", &camera_rule)
        .replace("{seconds}", &secs.to_string())
        .replace("{frame_rule}", frame_rule(anima))
        .replace("{style}", style_words(s["style"].as_str().unwrap_or("")))
        .replace("{refs_rule}", &refs_rule)
        .replace("{continue_rule}", continue_rule)
        .replace("{light}", &if light.is_empty() { String::new() } else { format!(" (preferred: {light})") });
    let line = |k: usize| -> String {
        let g = &segs[k];
        format!("Shot {}: {} — {} [scene: {}]", k + 1, tx(&g["title"]), tx(&g["summary"]), tx(&g["scene"]))
    };
    let mut ctx = vec![];
    if idx > 0 {
        ctx.push(format!("Previous shot: {}", line(idx - 1)));
        let pv = tx(&segs[idx - 1]["video"]);
        if !pv.is_empty() {
            ctx.push(format!("Previous shot's video prompt: {pv}"));
        }
    }
    ctx.push(format!("THIS SHOT: {}", line(idx)));
    if idx + 1 < segs.len() {
        ctx.push(format!("Next shot: {}", line(idx + 1)));
    }
    let present = seg["characters"].as_array().map(|a| a.iter().map(tx).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let user = format!(
        "Characters:\n{}\nVisible in this shot: {}\n\n{}\n\nStory (for context):\n{}\n\n{}",
        chars_text(chars),
        if present.is_empty() { "(see story)".into() } else { present },
        settings_text(s),
        tx(&p["story"]).trim(),
        ctx.join("\n")
    );
    (sys, user)
}

/// MOSS 第一格的版面框（使用者在段落卡片上拉的，格式同 params.layout）→ 接在寫提示詞請求後面的說明。
/// 框本身另外交給 MOSS（graphs.rs 的 Layout），這裡只讓 "frame" 寫得跟框一致。沒有能用的框回空字串
pub fn layout_rule(seg: &Value) -> String {
    let lines: Vec<String> = seg["layout"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| {
            let v: Vec<f64> = b["box"].as_array()?.iter().map(|x| x.as_f64().unwrap_or(0.0).clamp(0.0, 1.0)).collect();
            if v.len() != 4 {
                return None;
            }
            let kind = match b["type"].as_str() {
                Some("character") => "character",
                Some("text") => "text",
                _ => "object",
            };
            let (desc, text) = (tx(&b["desc"]).trim().to_string(), tx(&b["text"]).trim().to_string());
            if desc.is_empty() && (kind != "text" || text.is_empty()) {
                return None;
            }
            let (x0, x1, y0, y1) = (v[0].min(v[2]), v[0].max(v[2]), v[1].min(v[3]), v[1].max(v[3]));
            let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
            let third = |c: f64, lo: &'static str, mid: &'static str, hi: &'static str| if c < 1.0 / 3.0 { lo } else if c > 2.0 / 3.0 { hi } else { mid };
            let pos = match (third(cy, "upper", "middle", "lower"), third(cx, "left", "center", "right")) {
                ("middle", "center") => "center".to_string(),
                (v, h) => format!("{v} {h}"),
            };
            let what = match (kind, desc.is_empty()) {
                ("text", true) => format!("the exact text \"{text}\""),
                ("text", false) => format!("the exact text \"{text}\" ({desc})"),
                _ => desc,
            };
            Some((pos, ((x1 - x0) * 100.0).round(), ((y1 - y0) * 100.0).round(), kind, what))
        })
        .enumerate()
        .map(|(i, (pos, w, h, kind, what))| format!("  Box {} ({pos}, about {w}% of the frame width and {h}% of its height) {kind}: {what}", i + 1))
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\nFirst-frame layout: the user placed these boxes on the frame. The image model gets them separately, each with its own description:\n{}\nWrite \"frame\" so it agrees with this layout: describe the whole scene (setting, mood, lighting, style) and put each boxed subject where its box is. Never mention boxes, frames, borders or panels.",
        lines.join("\n")
    )
}

// ================================================================ 讀回模型輸出
/// 從文字裡第一個 { 讀一個 JSON 物件；後面多出來的字（9B 偶爾多打一個 }）不管
pub fn json_in(text: &str) -> Option<Map<String, Value>> {
    let raw = &text[text.find('{')?..];
    let first = |s: &str| match serde_json::Deserializer::from_str(s).into_iter::<Value>().next() {
        Some(Ok(Value::Object(m))) => Some(m),
        _ => None,
    };
    // 模型常在字串裡直接換行（JSON 不允許）：字串裡的控制字元改成跳脫再讀一次
    first(raw).or_else(|| first(&escape_controls(raw)))
}

/// 只動 JSON 字串裡面的換行、tab 等控制字元
fn escape_controls(s: &str) -> String {
    let (mut out, mut in_str, mut esc) = (String::with_capacity(s.len()), false, false);
    for c in s.chars() {
        if in_str && !esc && (c as u32) < 0x20 {
            match c {
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                _ => out.push_str(&format!("\\u{:04x}", c as u32)),
            }
            continue;
        }
        if esc {
            esc = false;
        } else if c == '\\' && in_str {
            esc = true;
        } else if c == '"' {
            in_str = !in_str;
        }
        out.push(c);
    }
    out
}

/// 分段結果 → 段落清單（補齊欄位、第一段一律不接上一段）
pub fn parse_plan(text: &str) -> Option<Vec<Value>> {
    let m = json_in(text)?;
    let segs = m.get("segments")?.as_array()?;
    let out: Vec<Value> = segs
        .iter()
        .enumerate()
        .filter_map(|(i, g)| {
            let title = tx(g.get("title")?);
            let summary = tx(g.get("summary").unwrap_or(&Value::Null));
            if title.trim().is_empty() && summary.trim().is_empty() {
                return None;
            }
            let chars: Vec<Value> = match g.get("characters") {
                Some(Value::Array(a)) => a.iter().map(|c| json!(tx(c))).collect(),
                Some(Value::String(s)) => s.split([',', '、']).map(|c| json!(c.trim())).filter(|c| c != "").collect(),
                _ => vec![],
            };
            Some(json!({
                "title": title.trim(), "summary": summary.trim(), "characters": chars,
                "continue": i > 0 && truthy(g.get("continue")), "scene": tx(g.get("scene").unwrap_or(&Value::Null)).trim(),
                "frame": "", "frame_zh": "", "video": "", "video_zh": "",
            }))
        })
        .collect();
    (!out.is_empty()).then_some(out)
}

/// 一段的提示詞 → {frame, frame_zh, video, video_zh}；影片提示詞是空的就算失敗
pub fn parse_shot(text: &str) -> Option<Map<String, Value>> {
    let m = json_in(text)?;
    let g = |k: &str| m.get(k).map(tx).unwrap_or_default().trim().to_string();
    let video = g("video");
    if video.is_empty() {
        return None;
    }
    let mut out = Map::new();
    for (k, v) in [("frame", g("frame")), ("frame_zh", g("frame_zh")), ("video", strip_refs(&video)), ("video_zh", strip_refs(&g("video_zh")))] {
        out.insert(k.into(), json!(v));
    }
    Some(out)
}

/// 影片提示詞拿掉 <image1> 這類參考圖標記（只有 Qwen 多圖參考看得懂，LTX 會當成雜訊）
pub fn strip_refs(text: &str) -> String {
    static REF: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\s*(?:\b(?:from|in|of)\s+)?<image\d+>\s*(?:的|中的|裡的)?|來自\s*<image\d+>\s*的?").unwrap());
    REF.replace_all(text, " ").split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ").replace(" ,", ",").replace(" .", ".")
}

/// 成人內容：girl／boy 一律換成 woman／man（跟成人（體位）改寫同一套）；Anima 的 tag 另外拿掉小孩樣的 tag
pub fn safe_text(text: &str, anima_tags: bool) -> String {
    if !crate::poses::looks_sexual(text) {
        return text.to_string();
    }
    let t = crate::poses::adultify(text);
    if anima_tags {
        crate::poses::safe_anima(&t, "")
    } else {
        t
    }
}

// ================================================================ 存檔
pub struct Store {
    pub dir: PathBuf,
}

/// 編號只收英數、底線、減號（擋路徑）
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn new_id() -> String {
    format!("{}{:04x}", chrono::Local::now().format("%Y%m%d%H%M%S"), rand::random_range(0..0x10000u32))
}

/// 先寫暫存檔再改名，寫到一半當掉也不會留下壞檔
pub fn write_atomic(path: &Path, v: &Value) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v)?)?;
    std::fs::rename(&tmp, path)
}

impl Store {
    pub fn new(data: &Path) -> Store {
        Store { dir: data.join("director") }
    }
    pub fn chars_dir(&self) -> PathBuf {
        self.dir.join("chars")
    }
    /// 舊版的角色卡清單：現在角色存在資產庫（kind=char），這個檔只在第一次讀角色時搬家用，只讀不改
    pub fn legacy_chars_file(&self) -> PathBuf {
        self.dir.join("characters.json")
    }
    /// 搬完家寫的標記檔（內容是搬家時間）
    pub fn chars_marker(&self) -> PathBuf {
        self.dir.join("characters.migrated")
    }
    fn project_file(&self, id: &str) -> PathBuf {
        self.dir.join("projects").join(format!("{id}.json"))
    }

    pub fn legacy_chars(&self) -> std::io::Result<Vec<Value>> {
        let bytes = std::fs::read(self.legacy_chars_file())?;
        serde_json::from_slice(&bytes).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    pub fn projects(&self) -> Vec<Value> {
        let mut out: Vec<Value> = std::fs::read_dir(self.dir.join("projects"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| serde_json::from_slice::<Value>(&std::fs::read(e.path()).ok()?).ok())
            .map(|p| {
                let segs = p["segments"].as_array().map(|a| a.len()).unwrap_or(0);
                json!({"id": p["id"], "title": p["title"], "updated": p["updated"], "segments": segs})
            })
            .collect();
        out.sort_by(|a, b| b["updated"].as_f64().unwrap_or(0.0).total_cmp(&a["updated"].as_f64().unwrap_or(0.0)));
        out
    }
    pub fn project(&self, id: &str) -> Option<Value> {
        if !valid_id(id) {
            return None;
        }
        serde_json::from_slice(&std::fs::read(self.project_file(id)).ok()?).ok()
    }
    pub fn save_project(&self, p: &mut Value) -> std::io::Result<()> {
        let id = tx(&p["id"]);
        if !valid_id(&id) {
            return Err(std::io::Error::other("專案編號不對"));
        }
        p["updated"] = json!(now());
        write_atomic(&self.project_file(&id), p)
    }
    /// 不真的刪：搬到 data\待刪除\導演台\
    pub fn trash_project(&self, id: &str, trash: &Path) -> std::io::Result<()> {
        if !valid_id(id) {
            return Err(std::io::Error::other("專案編號不對"));
        }
        let to = trash.join("導演台");
        std::fs::create_dir_all(&to)?;
        std::fs::rename(self.project_file(id), to.join(format!("{id}_{}.json", chrono::Local::now().format("%Y%m%d_%H%M%S"))))
    }
}

/// 新專案的預設值
pub fn blank_project(title: &str) -> Value {
    json!({
        "id": new_id(), "title": if title.trim().is_empty() { "未命名" } else { title.trim() }, "story": "", "created": now(), "updated": now(),
        "settings": {"segments": 0, "seconds": 5, "res": "720p", "style": "anime", "visual": "", "camera": [], "light": [], "extra": "",
                     "characters": [], "image": null},
        "segments": [], "final": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_in_tolerates_raw_newlines_in_strings() {
        let m = json_in("{\"a\":\"第一行\n第二行\\n\",\"b\":\"x\ty\"}\n").unwrap();
        assert_eq!(m["a"], json!("第一行\n第二行\n"));
        assert_eq!(m["b"], json!("x\ty"));
        // 字串外的換行本來就合法；真的壞掉的還是讀不了
        assert!(json_in("{\n\"a\": 1\n}").is_some());
        assert!(json_in("{\"a\": \"沒關\n}").is_none());
        // 結尾多一個 }、後面還有閒聊
        assert_eq!(json_in("好的：{\"a\":{\"b\":1},\"c\":\"x\"}}\n以上").unwrap()["c"], json!("x"));
    }

    #[test]
    fn plan_parses_and_fixes_first_continue() {
        let t = "好的\n```json\n{\"segments\":[{\"title\":\"相遇\",\"summary\":\"兩人相遇\",\"characters\":\"艾拉、凱\",\"continue\":true,\"scene\":\"forest\"},\
                 {\"title\":\"\",\"summary\":\"\"},{\"title\":\"對話\",\"summary\":\"交談\",\"characters\":[\"艾拉\"],\"continue\":true}]}\n```";
        let p = parse_plan(t).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0]["continue"], json!(false));
        assert_eq!(p[0]["characters"], json!(["艾拉", "凱"]));
        assert_eq!(p[1]["continue"], json!(true));
        assert!(parse_plan("沒有 JSON").is_none());
    }

    #[test]
    fn shot_needs_video() {
        assert!(parse_shot("{\"frame\":\"a\",\"video\":\"\"}").is_none());
        assert_eq!(strip_refs("The camera holds as Hoshino from <image1> winks, then <image2> waves."), "The camera holds as Hoshino winks, then waves.");
        assert_eq!(strip_refs("來自 <image1> 的星乃眨眼"), "星乃眨眼");
        let s = parse_shot("{\"frame\":\"a\",\"video\":\"b\",\"video_zh\":\"乙\"}").unwrap();
        assert_eq!(s["video"], json!("b"));
        assert_eq!(s["frame_zh"], json!(""));
    }

    #[test]
    fn shot_messages_mention_refs_and_continue() {
        let mut p = blank_project("t");
        p["story"] = json!("故事");
        p["settings"]["camera"] = json!(["slow push-in"]);
        p["segments"] = json!([{"title": "一", "summary": "a", "scene": "s", "video": "prev video"},
                               {"title": "二", "summary": "b", "scene": "s", "continue": true}]);
        let (sys, user) = shot_messages(&p, 1, &[], false, &["艾拉".into()]);
        assert!(sys.contains("<image1> = 艾拉"));
        assert!(sys.contains("continues directly"));
        assert!(sys.contains("slow push-in"));
        assert!(!sys.contains("{seconds}") && !sys.contains("{refs_rule}") && !sys.contains("{camera_rule}") && !sys.contains("{beats}") && !sys.contains("{video_style}"));
        assert!(user.contains("prev video"));
        assert!(user.contains("THIS SHOT: Shot 2"));
    }

    #[test]
    fn layout_rule_describes_boxes() {
        let seg = json!({"layout": [
            {"type": "character", "desc": "女人", "box": [0.33, 0.15, 0.66, 0.85]},
            {"type": "object", "desc": "", "box": [0.1, 0.1, 0.2, 0.2]},
            {"type": "text", "desc": "", "text": "OPEN", "box": [0.7, 0.05, 0.95, 0.2]},
            {"type": "object", "desc": "a lamp", "box": [0.05, 0.7, 0.25, 0.95]}]});
        let r = layout_rule(&seg);
        assert!(r.contains("Box 1 (center, about 33% of the frame width and 70% of its height) character: 女人"), "{r}");
        assert!(r.contains("Box 2 (upper right, about 25% of the frame width and 15% of its height) text: the exact text \"OPEN\""), "{r}");
        assert!(r.contains("Box 3 (lower left") && r.contains("object: a lamp"), "{r}");
        assert!(!r.contains("Box 4"), "沒描述的框不算");
        assert!(r.contains("Never mention boxes"));
        assert_eq!(layout_rule(&json!({})), "");
        assert_eq!(layout_rule(&json!({"layout": [{"type": "object", "desc": " ", "box": [0, 0, 1, 1]}]})), "");
    }

    #[test]
    fn ids_are_safe() {
        assert!(valid_id(&new_id()));
        assert!(!valid_id("../x"));
        assert!(!valid_id(""));
    }
}
