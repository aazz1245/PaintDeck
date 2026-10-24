//! 漫畫台（2026-10-16）：一整頁分格漫畫＝選版型、每格寫景別／內容／台詞／狀聲詞 → 組提示詞 → MOSS-Image 一次畫完整頁和字。不用 AI 改寫模型（使用者不放心 35B）。
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
/// 一格：(英文格子位置, 中文格子位置, 這一格的內容)
type Panel = (&'static str, &'static str, Value);

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

/// 版型的格子＋這一格的內容（格數不夠就補空白、多的不用）
fn panels(p: &Value) -> Result<(&'static str, Vec<Panel>), String> {
    let id = tx(&p["layout"]);
    let l = layout(&id).ok_or_else(|| format!("沒有這個版型：{id}"))?;
    let list = p["panels"].as_array().cloned().unwrap_or_default();
    let out = l.3.iter().enumerate().map(|(i, s)| (s.0, s.1, list.get(i).cloned().unwrap_or(Value::Null))).collect();
    Ok((l.2, out))
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
    let (desc, ps) = panels(p)?;
    let mut sent = vec![format!(
        "The image is a vertical full-color anime manga page divided into {desc}, separated by thin black borders with white gutters, read from right to left."
    )];
    let cast = field(p, "cast");
    if !cast.is_empty() {
        sent.push(sentence(&cast));
    }
    for (slot, _, c) in &ps {
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
    panels(p).map(|(_, ps)| ps.iter().filter(|(_, _, c)| has_scene(c)).count()).unwrap_or(0)
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
        "layout": "L4", "trigger": "", "cast": "", "light": "", "mood": "",
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
}
