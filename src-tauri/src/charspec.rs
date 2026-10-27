//! 角色設定表（docs\superpowers\specs\2026-10-27-character-asset-design.md）：
//! 2026-10-27 使用者：「補一份標準化角色設定表，把所有客觀特徵寫死。髮型、臉型、髮色、膚色、年齡、體型，再加幾個專屬標誌」，
//! 影片「提示詞開頭原封不動放上所有出場的角色設定」。
//! 存在角色資產的 data.spec：
//!   {fields: {sex: {zh, en, tags: [..]}, age: …, …}, locked, block_zh, block_en, block_tags}
//! 鎖定時程式把欄位組成三段固定文字（中文、英文、Danbooru tag），之後原封不動：再存檔送來不同的欄位也不會改（merge），
//! 要改得先解鎖。任何 AI 都不經手這三段，用的地方只接在最前面。
use serde_json::{json, Map, Value};

/// 欄位固定、順序固定：(key, 中文名)
pub const FIELDS: &[(&str, &str)] = &[
    ("sex", "性別"),
    ("age", "年齡"),
    ("hair_style", "髮型"),
    ("hair_color", "髮色"),
    ("face", "臉型"),
    ("eyes", "眼睛"),
    ("skin", "膚色"),
    ("body", "體型"),
    ("marks", "專屬標誌"),
    ("outfit", "預設服裝"),
];
const MAX_TAGS: usize = 12;
const MAX_BLOCK: usize = 4000;

fn s(v: &Value, max: usize) -> String {
    let t = v.as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().take(max).collect()
}

/// 一格的 tag：陣列或逗號分隔字串都收；小寫、底線換空白、去重複
fn tags(v: &Value) -> Vec<String> {
    let raw: Vec<String> = match v {
        Value::Array(a) => a.iter().filter_map(|t| t.as_str().map(str::to_owned)).collect(),
        Value::String(t) => t.split([',', '，', '、']).map(str::to_owned).collect(),
        _ => vec![],
    };
    let mut out: Vec<String> = vec![];
    for t in raw {
        let t: String = t.trim().replace('_', " ").to_lowercase().chars().take(60).collect();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out.truncate(MAX_TAGS);
    out
}

/// 網頁、AI 送來的設定表 → 固定形狀。block 只在鎖住時留著（真正的 block 由 merge 決定，不信任送來的）
pub fn clean(v: &Value) -> Value {
    let mut fields = Map::new();
    for (k, _) in FIELDS {
        let f = &v["fields"][*k];
        fields.insert(k.to_string(), json!({"zh": s(&f["zh"], 200), "en": s(&f["en"], 300), "tags": tags(&f["tags"])}));
    }
    let locked = v["locked"].as_bool() == Some(true);
    let mut out = json!({"fields": fields, "locked": locked});
    if locked {
        for k in ["block_zh", "block_en", "block_tags"] {
            out[k] = json!(s(&v[k], MAX_BLOCK));
        }
    }
    out
}

/// 句尾的標點拿掉（組字時統一加），免得「。。」
fn bare(t: &str) -> &str {
    t.trim().trim_end_matches(['。', '，', '、', '；', '.', ',', ';', ' '])
}

/// 欄位 → (中文, 英文, tag) 三段固定文字。空的欄位略過；標誌、服裝另外標名稱
pub fn blocks(fields: &Value) -> (String, String, String) {
    let get = |k: &str, lang: &str| bare(fields[k][lang].as_str().unwrap_or("")).to_string();
    let looks = |lang: &str| -> Vec<String> {
        FIELDS
            .iter()
            .filter(|(k, _)| !matches!(*k, "marks" | "outfit"))
            .map(|(k, _)| get(k, lang))
            .filter(|t| !t.is_empty())
            .collect()
    };
    let mut zh = looks("zh").join("，");
    let mut en = looks("en").join(", ");
    for (k, zl, el) in [("marks", "專屬標誌", "distinctive marks"), ("outfit", "預設服裝", "default outfit")] {
        let (z, e) = (get(k, "zh"), get(k, "en"));
        if !z.is_empty() {
            zh = if zh.is_empty() { format!("{zl}：{z}") } else { format!("{zh}；{zl}：{z}") };
        }
        if !e.is_empty() {
            en = if en.is_empty() { format!("{el}: {e}") } else { format!("{en}; {el}: {e}") };
        }
    }
    if !zh.is_empty() {
        zh.push('。');
    }
    if !en.is_empty() {
        en.push('.');
    }
    let mut all: Vec<String> = vec![];
    for (k, _) in FIELDS {
        for t in tags(&fields[*k]["tags"]) {
            if !all.contains(&t) {
                all.push(t);
            }
        }
    }
    (zh, en, all.join(", "))
}

fn is_locked(v: Option<&Value>) -> bool {
    v.is_some_and(|v| v["locked"].as_bool() == Some(true) && ["block_zh", "block_en"].iter().any(|k| !v[*k].as_str().unwrap_or("").is_empty()))
}

/// 存檔時決定設定表：
/// - 沒送 spec → 留舊的
/// - 舊的鎖著、新的也鎖著 → 原封不動用舊的（欄位、三段文字都不換）
/// - 新的鎖、舊的沒鎖（或沒有）→ 照新欄位組三段文字
/// - 新的沒鎖 → 欄位照新的、拿掉三段文字（解鎖）
pub fn merge(new: Option<&Value>, old: Option<&Value>) -> Option<Value> {
    let old = old.filter(|v| v.is_object()).map(clean);
    let Some(new) = new.filter(|v| v.is_object()) else { return old };
    let new = clean(new);
    if new["locked"] == true {
        if is_locked(old.as_ref()) {
            return old;
        }
        let (zh, en, tg) = blocks(&new["fields"]);
        if zh.is_empty() && en.is_empty() {
            // 全空的表鎖了也沒意義：當作沒鎖
            return Some(json!({"fields": new["fields"], "locked": false}));
        }
        return Some(json!({"fields": new["fields"], "locked": true, "block_zh": zh, "block_en": en, "block_tags": tg}));
    }
    Some(json!({"fields": new["fields"], "locked": false}))
}

/// 角色資產鎖住的三段文字 (中文, 英文, tag)；沒鎖、沒有設定表回 None
pub fn locked_blocks(data: &Value) -> Option<(String, String, String)> {
    let sp = &data["spec"];
    if !is_locked(Some(sp)) {
        return None;
    }
    let g = |k: &str| sp[k].as_str().unwrap_or("").to_string();
    Some((g("block_zh"), g("block_en"), g("block_tags")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({"fields": {
            "sex": {"zh": "女性", "en": "female", "tags": ["1girl"]},
            "age": {"zh": "外觀二十出頭", "en": "looks in her early 20s", "tags": []},
            "hair_style": {"zh": "及腰長直髮", "en": "waist-length straight hair", "tags": "very long hair, straight_hair"},
            "hair_color": {"zh": "柑橘色頭髮", "en": "orange hair", "tags": ["Orange Hair"]},
            "face": {"zh": "鵝蛋臉。", "en": "oval face.", "tags": []},
            "eyes": {"zh": "橘色杏眼", "en": "orange almond-shaped eyes", "tags": ["orange eyes"]},
            "skin": {"zh": "", "en": "", "tags": []},
            "body": {"zh": "纖細", "en": "slender build", "tags": ["slender"]},
            "marks": {"zh": "右眼下方一顆美人痣", "en": "a beauty mark under the right eye", "tags": ["mole under eye"]},
            "outfit": {"zh": "橘白短禮服", "en": "an orange and white short dress", "tags": ["orange dress"]}
        }})
    }

    #[test]
    fn blocks_join_fields_in_fixed_order() {
        let (zh, en, tg) = blocks(&clean(&sample())["fields"]);
        assert_eq!(zh, "女性，外觀二十出頭，及腰長直髮，柑橘色頭髮，鵝蛋臉，橘色杏眼，纖細；專屬標誌：右眼下方一顆美人痣；預設服裝：橘白短禮服。");
        assert_eq!(
            en,
            "female, looks in her early 20s, waist-length straight hair, orange hair, oval face, orange almond-shaped eyes, slender build; \
             distinctive marks: a beauty mark under the right eye; default outfit: an orange and white short dress."
        );
        assert_eq!(tg, "1girl, very long hair, straight hair, orange hair, orange eyes, slender, mole under eye, orange dress");
    }

    #[test]
    fn lock_freezes_and_unlock_clears() {
        let mut first = sample();
        first["locked"] = json!(true);
        let locked = merge(Some(&first), None).unwrap();
        assert_eq!(locked["locked"], true);
        let block = locked["block_en"].as_str().unwrap().to_string();
        assert!(block.starts_with("female, "));
        // 鎖著再存一次，欄位被改、還送了假的 block：照舊
        let mut tamper = first.clone();
        tamper["fields"]["hair_color"]["en"] = json!("blue hair");
        tamper["block_en"] = json!("hacked");
        let again = merge(Some(&tamper), Some(&locked)).unwrap();
        assert_eq!(again["block_en"], block.as_str());
        assert_eq!(again["fields"]["hair_color"]["en"], "orange hair");
        // 沒送 spec：留舊的
        assert_eq!(merge(None, Some(&locked)).unwrap()["block_en"], block.as_str());
        // 解鎖：欄位照新的、block 拿掉
        let mut open = tamper.clone();
        open["locked"] = json!(false);
        let unlocked = merge(Some(&open), Some(&locked)).unwrap();
        assert_eq!(unlocked["locked"], false);
        assert!(unlocked.get("block_en").is_none());
        assert_eq!(unlocked["fields"]["hair_color"]["en"], "blue hair");
        assert_eq!(locked_blocks(&json!({"spec": unlocked})), None);
        assert_eq!(locked_blocks(&json!({"spec": locked})).unwrap().1, block);
    }

    #[test]
    fn junk_is_cleaned() {
        assert!(merge(None, None).is_none());
        let c = clean(&json!({"fields": {"sex": {"zh": 3, "tags": {"a": 1}}, "bogus": {"zh": "x"}}, "locked": "yes"}));
        assert_eq!(c["fields"].as_object().unwrap().len(), FIELDS.len());
        assert_eq!(c["locked"], false);
        assert_eq!(c["fields"]["sex"]["zh"], "");
        // 全空的表鎖不起來
        let empty = merge(Some(&json!({"locked": true})), None).unwrap();
        assert_eq!(empty["locked"], false);
        // tag 上限、去重複
        let many: Vec<String> = (0..30).map(|i| format!("t{i}")).collect();
        let t = clean(&json!({"fields": {"marks": {"tags": many}}}));
        assert_eq!(t["fields"]["marks"]["tags"].as_array().unwrap().len(), MAX_TAGS);
    }
}
