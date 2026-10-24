//! 角色設定圖工坊（design\角色設定圖工坊_設計.md）：
//! 一張全身定稿圖 → Qwen 2.1 多圖參考（<image1>＝定稿）展開成「全身轉身圖」「臉部特寫表」。
//! 這裡只有純函式：兩種版面的提示詞和尺寸、文字起點的定稿補字、反推 tag 只留外觀類。
//! 生圖本身走既有 /api/generate（txt2img／multiref／sheet），存檔走資產庫 API。
//! 2026-10-24 實測（D:\AI\小克工作區\測試區\charsheet\run.py，官方 Turbo 8 步）：兩個測試角色、兩個種子，結果見設計第 8 節。

/// 全身轉身圖的輸出尺寸（橫的，五個全身一排）
pub const TURN_W: u32 = 1664;
pub const TURN_H: u32 = 928;
/// 臉部特寫表的輸出尺寸（三欄兩列）
pub const FACE_W: u32 = 1344;
pub const FACE_H: u32 = 1344;

const TURN: &str = "A professional character turnaround reference sheet of {who}. Five full-body views of the same character stand side by side \
in one row on a plain light gray background, from left to right: front view, three-quarter front view, side view in profile, \
three-quarter back view, and back view. Every view shows the whole body from head to feet at exactly the same height and scale, \
feet on the same ground line, standing in a relaxed A-pose with the arms slightly away from the body. The face, hairstyle, \
body proportions, outfit, colors and accessories match <image1> exactly in every view. Even flat studio lighting, no text.";
const FACE: &str = "A character expression sheet of {who}, head and shoulders only: six portraits arranged in a grid of three columns and two rows \
on a plain light gray background. Top row, all with a calm neutral expression: front view, three-quarter view, side profile view. \
Bottom row, all front view: a happy smile, an angry frown, a shy blush. The face, eye color, hairstyle, hair color and accessories \
match <image1> exactly in every portrait, every head the same size with the same lighting, no text.";
/// 生成頁是 Anima（動漫）時加的畫風字；其他家族照定稿的畫風，不加
const ANIME: &str = " Anime illustration, clean line art, cel shading.";

/// kind＝"turnaround"｜"face"，desc＝角色外觀（可空白），family＝生成頁的模型家族（anima 才加動漫畫風字）。
/// 回傳（提示詞, 寬, 高）；kind 不認得回 None
pub fn prompt(kind: &str, desc: &str, family: &str) -> Option<(String, u32, u32)> {
    let (tpl, w, h) = match kind {
        "turnaround" => (TURN, TURN_W, TURN_H),
        "face" => (FACE, FACE_W, FACE_H),
        _ => return None,
    };
    let desc = desc.trim().trim_end_matches('.');
    let who = if desc.is_empty() { "the character from <image1>".to_string() } else { format!("the character from <image1> ({desc})") };
    let mut p = tpl.replace("{who}", &who);
    if family == "anima" {
        p.push_str(ANIME);
    }
    Some((p, w, h))
}

/// 文字起點畫定稿時接在使用者文字後面的補字：全身、正面、A 字站姿、素色淺灰背景
pub fn pose_suffix(family: &str) -> &'static str {
    if family == "anima" {
        ", full body, standing, front view, arms at sides, simple background, grey background"
    } else {
        ". Full body, standing straight facing the camera in a relaxed A-pose, plain light gray background."
    }
}

/// 不是外觀的 tag：人數、姿勢、視角、構圖、表情、視線（背景另外用「結尾是 background」判斷）
const DROP: &[&str] = &[
    "1girl", "1boy", "2girls", "2boys", "multiple girls", "multiple boys", "solo", "solo focus", "full body", "upper body", "lower body",
    "cowboy shot", "portrait", "standing", "sitting", "arms at sides", "arms behind back", "hand on own hip", "hands on own hips",
    "contrapposto", "looking at viewer", "looking to the side", "looking away", "closed mouth", "open mouth", "smile", "light smile",
    "expressionless", "blush", "parted lips", "front view", "from side", "from behind", "straight-on", "turnaround",
    "multiple views", "reference sheet", "character sheet", "simple background", "shadow", "gradient", "border", "white border",
];

/// 反推回來的 tag 只留外觀（頭髮、眼睛、膚色、身材、衣服、配件、角色名）；姿勢、表情、背景、構圖、人數丟掉
pub fn filter_tags(tags: &[String]) -> Vec<String> {
    tags.iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty() && !DROP.contains(t) && !t.ends_with(" background"))
        .map(str::to_owned)
        .fold(vec![], |mut v, t| {
            if !v.contains(&t) {
                v.push(t);
            }
            v
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_kinds() {
        let (p, w, h) = prompt("turnaround", "a girl with orange hair", "anima").unwrap();
        assert!(p.contains("<image1>") && p.contains("a girl with orange hair") && p.contains("Anime illustration"));
        assert_eq!((w, h), (TURN_W, TURN_H));
        let (p, w, h) = prompt("face", "", "qwen21").unwrap();
        assert!(p.contains("<image1>") && !p.contains("Anime illustration"));
        assert_eq!((w, h), (FACE_W, FACE_H));
        assert!(prompt("x", "", "anima").is_none());
        assert!([w, h, TURN_W, TURN_H].iter().all(|v| v.is_multiple_of(32)));
    }

    #[test]
    fn suffix_by_family() {
        assert!(pose_suffix("anima").contains("full body, standing"));
        assert!(pose_suffix("other").contains("A-pose") && !pose_suffix("other").contains("grey background"));
    }

    #[test]
    fn tags_filtered() {
        let t = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            filter_tags(&t(&["1girl", "orange hair", "full body", "blue sky background", "hair ornament", "standing", "smile"])),
            t(&["orange hair", "hair ornament"])
        );
        assert!(filter_tags(&t(&["solo", "simple background", "looking at viewer"])).is_empty());
    }
}
