//! 提示詞自動完成：Danbooru tag（依使用次數排序）＋中文對照（輸入中文也能找到英文 tag）。對照舊版 tags.py。
//!
//! 資料：
//!   data\tags\danbooru.csv   來自 a1111-sd-webui-tagcomplete（tag,category,count,aliases）
//!   data\tags\zh_map.json    由使用者提供的提示詞對照表轉出（中文 → 英文 tag）
//!   resources\tags\t2s_chars.json  繁→簡逐字對照（編進程式）：對照表是繁體，簡體輸入折成簡體再比（2026-10-21）
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

static CJK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[㐀-鿿]").unwrap());
/// 年齡類 tag 與其別名不列入自動完成
static SKIP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|_)(loli|lolicon|lolidom|shota|shotacon|child|children|toddler|toddlercon|underage|aged_down|female_child|male_child)($|_)").unwrap()
});

/// 繁體字 → 簡體字逐字對照（resources\tags\t2s_chars.json，由 tools\make_t2s_chars.mjs 從 OpenCC 字典產生）。
/// 編進程式裡，不用另外找檔：使用者自己的 data\tags 換了 danbooru.csv／zh_map.json 也不影響，poses.rs 的姿勢比對共用同一份
const T2S_JSON: &str = include_str!("../../resources/tags/t2s_chars.json");

static T2S: LazyLock<HashMap<char, char>> = LazyLock::new(|| {
    let v: Value = serde_json::from_str(T2S_JSON).unwrap_or_default();
    v["map"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, s)| {
            let (mut k, mut s) = (k.chars(), s.as_str()?.chars());
            match (k.next(), k.next(), s.next(), s.next()) {
                (Some(a), None, Some(b), None) => Some((a, b)),
                _ => None,
            }
        })
        .collect()
});

/// 把繁體字逐字折成簡體：對照表（zh_map.json、poses.json）是繁體，使用者可能打簡體，兩邊都折過再比就找得到。
/// 簡體字和沒有簡體寫法的字原樣不動；一對多（髮／發 → 发、乾／幹 → 干）折在一起，所以折過的字串只拿來比對，不拿來顯示
pub fn fold_zh(s: &str) -> String {
    if s.is_ascii() {
        return s.to_string();
    }
    s.chars().map(|c| *T2S.get(&c).unwrap_or(&c)).collect()
}

fn cat_name(c: i64) -> &'static str {
    match c {
        0 => "一般",
        1 => "畫師",
        3 => "作品",
        4 => "角色",
        5 => "後設",
        _ => "",
    }
}

/// Python int(s or 0)：空字串當 0，其他解析失敗也當 0（舊版會丟例外，資料檔裡沒有這種列）
fn int0(s: &str) -> i64 {
    s.trim().parse().unwrap_or(0)
}

#[derive(Default)]
pub struct TagIndex {
    rows: Vec<(String, i64, i64, Vec<String>)>,
    zh: HashMap<String, String>,
    zh_rows: Vec<(String, String)>,
    zh_fold: Vec<String>, // zh_rows 每一列的中文折成簡體（fold_zh），一列對一列，簡體輸入用
    count: HashMap<String, i64>,
}

impl TagIndex {
    pub fn load(dir: &Path) -> TagIndex {
        let mut ix = TagIndex::default();
        if let Ok(mut rd) = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_path(dir.join("danbooru.csv"))
        {
            for r in rd.records().flatten() {
                let f = |i: usize| r.get(i).unwrap_or("");
                let aliases: Vec<String> = if r.len() > 3 && !f(3).is_empty() {
                    f(3).split(',').map(str::to_owned).collect()
                } else {
                    vec![]
                };
                if r.len() < 3 || SKIP.is_match(f(0)) || aliases.iter().any(|a| SKIP.is_match(a)) {
                    continue;
                }
                ix.rows
                    .push((f(0).to_string(), int0(f(1)), int0(f(2)), aliases));
            }
        }
        if let Ok(text) = std::fs::read_to_string(dir.join("zh_map.json")) {
            if let Ok(Value::Array(pairs)) = serde_json::from_str::<Value>(&text) {
                for p in pairs {
                    let (Some(zh), Some(en)) = (p[0].as_str(), p[1].as_str()) else {
                        continue;
                    };
                    let en = en.replace(' ', "_");
                    ix.zh
                        .entry(en.to_lowercase())
                        .or_insert_with(|| zh.to_string());
                    ix.zh_fold.push(fold_zh(zh));
                    ix.zh_rows.push((zh.to_string(), en));
                }
            }
        }
        ix.count = ix.rows.iter().map(|(t, _, c, _)| (t.clone(), *c)).collect();
        ix
    }

    /// 一個 tag 的中文對照（反推視窗用）；對照表是簡轉繁，「头发」會被轉成「頭發」，跟頭髮有關的改回「髮」。
    /// 對照表裡翻錯或沒有、反推又常出現的，用 ZH_FIX 蓋過去
    pub fn zh_of(&self, tag: &str) -> Option<String> {
        const ZH_FIX: &[(&str, &str)] = &[
            ("upskirt", "裙底視角"), ("pantyshot", "露出內褲"), ("lace-trimmed_legwear", "蕾絲邊襪"),
            ("painting_(object)", "畫作（物品）"), ("drawing_(object)", "畫（物品）"), ("portrait_(object)", "肖像畫（物品）"),
            ("red_lips", "紅唇"), ("realistic", "寫實"), ("nose", "鼻子（畫得明顯）"), ("lips", "嘴唇（畫得明顯）"),
            ("asian", "亞洲人"), ("on_couch", "在沙發上"), ("bent_over", "彎腰"), ("from_behind", "從背後看"),
            ("hand_on_own_hip", "單手叉腰"), ("hands_on_own_hips", "雙手叉腰"), ("upper_teeth_only", "只露上排牙齒"),
            ("puff_of_air", "噴氣（生氣或嘆氣）"), ("stuffed_rabbit", "兔子布偶"), ("shoulder_boards", "肩章"),
            ("art_tools_in_frame", "畫具入鏡"), ("pink_halo", "粉紅光環"), ("tarot_(medium)", "塔羅牌風格"),
        ];
        let key = tag.replace("\\(", "(").replace("\\)", ")").replace(' ', "_").to_lowercase();
        if key.len() == 4 && key.chars().all(|c| c.is_ascii_digit()) {
            return Some("年份".into());
        }
        if let Some((_, z)) = ZH_FIX.iter().find(|(k, _)| *k == key) {
            return Some(z.to_string());
        }
        let zh = self.zh.get(&key)?;
        Some(if key.contains("hair") { zh.replace('發', "髮") } else { zh.clone() })
    }

    /// 這個 tag 在 danbooru.csv 裡有沒有（空白、底線、大小寫都算同一個）；資產庫存 Anima tag 時檢查用
    pub fn has(&self, tag: &str) -> bool {
        let key = tag.trim().replace(' ', "_").to_lowercase();
        !key.is_empty() && self.count.contains_key(&key)
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty() && self.zh_rows.is_empty()
    }

    fn cnt(&self, en: &str) -> i64 {
        *self
            .count
            .get(&en.replace(' ', "_").to_lowercase())
            .unwrap_or(&0)
    }

    pub fn search(&self, q: &str, limit: usize) -> Vec<Value> {
        let q = q.trim();
        if q.is_empty() {
            return vec![];
        }
        let mut out = vec![];
        if CJK.is_match(q) {
            // 對照表是繁體。輸入含繁體專用字（折成簡體會變）就照舊只比原文，結果跟以前完全一樣；
            // 輸入是簡體（折了不變）才多比一次折成簡體的對照表，這些命中排在原文命中後面（長发 → 長髮、后入 → 後入式）
            let simp = fold_zh(q) == q;
            let mut hits: Vec<(u8, &(String, String))> = vec![];
            for (i, row) in self.zh_rows.iter().enumerate() {
                let rank = if row.0.starts_with(q) {
                    0
                } else if row.0.contains(q) {
                    1
                } else if simp && self.zh_fold[i].starts_with(q) {
                    2
                } else if simp && self.zh_fold[i].contains(q) {
                    3
                } else {
                    continue;
                };
                hits.push((rank, row));
            }
            hits.sort_by_key(|(rank, (_, en))| (*rank, -self.cnt(en)));
            let mut seen = HashSet::new();
            for (_, (zh, en)) in hits {
                if !seen.insert(en.to_lowercase()) {
                    continue;
                }
                out.push(json!({"tag": en.replace('_', " "), "zh": zh, "count": self.cnt(en), "cat": "中文"}));
                if out.len() >= limit {
                    break;
                }
            }
            return out;
        }
        let key = q.to_lowercase().replace(' ', "_");
        let (mut pre, mut sub) = (vec![], vec![]);
        for (tag, cat, cnt, aliases) in &self.rows {
            if tag.starts_with(&key) {
                pre.push((tag, *cat, *cnt, None));
            } else if let Some(a) = aliases.iter().find(|a| a.starts_with(&key)) {
                pre.push((tag, *cat, *cnt, Some(a)));
            } else if key.chars().count() >= 3 && tag.contains(&key) {
                sub.push((tag, *cat, *cnt, None));
            }
        }
        pre.sort_by_key(|r| -r.2);
        sub.sort_by_key(|r| -r.2);
        for (tag, cat, cnt, alias) in pre.into_iter().chain(sub).take(limit) {
            out.push(json!({"tag": tag.replace('_', " "), "zh": self.zh.get(tag.as_str()).cloned().unwrap_or_default(),
                            "count": cnt, "cat": cat_name(cat), "alias": alias}));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> TagIndex {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
            .join("tags");
        TagIndex::load(&dir)
    }

    /// 改動前的中文搜尋（原文 contains、原文開頭的排前面、再依使用次數），拿來證明繁體輸入的結果沒變
    fn legacy_cjk(ix: &TagIndex, q: &str, limit: usize) -> Vec<(String, String)> {
        let mut hits: Vec<&(String, String)> =
            ix.zh_rows.iter().filter(|(zh, _)| zh.contains(q)).collect();
        hits.sort_by_key(|(zh, en)| (!zh.starts_with(q), -ix.cnt(en)));
        let mut seen = HashSet::new();
        hits.into_iter()
            .filter(|(_, en)| seen.insert(en.to_lowercase()))
            .take(limit)
            .map(|(zh, en)| (en.replace('_', " "), zh.clone()))
            .collect()
    }

    fn found(ix: &TagIndex, q: &str, limit: usize) -> Vec<(String, String)> {
        ix.search(q, limit)
            .iter()
            .map(|v| {
                (
                    v["tag"].as_str().unwrap().to_string(),
                    v["zh"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn has_matches_space_or_underscore() {
        let ix = index();
        assert!(ix.has("orange hair"));
        assert!(ix.has("orange_hair"));
        assert!(ix.has(" Orange Hair "));
        assert!(!ix.has("not a tag zz"));
        assert!(!ix.has(""));
    }

    #[test]
    fn fold_table_loads() {
        assert!(T2S.len() > 3000, "{}", T2S.len());
        assert_eq!(fold_zh("長髮"), "长发");
        assert_eq!(fold_zh("長發"), "长发"); // 髮、發折在一起
        assert_eq!(fold_zh("傳教士體位"), "传教士体位");
        assert_eq!(fold_zh("长发 long_hair"), "长发 long_hair"); // 簡體、英文原樣
    }

    #[test]
    fn simplified_finds_same_tags_as_traditional() {
        let ix = index();
        assert!(!ix.is_empty());
        let tr = found(&ix, "長髮", 12);
        assert_eq!(tr[0].0, "long hair");
        assert_eq!(found(&ix, "长发", 12), tr);
        for (simp, trad, tag) in [
            ("后入", "後入", "sex from behind"),
            ("蓝眼", "藍眼", "blue eyes"),
            ("内裤", "內褲", "panties"),
            ("头发", "頭髮", "hair between eyes"),
        ] {
            let s = found(&ix, simp, 40);
            assert!(s.iter().any(|(t, _)| t == tag), "{simp}: {s:?}");
            assert_eq!(
                s.iter().take(5).collect::<Vec<_>>(),
                found(&ix, trad, 40).iter().take(5).collect::<Vec<_>>(),
                "{simp}"
            );
        }
        // 英文查詢不受影響
        assert_eq!(ix.search("long_ha", 3)[0]["tag"], "long hair");
    }

    #[test]
    fn traditional_queries_unchanged() {
        let ix = index();
        // 含繁體專用字的查詢：結果跟改動前逐筆相同
        for q in [
            "長髮",
            "藍眼",
            "頭髮",
            "內褲",
            "後入式",
            "體位",
            "騎乘",
            "臉紅",
            "雙馬尾",
            "看向觀眾",
            "裡",
            "乾",
            "髮",
        ] {
            let old = legacy_cjk(&ix, q, 12);
            assert!(
                !old.is_empty(),
                "{q} 在對照表裡要有東西，不然這個測試什麼都沒證明"
            );
            assert_eq!(found(&ix, q, 12), old, "{q}");
        }
        // 繁簡同形的字（簡體輸入也可能是它）：改動前的命中照原順序排在最前面，只可能在後面多出簡體命中
        for q in ["笑", "面", "后", "里"] {
            let old = legacy_cjk(&ix, q, 12);
            let new = found(&ix, q, 12);
            assert_eq!(
                new[..old.len().min(new.len())],
                old[..old.len().min(new.len())],
                "{q}"
            );
        }
    }
}
