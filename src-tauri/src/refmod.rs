//! MiniMax H3 RefMod（社群外掛 Luisacaotica/ComfyUI-MiniMaxH3Mod，釘在 2026-10-27 審過的 commit）：
//! 角色卡的正面特寫做成 RefMod（ComfyUI 只用 H3 影片 VAE 編碼，不用 H3 主模型，本機就能做），
//! H3 拍片時接在條件上（Loader → Apply，插在 guider 前面）鎖臉。
//! 一張圖一個 RefMod：外掛把同一個 RefMod 的多張圖裁成同一個畫布，橫的轉身圖會被裁掉兩邊，所以轉身圖照舊當參考圖送。
use serde_json::{json, Map, Value};

pub const REPO: &str = "https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod";
pub const COMMIT: &str = "517e8c419a8584fbf69fceb487bc39d83e6a6ec8";
/// custom_nodes 底下的資料夾名
pub const DIR: &str = "ComfyUI-MiniMaxH3Mod";
/// models\refmods 底下放繪匣做的 RefMod 的子資料夾
pub const SUB: &str = "paintdeck";
/// Loader 一次最多幾個（外掛的 mod_1～mod_8）
pub const MAX_MODS: usize = 8;

/// 角色資產的 RefMod 名字（存檔名、不含副檔名）
pub fn mod_name(asset_id: i64) -> String {
    format!("pd_char_{asset_id}")
}

/// Loader 選單裡的名字：refmods 底下的相對路徑、斜線、不含 .safetensors
pub fn loader_name(name: &str) -> String {
    format!("{SUB}/{name}")
}

/// 送進節點圖的名字只收英數、底線、減號（加一層子資料夾）；擋 ..、絕對路徑
pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 120
        && !n.starts_with('/')
        && !n.contains("..")
        && !n.contains("//")
        && n.chars().all(|c| c.is_ascii_alphanumeric() || "_-/".contains(c))
}

/// 做 RefMod 的節點圖：LoadImage（input 裡的檔名）＋VAELoader（H3 影片 VAE）→ MiniMaxH3RefModExtract。
/// identity_encode 預設＝Full Reference、短邊 1024、不做優化；存到 models\refmods\paintdeck\<name>.safetensors
pub fn extract_graph(image: &str, name: &str, vae: &str, desc: &str) -> Map<String, Value> {
    let mut g = Map::new();
    g.insert("1".into(), json!({"class_type": "LoadImage", "inputs": {"image": image}}));
    g.insert("2".into(), json!({"class_type": "VAELoader", "inputs": {"vae_name": vae}}));
    g.insert(
        "3".into(),
        json!({"class_type": "MiniMaxH3RefModExtract", "inputs": {
            "name": name, "mode": "Full Reference", "concept_type": "identity",
            "refs_image.ref_image_0": ["1", 0], "vae": ["2", 0],
            "ref_resolution": 1024, "pool_h": 16, "pool_w": 16, "latent_frames": 16, "identity": 0,
            "merge": false, "motion_only": false, "multiplier": 1, "max_tokens": 5120,
            "extraction_preset": "identity_encode", "subfolder": SUB, "description": desc,
            "save": true, "budget_policy": "truncate", "background_retention": 0.0}}),
    );
    g
}

/// Loader 的輸入：照順序放 mod_1…（其他格 "(none)"）、強度 1、不重複
pub fn loader_inputs(names: &[String]) -> Value {
    let mut m = Map::new();
    m.insert("show_info".into(), json!(false));
    for i in 1..=MAX_MODS {
        m.insert(format!("mod_{i}"), json!(names.get(i - 1).map(String::as_str).unwrap_or("(none)")));
        m.insert(format!("strength_{i}"), json!(1.0));
        m.insert(format!("copies_{i}"), json!(1));
    }
    Value::Object(m)
}

/// Apply 的輸入：外掛 README 建議的身分設定（retention 1、constant＋linear＠1、不打亂、不用存的設定）
pub fn apply_inputs(conditioning: Value, mods: Value) -> Value {
    json!({"conditioning": conditioning, "mods": mods, "override": false, "retention": 1.0,
           "curve_direction": "constant", "curve_shape": "linear", "curve_value": 1.0, "scramble_seed": -1,
           "graph_preset": "(none)", "scramble_mode": "shuffle", "scramble_keep": 1, "max_total_tokens": 0, "save_preset_as": ""})
}

/// 拍攝單勾了「用 RefMod 鎖臉」：鎖定設定表、而且做過 RefMod 的角色，照角色順序
pub fn sheet_names(sheet: &Value) -> Vec<Value> {
    if sheet["refmod"] != true {
        return vec![];
    }
    sheet["cast"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["locked"] == true)
        .filter_map(|c| c["refmod"].as_str().filter(|n| !n.is_empty()).map(|n| json!(n)))
        .collect()
}

/// 參數裡的 refmods（Loader 名字的陣列；沒有這一欄就看 p.sheet，長片走這條）：去重、擋怪名字、最多 8 個
pub fn names_of(p: &Value) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let from_sheet;
    let list = match p.get("refmods") {
        Some(Value::Array(a)) => a,
        None | Some(Value::Null) => {
            from_sheet = sheet_names(&p["sheet"]);
            &from_sheet
        }
        Some(_) => return Err("refmods 要是名字的陣列".into()),
    };
    for v in list {
        let n = v.as_str().unwrap_or("").trim();
        if n.is_empty() {
            continue;
        }
        if !valid_name(n) {
            return Err(format!("RefMod 名字不對：{n}"));
        }
        if !out.iter().any(|x| x == n) {
            out.push(n.to_string());
        }
    }
    if out.len() > MAX_MODS {
        return Err(format!("RefMod 一次最多 {MAX_MODS} 個（現在 {} 個）", out.len()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_checked_and_deduped() {
        assert_eq!(mod_name(7), "pd_char_7");
        assert_eq!(loader_name("pd_char_7"), "paintdeck/pd_char_7");
        for bad in ["", "../x", "/abs", "a\\b", "a b", "a//b", "中文"] {
            assert!(!valid_name(bad), "{bad}");
        }
        let p = json!({"refmods": ["paintdeck/pd_char_7", "", "paintdeck/pd_char_7", "paintdeck/pd_char_9"]});
        assert_eq!(names_of(&p).unwrap(), ["paintdeck/pd_char_7", "paintdeck/pd_char_9"]);
        assert!(names_of(&json!({"refmods": ["../../evil"]})).is_err());
        let many: Vec<String> = (0..9).map(|i| format!("paintdeck/pd_char_{i}")).collect();
        assert!(names_of(&json!({"refmods": many})).is_err());
        assert!(names_of(&json!({})).unwrap().is_empty());
        // 長片：從拍攝單讀，只算鎖定、做過 RefMod 的角色；沒勾就沒有
        let sheet = json!({"refmod": true, "cast": [{"locked": true, "refmod": "paintdeck/pd_char_1"}, {"locked": false, "refmod": "paintdeck/pd_char_2"}, {"locked": true, "refmod": ""}]});
        assert_eq!(names_of(&json!({"sheet": sheet})).unwrap(), ["paintdeck/pd_char_1"]);
        let mut off = sheet.clone();
        off["refmod"] = json!(false);
        assert!(names_of(&json!({"sheet": off})).unwrap().is_empty());
        assert!(names_of(&json!({"sheet": sheet, "refmods": []})).unwrap().is_empty(), "明確給了就照給的");
        assert!(names_of(&json!({"refmods": "paintdeck/pd_char_7"})).is_err(), "不是陣列要報錯，不能默默不鎖");
        assert_eq!(names_of(&json!({"sheet": sheet, "refmods": null})).unwrap(), ["paintdeck/pd_char_1"]);
    }

    #[test]
    fn extract_graph_uses_identity_preset_and_h3_vae() {
        let g = extract_graph("aw_asset_7_p.png", "pd_char_7", "minimax_h3_video_vae_int8_convrot.safetensors", "silver hair");
        assert_eq!(g["1"]["inputs"]["image"], "aw_asset_7_p.png");
        assert_eq!(g["2"]["inputs"]["vae_name"], "minimax_h3_video_vae_int8_convrot.safetensors");
        let x = &g["3"]["inputs"];
        assert_eq!(g["3"]["class_type"], "MiniMaxH3RefModExtract");
        assert_eq!((x["extraction_preset"].as_str(), x["mode"].as_str(), x["concept_type"].as_str()), (Some("identity_encode"), Some("Full Reference"), Some("identity")));
        assert_eq!(x["refs_image.ref_image_0"], json!(["1", 0]));
        assert_eq!(x["vae"], json!(["2", 0]));
        assert_eq!((x["name"].as_str(), x["subfolder"].as_str(), x["save"].as_bool()), (Some("pd_char_7"), Some("paintdeck"), Some(true)));
    }

    #[test]
    fn loader_fills_slots_in_order() {
        let l = loader_inputs(&["paintdeck/a".into(), "paintdeck/b".into()]);
        assert_eq!((l["mod_1"].as_str(), l["mod_2"].as_str(), l["mod_3"].as_str(), l["mod_8"].as_str()), (Some("paintdeck/a"), Some("paintdeck/b"), Some("(none)"), Some("(none)")));
        assert_eq!((l["strength_1"].as_f64(), l["copies_8"].as_i64()), (Some(1.0), Some(1)));
        let a = apply_inputs(json!(["9", 0]), json!(["20", 0]));
        assert_eq!((a["retention"].as_f64(), a["curve_direction"].as_str(), a["scramble_seed"].as_i64(), a["override"].as_bool()), (Some(1.0), Some("constant"), Some(-1), Some(false)));
    }
}
