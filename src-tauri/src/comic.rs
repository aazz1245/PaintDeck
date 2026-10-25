//! 漫畫台（2026-10-16）：一整頁分格漫畫＝選版型、每格寫景別／內容／台詞／狀聲詞 → 組提示詞 → MOSS-Image 一次畫完整頁和字。
//! 2026-10-25 起可以叫本機 35B 把「這段劇情」拆成每一格（`script_messages`／`parse_script`；使用者指定用 35B），
//! 排好的東西一樣是普通欄位，可以再自己改。
//!
//! 2026-10-20 起只剩 MOSS-Image 一條路（使用者：「都只讓 MOSS 用就好」）。以前還有「Anima 畫整頁、每格留白框 → Qwen 2.1 多圖參考填字」，
//! 跟 Qwen 2.1 一次畫完兩條，都拿掉了（design\漫畫頁提示詞設計.md 有當時的五輪實測）。MOSS 2026-10-17 實測：四格、三句繁中台詞＋狀聲詞一次全對。
//! 這裡放不碰網路的部分：版型、組提示詞、作品存檔。執行在 server\api_comic.rs。
//! 作品存在 data\comic\projects\<id>.json（不動 anima.db）。舊作品檔裡的 flow／rating／tags／auto_fill 欄位留著，程式不再讀。
use crate::director::{new_id, tx, valid_id, write_atomic};
use crate::py::now;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 一種版型：(代號, 中文名, 英文版型句, [(英文格子位置, 中文格子位置)])
pub type Layout = (&'static str, &'static str, &'static str, &'static [(&'static str, &'static str)]);

/// 版型，閱讀順序右上先。
/// 版型句與格子位置的說法都實測過 Anima／Qwen 會照著分格（Anima 52 頁分對 51 頁，錯的是六格）；MOSS 照同一套句子也分對，現在只給 MOSS 用
pub const LAYOUTS: &[Layout] = &[
    ("L3", "三格：右邊直長主格＋左邊上下兩格",
     "three panels: one tall panel on the right that spans the full height of the page, and two stacked panels on the left",
     &[("tall right panel", "右邊直長那格"), ("top left panel", "左上那格"), ("bottom left panel", "左下那格")]),
    ("L4", "四格：上面兩小格＋中間大格＋右下斜切小格",
     "four panels: two small panels side by side at the top, one large panel in the middle, and a small slanted inset panel at the bottom right",
     &[("top right panel", "右上那格"), ("top left panel", "左上那格"), ("large middle panel", "中間大格"),
       ("small slanted inset panel at the bottom right", "右下斜切的小格")]),
    ("L4w", "四格：上面橫長＋中間兩格＋下面大格",
     "four panels: one wide panel across the top, two panels side by side in the middle, and one large panel across the bottom",
     &[("wide top panel", "最上面橫長那格"), ("middle right panel", "中間右邊那格"), ("middle left panel", "中間左邊那格"),
       ("large bottom panel", "最下面大格")]),
    ("L5", "五格：上面橫長＋下面兩排各兩格",
     "five panels: one wide panel across the top, then two rows of two panels side by side",
     &[("wide top panel", "最上面橫長那格"), ("middle right panel", "中間右邊那格"), ("middle left panel", "中間左邊那格"),
       ("bottom right panel", "右下那格"), ("bottom left panel", "左下那格")]),
    ("L6", "六格：三排各兩格",
     "six panels in three rows of two",
     &[("top right panel", "右上那格"), ("top left panel", "左上那格"), ("middle right panel", "中間右邊那格"),
       ("middle left panel", "中間左邊那格"), ("bottom right panel", "右下那格"), ("bottom left panel", "左下那格")]),
    ("K4", "四格漫畫：四格一樣大由上往下",
     "four horizontal panels of equal size stacked from top to bottom, like a 4koma strip",
     &[("first panel at the top", "第一格（最上面）"), ("second panel", "第二格"), ("third panel", "第三格"),
       ("fourth panel at the bottom", "第四格（最下面）")]),
];

/// 對話框位置：(英文, 中文)
pub const BUBBLES: &[(&str, &str)] = &[
    ("top left", "左上角"), ("top right", "右上角"), ("top", "上方"), ("left side", "左邊"), ("right side", "右邊"), ("bottom", "下方"),
];

/// 景別：(英文, 中文)。英文會接成「In the X panel, <景別> shows …」「The X panel shows <景別> of …」，兩種句子都要通順
pub const SHOTS: &[(&str, &str)] = &[
    ("a wide shot", "遠景（交代場景）"), ("a full-body view", "全身"), ("a cowboy shot", "七分身（大腿以上）"), ("a medium shot", "半身"),
    ("a close-up", "特寫"), ("an extreme close-up", "大特寫"), ("a low-angle view", "仰角（由下往上）"), ("a high-angle view", "俯角（由上往下）"),
    ("a first-person point-of-view shot", "第一人稱視角"), ("a side view", "側面"), ("a dynamic wide shot", "動態大場面"),
];

/// 頁面尺寸 832×1248（使用者說不要用高解析）
pub const MOSS_SIZE: (i64, i64) = (832, 1248);

pub fn layout(id: &str) -> Option<&'static Layout> {
    LAYOUTS.iter().find(|l| l.0 == id)
}

fn bubble(en: &str) -> (&'static str, &'static str) {
    BUBBLES.iter().copied().find(|b| b.0 == en).unwrap_or(BUBBLES[2])
}

// ================================================================ 版面（六種預設＋自己排的）
/// 自訂排版的一列：(高度權重, 每一格的寬度權重)。權重 1～4，數字只是比例
pub type Row = (u32, Vec<u32>);

/// 一頁的排版：(英文描述, [(英文位置, 中文位置)])。`layout` 是預設版型代號，或 "custom"（用 `custom.rows`）
pub fn layout_of(p: &Value) -> Result<(String, Vec<(String, String)>), String> {
    let id = tx(&p["layout"]);
    if id == "custom" {
        return custom_layout(rows_of(p)?);
    }
    let l = layout(&id).ok_or_else(|| format!("沒有這個版型：{id}"))?;
    Ok((l.2.to_string(), l.3.iter().map(|(en, zh)| (en.to_string(), zh.to_string())).collect()))
}

/// 自訂排版的列：最多 6 列、每列 4 格、全部最多 8 格（MOSS 一頁畫得完的範圍）
pub fn rows_of(p: &Value) -> Result<Vec<Row>, String> {
    let list = p["custom"]["rows"].as_array().ok_or("自訂版面還沒有排任何格")?;
    let mut out: Vec<Row> = Vec::new();
    let mut total = 0usize;
    for r in list.iter().take(6) {
        let h = crate::py::int(&r["h"]).unwrap_or(1).clamp(1, 4) as u32;
        let cells: Vec<u32> = r["cells"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(crate::py::int)
            .map(|w| w.clamp(1, 4) as u32)
            .take(4)
            .collect();
        if cells.is_empty() {
            continue;
        }
        total += cells.len();
        out.push((h, cells));
        if total >= 8 {
            break;
        }
    }
    if out.is_empty() {
        return Err("自訂版面至少要有一格".into());
    }
    Ok(out)
}

/// 這一列在頁面上的位置：(給描述用的片語, 給格子名字用的短詞, 中文)
fn row_place(i: usize, n: usize) -> (&'static str, &'static str, &'static str) {
    match n {
        1 => ("", "", ""),
        2 => [("at the top", "top", "上"), ("at the bottom", "bottom", "下")][i],
        3 => [("at the top", "top", "上"), ("in the middle", "middle", "中"), ("at the bottom", "bottom", "下")][i],
        4 => [
            ("at the top", "top", "上"),
            ("in the upper middle", "upper middle", "上中"),
            ("in the lower middle", "lower middle", "下中"),
            ("at the bottom", "bottom", "下"),
        ][i],
        _ => ("", "", ""),
    }
}

/// 一列有幾格、寬度一不一樣
fn row_phrase(cells: &[u32]) -> String {
    let n = cells.len();
    let equal = cells.windows(2).all(|w| w[0] == w[1]);
    match n {
        1 => "one wide panel".to_string(),
        2 if equal => "two panels side by side".to_string(),
        2 => "two panels side by side, one of them wider".to_string(),
        3 if equal => "three panels side by side".to_string(),
        3 => "three panels side by side with different widths".to_string(),
        4 if equal => "four panels side by side".to_string(),
        _ => format!("{n} panels side by side"),
    }
}

/// 同一列裡這一格的位置（k＝由左數第幾格，0 開始）：(英文, 中文)
fn col_word(k: usize, m: usize) -> (String, String) {
    let (en, zh) = match m {
        1 => ("", ""),
        2 => [("left", "左"), ("right", "右")][k],
        3 => [("left", "左"), ("center", "中"), ("right", "右")][k],
        4 => [("leftmost", "最左"), ("center left", "左中"), ("center right", "右中"), ("rightmost", "最右")][k],
        _ => return (format!("column {}", k + 1), format!("第{}欄", k + 1)),
    };
    (en.to_string(), zh.to_string())
}

/// 自己排的版面 → (英文描述, 每一格的位置)。閱讀順序：上面先、同一列右邊先（日本漫畫右到左）
pub fn custom_layout(rows: Vec<Row>) -> Result<(String, Vec<(String, String)>), String> {
    let n = rows.len();
    let parts: Vec<String> = rows
        .iter()
        .enumerate()
        .map(|(i, (_, cells))| {
            let (place, _, _) = row_place(i, n);
            if place.is_empty() {
                row_phrase(cells)
            } else {
                format!("{} {place}", row_phrase(cells))
            }
        })
        .collect();
    let mut desc = if n == 1 { parts.join("") } else { format!("{n} rows: {}", parts.join(", ")) };
    // 列高不一樣：把比較高的列講出來，不然模型會平均分
    let hs: Vec<u32> = rows.iter().map(|r| r.0).collect();
    if hs.iter().max() != hs.iter().min() {
        let max = *hs.iter().max().unwrap_or(&1);
        let tall: Vec<String> = hs
            .iter()
            .enumerate()
            .filter(|(_, h)| **h == max)
            .map(|(i, _)| {
                let (place, word, _) = row_place(i, n);
                if place.is_empty() { format!("row {}", i + 1) } else { word.to_string() }
            })
            .collect();
        if !tall.is_empty() {
            desc.push_str(&format!(
                " (the {} {})",
                tall.join(" and "),
                if tall.len() > 1 { "rows are taller" } else { "row is taller" }
            ));
        }
    }
    let mut slots = Vec::with_capacity(rows.iter().map(|r| r.1.len()).sum());
    for (i, (_, cells)) in rows.iter().enumerate() {
        let m = cells.len();
        // 超過 4 列就沒有 top／middle／bottom 這種說法了，改用「第幾列」
        let (rword, rzh) = if n >= 5 {
            (format!("row {}", i + 1), format!("第{}列", i + 1))
        } else {
            let (_, word, zh) = row_place(i, n);
            (word.to_string(), zh.to_string())
        };
        // 同一列從右邊先讀
        for k in (0..m).rev() {
            let (cword, czh) = col_word(k, m);
            let en = if rword.is_empty() && cword.is_empty() {
                "panel".to_string()
            } else {
                let parts: Vec<String> = [rword.clone(), cword.clone()].into_iter().filter(|s| !s.is_empty()).collect();
                format!("{} panel", parts.join(" "))
            };
            let zh = match (rzh.as_str(), czh.as_str()) {
                ("", "") => "這一格".to_string(),
                ("", h) => format!("{h}邊那格"),
                ("中", "") => "中間那格".to_string(),
                ("中", h) => format!("中間{h}邊那格"),
                (v, "") => format!("{v}方那格"),
                (v, "中") => format!("{v}方中間那格"),
                (v, h) => format!("{h}{v}那格"),
            };
            slots.push((en, zh));
        }
    }
    Ok((desc, slots))
}

fn field(v: &Value, k: &str) -> String {
    tx(&v[k]).trim().to_string()
}

/// 句尾補句點（使用者寫的內容常常沒有）
fn sentence(s: &str) -> String {
    let s = s.trim().trim_end_matches([',', '，']);
    if s.ends_with(['.', '!', '?', '。', '！', '？']) {
        s.to_string()
    } else {
        format!("{s}.")
    }
}

/// 一格有沒有內容（景別或內容寫了任何一個）
fn has_scene(c: &Value) -> bool {
    !field(c, "what").is_empty()
}

/// MOSS-Image 一次畫完整頁＋字。cast＝角色外貌（每個角色完整寫一次）
pub fn moss_page(p: &Value) -> Result<String, String> {
    let (desc, slots) = layout_of(p)?;
    let list = p["panels"].as_array().cloned().unwrap_or_default();
    let mut sent = vec![format!(
        "The image is a vertical full-color anime manga page divided into {desc}, separated by thin black borders with white gutters, read from right to left."
    )];
    let cast = field(p, "cast");
    if !cast.is_empty() {
        sent.push(sentence(&cast));
    }
    for (i, (slot, _)) in slots.iter().enumerate() {
        let c = list.get(i).unwrap_or(&Value::Null);
        if !has_scene(c) {
            continue;
        }
        let shot = field(c, "shot");
        let shot = if shot.is_empty() { "a medium shot".to_string() } else { shot };
        let mut s = format!("The {slot} shows {shot} of {}", field(c, "what").trim_end_matches(['.', ',']));
        let line = field(c, "line");
        if !line.is_empty() {
            s.push_str(&format!(
                "; a white oval speech bubble at the {} of the panel contains the vertical black Traditional Chinese text \"{}\"",
                bubble(&field(c, "bubble")).0,
                line.replace('"', "\u{201D}")
            ));
        }
        let sfx = field(c, "sfx");
        if !sfx.is_empty() {
            s.push_str(&format!(
                "; a large pink hand-lettered Japanese sound effect \"{}\" floats nearby with small pink hearts",
                sfx.replace('"', "\u{201D}")
            ));
        }
        sent.push(sentence(&s));
    }
    let light = field(p, "light");
    if !light.is_empty() {
        sent.push(sentence(&light));
    }
    let mood = field(p, "mood");
    let mood = if mood.is_empty() { "lively".to_string() } else { mood };
    sent.push(format!("The page has a {mood} mood with saturated colors and clean anime line art."));
    let body = sent.join(" ");
    let trig = field(p, "trigger");
    Ok(if trig.is_empty() { body } else { format!("{}. {body}", trig.trim_end_matches(['.', ','])) })
}

/// 寫好的格數（版型範圍內、有內容的格；切到格數少的版型時，多出來的格會留著但不算）
pub fn filled_panels(p: &Value) -> usize {
    let Ok((_, slots)) = layout_of(p) else { return 0 };
    let list = p["panels"].as_array().cloned().unwrap_or_default();
    (0..slots.len()).filter(|i| list.get(*i).is_some_and(has_scene)).count()
}

// ================================================================ AI 排分鏡（35B）
/// 給 35B 的系統提示：把一頁的劇情拆成每一格。回傳一定要是 JSON，欄位跟手寫的一模一樣。
pub const SYSTEM_SCRIPT: &str = r#"You lay out ONE page of a manga for an AI image model (MOSS-Image) that draws the entire page, panels and lettering included, in a single image. You are given the panel layout, the fixed character descriptions, the lighting, the mood, and the story this page must tell. Split it into panels, in reading order, and write what each panel shows.

Return JSON only. No prose, no explanation, no code fences.

{"panels":[{"shot":"a medium shot","what":"...","line":"...","bubble":"top","sfx":""}]}

Rules:
- Exactly {N} panel objects, in reading order. Use every panel; never merge, skip or add panels.
- "shot" must be one of: a wide shot, a full-body view, a cowboy shot, a medium shot, a close-up, an extreme close-up, a low-angle view, a high-angle view, a first-person point-of-view shot, a side view, a dynamic wide shot.
- "what" is ONE short English phrase describing who is where, what they are doing and how the picture is composed. Visible physical things only. Never repeat hair, clothing or body details already listed in the character descriptions. Never write text, signs, captions, speech or letters in this field.
- "line" is the spoken dialogue inside the speech bubble, in Traditional Chinese (Taiwan usage), 8 characters or fewer when the panel is small. Use "" when nobody speaks.
- "bubble" is where the bubble sits: top left, top right, top, left side, right side, or bottom.
- "sfx" is a short Japanese onomatopoeia drawn as a large hand-lettered sound effect, or "".
- Every panel is a different moment or a clearly different angle. Do not repeat the same composition.
- Keep the art style consistent across the page and match the requested lighting and mood.
- The page reads right to left, so the earliest story beats go in the rightmost/topmost panels."#;

/// 排分鏡的訊息：(系統, 使用者)。story＝使用者寫的這段劇情（中文可以）
pub fn script_messages(p: &Value, story: &str) -> (String, String) {
    let (desc, slots) = layout_of(p).unwrap_or_else(|_| {
        let l = &LAYOUTS[1];
        (l.2.to_string(), l.3.iter().map(|(en, zh)| (en.to_string(), zh.to_string())).collect())
    });
    let n = slots.len();
    let order: Vec<String> = slots
        .iter()
        .enumerate()
        .map(|(i, (en, zh))| format!("{}. {} / {}", i + 1, en, zh))
        .collect();
    let or_free = |s: String| if s.trim().is_empty() { "(free choice)".to_string() } else { s };
    let user = format!(
        "Page layout: {desc}.\nPanel order (reading order, right to left):\n{}\n\nFixed character descriptions: {}\nLighting: {}\nMood: {}\nStyle trigger words: {}\n\nStory for this page:\n{}\n\nExactly {n} panels. Return the JSON now.",
        order.join("\n"),
        or_free(field(p, "cast")),
        or_free(field(p, "light")),
        or_free(field(p, "mood")),
        or_free(field(p, "trigger")),
        story.trim(),
    );
    (SYSTEM_SCRIPT.replace("{N}", &n.to_string()), user)
}

/// 模型吐的 shot 對回選單裡有的那幾個（對不到就半身）
fn snap_shot(s: &str) -> &'static str {
    let s = s.to_lowercase();
    let has = |k: &str| s.contains(k);
    if has("extreme close") || has("大特寫") {
        "an extreme close-up"
    } else if has("close") || has("特寫") {
        "a close-up"
    } else if has("cowboy") || has("七分") {
        "a cowboy shot"
    } else if has("full") || has("全身") {
        "a full-body view"
    } else if has("first-person") || has("point-of-view") || has("pov") || has("第一人稱") {
        "a first-person point-of-view shot"
    } else if has("low-angle") || has("low angle") || has("仰角") {
        "a low-angle view"
    } else if has("high-angle") || has("high angle") || has("俯角") {
        "a high-angle view"
    } else if has("dynamic") || has("動態") {
        "a dynamic wide shot"
    } else if has("side") || has("側面") {
        "a side view"
    } else if has("wide") || has("遠景") {
        "a wide shot"
    } else {
        "a medium shot"
    }
}

/// 模型吐的對話框位置對回選單裡有的那幾個
fn snap_bubble(s: &str) -> &'static str {
    let s = s.to_lowercase();
    let has = |k: &str| s.contains(k);
    if has("top left") || has("upper left") {
        "top left"
    } else if has("top right") || has("upper right") {
        "top right"
    } else if has("bottom") || has("下") {
        "bottom"
    } else if has("left") || has("左") {
        "left side"
    } else if has("right") || has("右") {
        "right side"
    } else {
        "top"
    }
}

fn blank_panel() -> Value {
    json!({"shot": "a medium shot", "what": "", "line": "", "bubble": "top", "sfx": ""})
}

/// 模型輸出 → 剛好 n 格（多出來的不理、不夠的補空白）。一格的內容都沒有＝格式壞掉，回 None 讓呼叫的人重試。
pub fn parse_script(text: &str, n: usize) -> Option<Vec<Value>> {
    use crate::director::json_in;
    let m = json_in(text).or_else(|| {
        // 偶爾直接吐陣列：包一層再讀
        let i = text.find('[')?;
        json_in(&format!("{{\"panels\":{}}}", &text[i..]))
    })?;
    let arr = m.get("panels").and_then(Value::as_array)?;
    let get = |c: &Value, keys: &[&str]| -> String {
        keys.iter().find_map(|k| c.get(*k)).map(|v| tx(v).trim().to_string()).unwrap_or_default()
    };
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let c = arr.get(i);
        let Some(c) = c else {
            out.push(blank_panel());
            continue;
        };
        let what = get(c, &["what", "content", "description", "scene", "action"]);
        out.push(json!({
            "shot": snap_shot(&get(c, &["shot", "framing"])),
            "what": what,
            "line": get(c, &["line", "dialogue", "speech"]),
            "bubble": snap_bubble(&get(c, &["bubble", "bubble_at", "position"])),
            "sfx": get(c, &["sfx", "sound", "onomatopoeia"]),
        }));
    }
    // 至少要有兩格真的有內容，不然就是模型沒照格式寫
    (out.iter().filter(|c| has_scene(c)).count() >= 2 || (n < 2 && out.first().is_some_and(has_scene))).then_some(out)
}

// ================================================================ 存檔（跟導演台同一套寫法）
pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    pub fn new(data: &Path) -> Store {
        Store { dir: data.join("comic") }
    }
    fn file(&self, id: &str) -> PathBuf {
        self.dir.join("projects").join(format!("{id}.json"))
    }
    pub fn projects(&self) -> Vec<Value> {
        let mut out: Vec<Value> = std::fs::read_dir(self.dir.join("projects"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| serde_json::from_slice::<Value>(&std::fs::read(e.path()).ok()?).ok())
            .map(|p| json!({"id": p["id"], "title": p["title"], "updated": p["updated"], "layout": p["layout"]}))
            .collect();
        out.sort_by(|a, b| b["updated"].as_f64().unwrap_or(0.0).total_cmp(&a["updated"].as_f64().unwrap_or(0.0)));
        out
    }
    pub fn project(&self, id: &str) -> Option<Value> {
        if !valid_id(id) {
            return None;
        }
        serde_json::from_slice(&std::fs::read(self.file(id)).ok()?).ok()
    }
    pub fn save(&self, p: &mut Value) -> std::io::Result<()> {
        let id = tx(&p["id"]);
        if !valid_id(&id) {
            return Err(std::io::Error::other("作品編號不對"));
        }
        p["updated"] = json!(now());
        write_atomic(&self.file(&id), p)
    }
    /// 不真的刪：搬到 data\待刪除\漫畫台\
    pub fn trash(&self, id: &str, trash: &Path) -> std::io::Result<()> {
        if !valid_id(id) {
            return Err(std::io::Error::other("作品編號不對"));
        }
        let to = trash.join("漫畫台");
        std::fs::create_dir_all(&to)?;
        std::fs::rename(self.file(id), to.join(format!("{id}_{}.json", chrono::Local::now().format("%Y%m%d_%H%M%S"))))
    }
}

/// 新作品的預設值（四格）
pub fn blank(title: &str) -> Value {
    let panel = || json!({"shot": "a medium shot", "what": "", "line": "", "bubble": "top", "sfx": ""});
    json!({
        "id": new_id(), "title": if title.trim().is_empty() { "未命名" } else { title.trim() }, "created": now(), "updated": now(),
        "layout": "L4", "trigger": "", "cast": "", "light": "", "mood": "", "script": "",
        "panels": [panel(), panel(), panel(), panel()], "image": null, "count": 4, "runs": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({"layout": "L3", "trigger": "jgdxstyle", "light": "Purple candlelight", "mood": "hot",
               "panels": [
                   {"shot": "a full-body view", "what": "the succubus riding the man", "line": "你的精氣，我全都要～", "bubble": "top left"},
                   {"shot": "a close-up", "what": "the man gritting his teeth.", "line": "等、等一下……！", "bubble": "top right"},
                   {"shot": "an extreme close-up", "what": "their joined hips", "line": "", "sfx": "ズチュッ"}]})
    }

    #[test]
    fn hidden_and_sceneless_panels_are_skipped() {
        // 版型 L3 只看前三格：第四格有內容也不算
        let mut p = json!({"layout": "L3", "panels": [{"what": ""}, {"what": ""}, {"what": ""}, {"what": "a girl", "line": "嗨"}]});
        assert_eq!(filled_panels(&p), 0);
        p["layout"] = json!("L4");
        assert_eq!(filled_panels(&p), 1);
        // 只有台詞、沒寫內容的格：不畫，台詞也不進提示詞
        p["panels"][0] = json!({"what": "", "line": "看不到我"});
        p["panels"][3]["line"] = json!("她說「好」");
        let s = moss_page(&p).unwrap();
        assert!(!s.contains("看不到我"));
        assert!(s.contains("The small slanted inset panel at the bottom right shows a medium shot of a girl;"));
        assert!(s.contains("contains the vertical black Traditional Chinese text \"她說「好」\""));
    }

    #[test]
    fn moss_page_and_missing_panels() {
        let mut p = sample();
        p["layout"] = json!("K4"); // 四格只給三格：第四格空白不寫
        p["cast"] = json!("A pink-haired succubus");
        let s = moss_page(&p).unwrap();
        assert!(s.starts_with("jgdxstyle. The image is a vertical full-color anime manga page divided into four horizontal panels"));
        assert!(s.contains("A pink-haired succubus. The first panel at the top shows a full-body view of the succubus riding the man; a white oval speech bubble at the top left of the panel contains the vertical black Traditional Chinese text \"你的精氣，我全都要～\"."));
        assert!(s.contains("Japanese sound effect \"ズチュッ\""));
        assert!(!s.contains("fourth panel"));
        assert!(s.ends_with("The page has a hot mood with saturated colors and clean anime line art."));
        assert!(moss_page(&json!({"layout": "L9"})).is_err());
    }

    #[test]
    fn every_layout_and_option_is_consistent() {
        for (id, zh, desc, slots) in LAYOUTS {
            assert!(!zh.is_empty() && desc.contains("panel"), "{id}");
            assert!((3..=6).contains(&slots.len()), "{id}");
        }
        assert_eq!(blank("x")["panels"].as_array().unwrap().len(), layout("L4").unwrap().3.len());
        assert!(valid_id(&tx(&blank("")["id"])));
    }

    // ---------------------------------------------------------------- 自訂版面
    fn custom(rows: Value) -> Value {
        json!({"layout": "custom", "custom": {"rows": rows}})
    }

    #[test]
    fn custom_rows_are_described_and_read_right_to_left() {
        let p = custom(json!([
            {"h": 1, "cells": [1, 1]},
            {"h": 2, "cells": [1]},
            {"h": 1, "cells": [1, 1]}
        ]));
        let (desc, slots) = layout_of(&p).unwrap();
        assert!(desc.starts_with("3 rows: two panels side by side at the top"), "{desc}");
        assert!(desc.contains("one wide panel in the middle"), "{desc}");
        assert!(desc.contains("two panels side by side at the bottom"), "{desc}");
        assert!(desc.contains("middle row is taller"), "{desc}");
        let names: Vec<&str> = slots.iter().map(|s| s.0.as_str()).collect();
        assert_eq!(
            names,
            ["top right panel", "top left panel", "middle panel", "bottom right panel", "bottom left panel"]
        );
        let zh: Vec<&str> = slots.iter().map(|s| s.1.as_str()).collect();
        assert_eq!(zh, ["右上那格", "左上那格", "中間那格", "右下那格", "左下那格"]);

        // 提示詞要照閱讀順序寫，而且每一格都進得去
        let mut page = p.clone();
        page["panels"] = json!([
            {"what": "a"}, {"what": "b"}, {"what": "c"}, {"what": "d"}, {"what": "e"}
        ]);
        let s = moss_page(&page).unwrap();
        assert!(s.contains("The image is a vertical full-color anime manga page divided into 3 rows:"));
        let at = |needle: &str| s.find(needle).unwrap_or_else(|| panic!("缺 {needle}：{s}"));
        assert!(at("The top right panel shows") < at("The top left panel shows"));
        assert!(at("The top left panel shows") < at("The middle panel shows"));
        assert!(at("The middle panel shows") < at("The bottom right panel shows"));
        assert!(at("The bottom right panel shows") < at("The bottom left panel shows"));
    }

    #[test]
    fn custom_one_row_names_every_column() {
        let p = custom(json!([{"h": 1, "cells": [1, 1, 1, 1]}]));
        let (desc, slots) = layout_of(&p).unwrap();
        assert_eq!(desc, "four panels side by side");
        let names: Vec<&str> = slots.iter().map(|s| s.0.as_str()).collect();
        assert_eq!(names, ["rightmost panel", "center right panel", "center left panel", "leftmost panel"]);
        // 只有一格：就叫 panel，中文「這一格」
        let (desc1, s1) = layout_of(&custom(json!([{"h": 1, "cells": [1]}]))).unwrap();
        assert_eq!(desc1, "one wide panel");
        assert_eq!((s1[0].0.as_str(), s1[0].1.as_str()), ("panel", "這一格"));
    }

    #[test]
    fn custom_unequal_widths_and_heights_are_mentioned() {
        let (desc, _) = layout_of(&custom(json!([{"h": 1, "cells": [1, 3]}]))).unwrap();
        assert!(desc.contains("one of them wider"), "{desc}");
        let (desc2, _) = layout_of(&custom(json!([{"h": 3, "cells": [1]}, {"h": 1, "cells": [1]}]))).unwrap();
        assert!(desc2.contains("top row is taller"), "{desc2}");
        // 五列以上改用「第幾列」
        let five = custom(json!([{"cells": [1]}, {"cells": [1]}, {"cells": [1]}, {"cells": [1]}, {"cells": [1]}]));
        assert_eq!(layout_of(&five).unwrap().1[0].0, "row 1 panel");
    }

    #[test]
    fn custom_layout_is_clamped_and_never_empty() {
        assert!(layout_of(&json!({"layout": "custom"})).is_err());
        assert!(layout_of(&custom(json!([]))).is_err());
        // 每列最多 4 格、全部最多 8 格；高度夾在 1～4
        let p = custom(json!([
            {"h": 9, "cells": [1, 1, 1, 1, 1, 1]},
            {"h": 0, "cells": [1, 1, 1, 1]},
            {"h": 1, "cells": [1]}
        ]));
        let (_, slots) = layout_of(&p).unwrap();
        assert_eq!(slots.len(), 8);
        assert_eq!(rows_of(&p).unwrap()[0].0, 4);
        assert_eq!(rows_of(&p).unwrap()[1].0, 1);
    }

    #[test]
    fn custom_layout_feeds_the_script_prompt() {
        let mut p = custom(json!([{"h": 1, "cells": [1, 1]}]));
        p["cast"] = json!("A knight");
        let (sys, user) = script_messages(&p, "她拔劍。");
        assert!(sys.contains("Exactly 2 panel objects"), "{sys}");
        assert!(user.contains("two panels side by side"), "{user}");
        assert!(user.contains("1. right panel / 右邊那格"), "{user}");
        assert!(user.contains("她拔劍。"), "{user}");
    }
}
