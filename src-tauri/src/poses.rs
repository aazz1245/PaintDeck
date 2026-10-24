//! 姿勢大彙整（resources\poses\poses.json）：成人改寫用的「姿勢小抄」。
//!
//! 2026-10-10 實測：改寫模型只看到「傳教士體位」這種名稱會亂擺（通用版 Qwen3.5 甚至把傳教士寫成女上），
//! 專用改寫模型（Pe_T2I_Heretic）則會把性行為洗白成穿衣服抱著。可行做法是：
//! 程式找出姿勢 → 通用版只寫開頭句和人物／場景／光線 → 姿勢的幾何描述（geometry_en）原封不動插在中間。
//! 四種體位 × 兩個種子 16／16 擺對（報告\Qwen-Image-2.1-Turbo資料_20261010.md）。
use crate::tags::fold_zh;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Pose {
    pub id: String,
    pub zh: String,
    pub category: String,
    pub people: String,
    pub acts: Vec<String>,
    pub names: Vec<String>, // aliases＋triggers＋中文名（比對用）
    pub english: Vec<String>,
    pub camera: String,
    pub orientation: String,
    pub geometry: String,
    pub geometry_zh: String,
    pub danbooru: Vec<String>, // 給 Anima 的姿勢 tag（2026-10-10 用 Danbooru API 驗證過都存在）
    pub control: Option<Control>,
}

#[derive(Debug, Clone)]
pub struct Control {
    pub depth: String,
    pub pose: String,
    pub camera: String,
    pub orientation: String,
}

#[derive(Debug, Default)]
pub struct Poses {
    pub list: Vec<Pose>,
    pub dir: PathBuf,
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 第一人稱的說法（想法裡出現就把鏡頭改成男方視角）
const POV: [&str; 6] = [
    "視角",
    "pov",
    "第一人稱",
    "主觀",
    "point of view",
    "point-of-view",
];

impl Poses {
    pub fn load(res: &Path) -> Poses {
        let dir = res.join("poses");
        let v: Value = std::fs::read(dir.join("poses.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(json!({}));
        let s = |e: &Value, k: &str| e[k].as_str().unwrap_or("").trim().to_string();
        let list = v["poses"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| {
                let id = s(e, "id");
                let geometry = s(e, "geometry_en");
                if id.is_empty() || geometry.is_empty() {
                    return None;
                }
                let zh = s(e, "zh");
                let aliases = strs(&e["aliases"]);
                let mut names = aliases.clone();
                names.extend(strs(&e["triggers"]));
                names.push(zh.split('（').next().unwrap_or("").trim().to_string());
                names.retain(|n| n.chars().count() >= 2);
                let english = aliases
                    .iter()
                    .filter(|a| a.is_ascii() && !a.contains('_'))
                    .cloned()
                    .collect();
                let control = e.get("control").filter(|c| c.is_object()).map(|c| Control {
                    depth: s(c, "depth"),
                    pose: s(c, "pose"),
                    camera: s(c, "camera_en"),
                    orientation: s(c, "orientation"),
                });
                Some(Pose {
                    id,
                    zh,
                    category: s(e, "category"),
                    people: s(e, "people"),
                    acts: strs(&e["acts"]),
                    names,
                    english,
                    camera: s(e, "camera_en"),
                    orientation: s(e, "orientation"),
                    geometry,
                    geometry_zh: s(e, "geometry_zh"),
                    danbooru: strs(&e["danbooru"]),
                    control,
                })
            })
            .collect();
        Poses { list, dir }
    }

    pub fn get(&self, id: &str) -> Option<&Pose> {
        self.list.iter().find(|p| p.id == id)
    }

    /// 在想法裡找姿勢名稱或口語說法，取最長的那個（「反向騎乘」優先於「騎乘」）。
    /// 名稱是繁體，想法可能是簡體：原文比不到的，再把雙方折成簡體比一次（传教士体位 → 傳教士體位）
    pub fn find(&self, idea: &str) -> Option<(&Pose, String)> {
        let low = idea.to_lowercase();
        let low_s = fold_zh(&low);
        let mut best: Option<(&Pose, &String)> = None;
        for p in &self.list {
            for n in &p.names {
                let nl = n.to_lowercase();
                if (low.contains(&nl) || low_s.contains(&fold_zh(&nl)))
                    && best.is_none_or(|(_, b)| n.chars().count() > b.chars().count())
                {
                    best = Some((p, n));
                }
            }
        }
        best.map(|(p, n)| (p, n.clone()))
    }

    /// 給模型挑姿勢用的目錄：一行一筆「id｜中文名｜英文名」
    pub fn catalog(&self) -> String {
        self.list
            .iter()
            .map(|p| {
                format!(
                    "{} | {} | {}",
                    p.id,
                    p.zh,
                    p.english.first().map(String::as_str).unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 選單用
    pub fn menu(&self) -> Value {
        json!(self
            .list
            .iter()
            .map(
                |p| json!({"id": p.id, "zh": p.zh, "category": p.category, "people": p.people,
                            "control": p.control.is_some(), "desc": p.geometry_zh})
            )
            .collect::<Vec<_>>())
    }
}

/// 想法裡有性行為的字眼才讓模型從目錄挑（實測：「裸女泡澡」也被挑成自慰）
const SEXUAL: [&str; 34] = [
    "做愛",
    "性交",
    "性愛",
    "插入",
    "抽插",
    "口交",
    "舔",
    "幹",
    "上床",
    "高潮",
    "體位",
    "姿勢",
    "自慰",
    "手淫",
    "騎",
    "後入",
    "內射",
    "肛交",
    "乳交",
    "足交",
    "素股",
    "磨",
    "愛撫",
    "sex",
    "fuck",
    "blowjob",
    "fellatio",
    "cunnilingus",
    "penetrat",
    "intercourse",
    "masturbat",
    "handjob",
    "riding",
    "position",
];

/// 想法裡有沒有 keys 的其中一個字眼（keys 是繁體或英文）：原文比不到的，再把雙方折成簡體比一次，簡體輸入也認得。
/// 「幹」不折：乾、幹、干都會折成「干」，繁體的「乾淨」會被當成性字眼
fn mentions(idea: &str, keys: &[&str]) -> bool {
    let low = idea.to_lowercase();
    let low_s = fold_zh(&low);
    keys.iter()
        .any(|k| low.contains(k) || (*k != "幹" && low_s.contains(&fold_zh(k))))
}

pub fn looks_sexual(idea: &str) -> bool {
    mentions(idea, &SEXUAL)
}

/// 模型偶爾會寫 girl／boy：一律換成 woman／man（只換整個字，大小寫照原文）
pub fn adultify(text: &str) -> String {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\b([Gg]irl|[Bb]oy)(s?)\b").unwrap());
    RE.replace_all(text, |c: &regex::Captures| {
        let w = match &c[1] {
            "girl" => "woman",
            "Girl" => "Woman",
            "boy" => "man",
            _ => "Man",
        };
        if c[2].is_empty() {
            w.to_string()
        } else {
            w.replace("man", "men") // women／men
        }
    })
    .into_owned()
}

/// 成人模式 Anima 的 tag 裡會讓人物看起來像小孩的字：一律拿掉（模型輸出、使用者自訂規則都過這一關）。
/// 整個詞比對：babydoll（睡衣）、childhood friend、kidney 不算。petite、flat chest、young 是成年人也會用的描述，不擋
fn childlike(tag: &str) -> bool {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(loli|lolicon|shota|shotacon|child|children|kids?|toddlers?|aged down|bab(y|ies)|elementary)\b").unwrap()
    });
    RE.is_match(&tag.replace('_', " "))
}

/// 模型會自己編畫師（@artgerm…）：想法裡沒寫到的 @畫師 一律拿掉
fn artist_ok(tag: &str, idea: &str) -> bool {
    match tag.strip_prefix('@') {
        Some(name) => idea.to_lowercase().contains(&name.trim().to_lowercase()),
        None => true,
    }
}

/// 沒對到姿勢時整段由模型寫：每一行像 tag 列的（逗號多）把小孩樣的 tag、想法裡沒有的畫師拿掉，底線換空格；
/// 句子（整行，或 tag 列裡超過 6 個字的那段）只做 girl／boy → woman／man
pub fn safe_anima(text: &str, idea: &str) -> String {
    text.lines()
        .map(|line| {
            if line.matches(',').count() >= 3 {
                static SCORE: std::sync::LazyLock<regex::Regex> =
                    std::sync::LazyLock::new(|| regex::Regex::new(r"^score_[1-9]$").unwrap());
                line.split(',')
                    // 夾在段落中間的 @畫師（"anime style @Yoruji"）也要檢查
                    .map(|t| {
                        t.split_whitespace()
                            .filter(|w| artist_ok(w, idea))
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .filter(|t| !t.is_empty())
                    .filter_map(|t| {
                        if t.split_whitespace().count() > 6 {
                            Some(adultify(&t))
                        } else if childlike(&t) {
                            None
                        } else if t.starts_with("score_") {
                            // 模型會編 score_8_5 這種不存在的
                            SCORE.is_match(&t).then_some(t)
                        } else {
                            Some(t.replace('_', " "))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                adultify(line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 逗號分隔的 tag：去掉小孩樣的、品質／評級／人數這類程式會自己加的，再去重複
pub fn clean_tags(tags: &str, have: &[String], idea: &str) -> Vec<String> {
    const OURS: [&str; 12] = [
        "masterpiece",
        "best quality",
        "score_",
        "safe",
        "sensitive",
        "nsfw",
        "explicit",
        "1girl",
        "1boy",
        "2girls",
        "2boys",
        "solo",
    ];
    let mut out: Vec<String> = Vec::new();
    for t in tags.split([',', '\n']) {
        let t = t
            .trim()
            .trim_matches(|c| c == '.' || c == '"')
            .replace('_', " ")
            .to_lowercase();
        // 「… position」這類姿勢名稱程式已經用正式 tag 加過了，模型自己寫的不要
        if t.is_empty()
            || t.len() > 60
            || t.ends_with("position")
            || !artist_ok(&t, idea)
            || childlike(&t)
            || OURS.iter().any(|k| t.starts_with(k))
        {
            continue;
        }
        if !have.contains(&t) && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

pub fn is_pov(idea: &str) -> bool {
    mentions(idea, &POV)
}

impl Pose {
    pub fn penetrative(&self) -> bool {
        self.acts.iter().any(|a| a == "vaginal" || a == "anal")
    }

    /// 開頭句要用的性行為名稱：程式填，不讓模型自己寫（實測模型會把騎乘寫成口交）
    pub fn act_phrase(&self) -> String {
        let name = self
            .english
            .iter()
            .find(|a| a.contains(' '))
            .or(self.english.first())
            .cloned()
            .unwrap_or_else(|| self.zh.clone())
            .to_lowercase();
        if self.penetrative() {
            let pos = if name.contains("position") {
                ""
            } else {
                " position"
            };
            format!("having sex in the {name}{pos}")
        } else {
            name
        }
    }

    /// (鏡頭, 方向)：開了姿勢參考圖以參考圖為準，其次是想法裡的第一人稱，最後是大彙整的建議
    pub fn camera(&self, idea: &str, use_control: bool) -> (String, String) {
        if let Some(c) = self.control.as_ref().filter(|_| use_control) {
            return (c.camera.clone(), c.orientation.clone());
        }
        if is_pov(idea) {
            return (
                "a point-of-view shot from the man's eyes, looking at her".into(),
                "vertical".into(),
            );
        }
        (self.camera.clone(), self.orientation.clone())
    }

    /// 插入類（一男一女）補一句：實測背後式常畫成男方手握陰莖、兩人中間有空隙
    pub fn contact_sentence(&self) -> String {
        if !self.penetrative() || self.people != "M+F" {
            return String::new();
        }
        let hole = if self.acts.iter().any(|a| a == "vaginal") {
            "vagina"
        } else {
            "anus"
        };
        format!(
            " There is no gap between their bodies: his hips are pressed flat against her body, his penis is hidden inside her {hole} \
             except for the very base, and both of his hands rest on her body, never holding his penis."
        )
    }

    /// 開頭句＋幾何描述（原文）＋接觸句＋細節
    pub fn assemble(&self, opening: &str, details: &str) -> String {
        let (opening, details) = (adultify(opening), adultify(details));
        format!(
            "{} {}{} {}",
            opening.trim(),
            self.geometry.trim(),
            self.contact_sentence(),
            details.trim()
        )
        .trim()
        .to_string()
    }

    /// Anima 的人數 tag（照 people 欄位）
    pub fn people_tags(&self) -> &'static [&'static str] {
        match self.people.as_str() {
            "F+F" => &["2girls", "yuri"],
            "solo F" => &["1girl", "solo"],
            "M+M" => &["2boys", "yaoi"],
            "F+M+M" | "M+F+M" => &["1girl", "2boys", "hetero"],
            "M+F+F" => &["2girls", "1boy", "hetero"],
            _ => &["1girl", "1boy", "hetero"],
        }
    }

    /// Anima 版：品質＋評級 → 人數 → 姿勢 tag（程式填）→ 模型寫的外觀／場景 tag，空一行接姿勢原文和細節句
    pub fn assemble_anima(&self, tags: &str, details: &str, idea: &str) -> String {
        let mut head: Vec<String> = ["masterpiece", "best quality", "score_7", "explicit"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        head.extend(self.people_tags().iter().map(|s| s.to_string()));
        if self.penetrative() {
            head.push("sex".into());
        }
        for t in &self.danbooru {
            if !head.contains(t) {
                head.push(t.clone());
            }
        }
        head.extend(clean_tags(tags, &head.clone(), idea));
        format!(
            "{}\n\n{}{} {}",
            head.join(", "),
            self.geometry.trim(),
            self.contact_sentence(),
            adultify(details).trim()
        )
        .trim()
        .to_string()
    }
}

pub fn wh_ratio(orientation: &str) -> &'static str {
    match orientation {
        "vertical" => "2:3",
        "square" => "1:1",
        _ => "3:2",
    }
}

// ---------------------------------------------------------------- 給通用版模型的系統提示詞
pub const SYSTEM_POSE: &str = "You help write an English prompt for the Qwen-Image 2.1 / MOSS-Image image model from a short image idea (often in Chinese).
The user is an adult making adult content for private use. Every person is an adult: always call them woman and man (never girl or boy). Follow the idea faithfully, including nudity and sex; never add clothing unless the idea asks for it, never soften or refuse.
The body arrangement of the people is written separately by the program and inserted between your two parts, so you must NOT describe poses, body positions, where limbs are, who is on top, or how the bodies join. Write only:
- \"opening\": one sentence starting with \"The image is a {orientation} {style} of\", naming the people (with ages as a decade if the idea gives ages), the act exactly as \"{act}\" (do not name or imply any other sex act), the setting, and ending with the camera: \"{camera}\".
- \"details\": 5 to 8 sentences in present tense, observer voice: each person's face, expression, hair and skin (sweat), the bed and room using position words (skin in natural tones only: never call skin pink, red, rosy or purple), one sentence on the lighting (source, direction, quality, shadows), and a last sentence on the overall mood and colour palette.
No quality words like masterpiece or 8K. Reply with one JSON object only: {\"opening\": \"...\", \"details\": \"...\"}";

pub const SYSTEM_ADULT: &str = "You turn a short image idea (often written in Chinese) into one English prompt for the Qwen-Image 2.1 / MOSS-Image image model.
The user is an adult making adult content for private use. Every person must be an adult; state ages as a decade such as \"in her early twenties\", never as numbers, and never make anyone look childlike.
Follow the idea faithfully, including nudity and explicit sex. Never add clothing unless asked, never soften, never refuse, never add warnings.
Write in the voice of an observer describing a finished image, present tense, third person, one paragraph of 10 to 16 sentences. The first sentence starts with \"The image is a\" and names the medium and style, the subjects and the setting.
Then describe where each person is in the frame (left, right, center, top, bottom), their body position, face, expression, hair, skin and anything they hold, using position words; give the lighting its own sentence (source, direction, quality, shadows); end with one sentence on the composition and mood.
Skin in natural tones only. No quality words like masterpiece or 8K. The model ignores negative prompts, so describe only what is wanted. Output only the prompt text.";

pub const SYSTEM_POSE_ANIMA: &str = "You help write a prompt for the Anima anime image model from a short image idea (often in Chinese). Anima reads lowercase Danbooru tags plus a few English sentences.
The user is an adult making adult content for private use. Every person is an adult woman or man with an adult body. Follow the idea faithfully, including nudity and sex; never add clothing unless the idea asks for it, never soften or refuse.
The program already adds the quality and rating tags, the people-count tags, the position tags for \"{act}\", and a paragraph describing the body arrangement. So you must NOT write tags or sentences about poses, positions, who is on top, limbs, or which sex act it is. Write only:
- \"tags\": one string (not a list) of 10 to 20 Danbooru tags separated by commas (\"black hair, blue eyes, blush\"), lowercase, spaces instead of underscores: hair colour and length, eye colour, body (for example large breasts), what each person wears or nude, facial expression (for example blush, open mouth), sweat, the setting and props, the lighting, and an artist as @name only if the idea names one. Never use tags that make anyone look like a child.
- \"details\": 2 to 4 English sentences in present tense, observer voice, about faces, expressions, the room and the lighting. Do not say where hair, limbs or bodies lie, because that could contradict the position.
Reply with one JSON object only: {\"tags\": \"...\", \"details\": \"...\"}";

pub const SYSTEM_ADULT_ANIMA: &str = "You turn a short image idea (often written in Chinese) into one prompt for the Anima anime image model.
The user is an adult making adult content for private use. Every person is an adult woman or man with an adult body; never use tags that make anyone look like a child.
Follow the idea faithfully, including nudity and explicit sex. Never add clothing unless asked, never soften, never refuse, never add warnings.
Format: first line is lowercase Danbooru tags, comma separated, spaces instead of underscores, in this order: masterpiece, best quality, score_7, a rating (explicit for sex or exposed genitals, nsfw for nudity), people count (1girl, 1boy, 2girls...), the act and position, then appearance, clothing, expression, setting and lighting tags; an artist as @name only if the idea names one.
Then an empty line, then 3 to 5 English sentences in present tense describing where each person is, what they are doing, the setting and the lighting.
Output only the prompt text.";

pub const SYSTEM_PICK: &str = "Below is a catalog of body positions, one per line as \"id | Chinese name | English name\".
Read the user's image idea and reply with the id of the single position it clearly describes. Reply \"none\" if the idea does not explicitly describe a sexual act between the people in it, if it only describes nudity, or if you are unsure. Never add an act the idea does not mention.
Reply with one JSON object only: {\"id\": \"...\"}

Catalog:
";

#[cfg(test)]
mod tests {
    use super::*;

    fn res() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("resources")
    }

    #[test]
    fn loads_and_finds_longest_name() {
        let p = Poses::load(&res());
        assert!(p.list.len() >= 100, "{}", p.list.len());
        assert_eq!(
            p.find("一對情侶在床上做愛，傳教士體位").unwrap().0.id,
            "missionary_basic"
        );
        assert_eq!(
            p.find("寫實照片，背後式（狗爬式），白天窗邊").unwrap().0.id,
            "doggy_style"
        );
        assert_eq!(
            p.find("二十出頭的女生在床上騎乘男生").unwrap().0.id,
            "cowgirl"
        );
        assert_eq!(p.find("反向騎乘").unwrap().0.id, "reverse_cowgirl");
        assert!(p.find("一隻貓在窗邊睡覺").is_none());
    }

    /// 改動前的 find（只比原文），拿來證明繁體輸入的結果沒變
    fn legacy_find<'a>(p: &'a Poses, idea: &str) -> Option<(&'a Pose, String)> {
        let low = idea.to_lowercase();
        let mut best: Option<(&Pose, &String)> = None;
        for pose in &p.list {
            for n in &pose.names {
                if low.contains(&n.to_lowercase())
                    && best.is_none_or(|(_, b)| n.chars().count() > b.chars().count())
                {
                    best = Some((pose, n));
                }
            }
        }
        best.map(|(pose, n)| (pose, n.clone()))
    }

    #[test]
    fn simplified_input_finds_poses() {
        let p = Poses::load(&res());
        // 姿勢名稱是繁體，簡體想法也要找得到同一個姿勢
        for (simp, trad, id) in [
            (
                "一对情侣在床上做爱，传教士体位",
                "一對情侶在床上做愛，傳教士體位",
                "missionary_basic",
            ),
            (
                "写实照片，背后式（狗爬式），白天窗边",
                "寫實照片，背後式（狗爬式），白天窗邊",
                "doggy_style",
            ),
            (
                "二十出头的女生在床上骑乘男生",
                "二十出頭的女生在床上騎乘男生",
                "cowgirl",
            ),
            ("反向骑乘", "反向騎乘", "reverse_cowgirl"),
        ] {
            let (s, t) = (p.find(simp).unwrap(), p.find(trad).unwrap());
            assert_eq!(s.0.id, id, "{simp}");
            assert_eq!((&s.0.id, &s.1), (&t.0.id, &t.1), "{simp}");
        }
        assert!(p.find("一只猫在窗边睡觉").is_none());
        // 每個姓名的簡體寫法都要找得到（找到的名稱不會比它短）
        for pose in &p.list {
            for n in &pose.names {
                let simp = fold_zh(n);
                let got = p
                    .find(&simp)
                    .unwrap_or_else(|| panic!("{} 的簡體寫法 {simp} 找不到", pose.id));
                assert!(
                    got.1.chars().count() >= n.chars().count(),
                    "{simp} → {}",
                    got.1
                );
            }
        }
    }

    #[test]
    fn traditional_input_unchanged() {
        let p = Poses::load(&res());
        // 繁體的名稱、句子：跟改動前逐筆相同
        let mut ideas: Vec<String> = p.list.iter().flat_map(|x| x.names.clone()).collect();
        ideas.extend(
            [
                "一對情侶在床上做愛，傳教士體位",
                "寫實照片，背後式（狗爬式），白天窗邊",
                "二十出頭的女生在床上騎乘男生",
                "反向騎乘",
                "一隻貓在窗邊睡覺",
                "乾淨的房間裡一個女生，皇后坐在椅子上",
            ]
            .map(String::from),
        );
        for idea in &ideas {
            let (old, new) = (legacy_find(&p, idea), p.find(idea));
            assert_eq!(
                old.map(|(x, n)| (x.id.clone(), n)),
                new.map(|(x, n)| (x.id.clone(), n)),
                "{idea}"
            );
        }
    }

    #[test]
    fn simplified_gates() {
        assert!(looks_sexual("一对情侣在床上做爱"));
        assert!(looks_sexual("她骑在他身上"));
        assert!(looks_sexual("一對情侶在床上做愛")); // 繁體照舊
        assert!(!looks_sexual("写实照片，女生全裸躺在浴缸里，泡泡"));
        // 乾、幹、干折成同一個字：繁體的「乾淨」、簡體的「干净」不能被當成性字眼
        assert!(!looks_sexual("乾淨的房間裡一個女生") && !looks_sexual("干净的房间里一个女生"));
        assert!(looks_sexual("幹她")); // 原文的「幹」照舊算
        assert!(is_pov("男生视角往上看") && is_pov("第一人称") && is_pov("男生視角往上看"));
        assert!(!is_pov("全身照"));
        let p = Poses::load(&res());
        assert_eq!(
            p.get("cowgirl").unwrap().camera("男生视角往上看", false).1,
            "vertical"
        );
    }

    #[test]
    fn act_and_camera() {
        let p = Poses::load(&res());
        let m = p.get("missionary_basic").unwrap();
        assert_eq!(m.act_phrase(), "having sex in the missionary position");
        let c = p.get("cowgirl").unwrap();
        assert_eq!(c.camera("男生視角往上看", false).1, "vertical");
        assert!(c.camera("", true).0.contains("point-of-view")); // 參考圖是第一人稱
        let s = m.assemble("Open.", "Details.");
        assert!(s.starts_with("Open. ") && s.ends_with(" Details.") && s.contains("no gap"));
        assert_eq!(wh_ratio("vertical"), "2:3");
    }

    #[test]
    fn anima_assembly() {
        let p = Poses::load(&res());
        assert!(
            p.list.iter().all(|x| !x.danbooru.is_empty()),
            "每個姿勢都要有 danbooru tag"
        );
        let m = p.get("missionary_basic").unwrap();
        let s = m.assemble_anima(
            "black hair, Long_Hair, loli, petite, 1girl, explicit, missionary, blush, @artgerm",
            "A girl smiles.",
            "傳教士",
        );
        let (tags, rest) = s.split_once("\n\n").unwrap();
        assert!(tags.starts_with("masterpiece, best quality, score_7, explicit, 1girl, 1boy, hetero, sex, missionary, vaginal, black hair, long hair, petite, blush"), "{tags}");
        assert!(
            !tags.contains("loli")
                && tags.contains("petite")
                && tags.matches("missionary").count() == 1
        );
        assert!(rest.contains("no gap") && rest.ends_with("A woman smiles."));
        assert_eq!(
            p.get("tribadism_scissoring").unwrap().people_tags(),
            ["2girls", "yuri"]
        );
        assert_eq!(safe_anima("masterpiece, score_7, 1girl, loli, short_silver_hair, @artgerm, @kyomu\nA girl lies down.", "@kyomu 畫風"), "masterpiece, score_7, 1girl, short silver hair, @kyomu\nA woman lies down.");
    }

    #[test]
    fn adult_words_and_gate() {
        assert_eq!(
            adultify("a red-haired girl and a boy; Girls, boys, girlfriend"),
            "a red-haired woman and a man; Women, men, girlfriend"
        );
        assert!(looks_sexual("一對情侶在床上做愛"));
        assert!(!looks_sexual("寫實照片，女生全裸躺在浴缸裡，泡泡"));
    }
}
