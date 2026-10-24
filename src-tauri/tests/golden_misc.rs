//! 零碎純函式 golden test：tests/make_golden_misc.py 用舊版 Python 產生的結果。
mod common;

use anima_app::comfy;
use common::golden_dir;
use serde_json::Value;

fn load() -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(golden_dir().join("golden_misc.json"))
            .expect("先跑 make_golden_misc.py"),
    )
    .unwrap()
}

/// 舊站 golden 訊息 → 桌面版刻意改過的說法
fn desktop(s: &str) -> String {
    // 舊站指向已不存在的 .bat；桌面版改為重新開啟應用程式。
    s.replace("重新執行桌面的「Anima 生圖.bat」", "重新開啟「繪匣 PaintDeck」")
        // 「找不到模型或 LoRA」加了匯入工作流的說明（第五十六、五十七筆）
        .replace(
            "找不到選的模型或 LoRA 檔（可能被移走或改名）。解法：LoRA 分頁按「重新整理清單」，重新選一次模型／LoRA。",
            "找不到選的模型或 LoRA 檔（可能被移走或改名；匯入的工作流也可能寫著你沒有的檔）。解法：LoRA 分頁按「重新整理清單」，重新選一次模型／LoRA；用「⚙ 生圖工作流」時，到左欄「工作流參數」把標紅的欄位換成你有的檔（檔名在下面的原始訊息裡）。",
        )
}

#[test]
fn friendly_and_explain_match_python() {
    let data = load();
    let mut fails = vec![];
    for c in data["friendly"].as_array().unwrap() {
        let got = comfy::friendly(c[0].as_str().unwrap());
        if got != desktop(c[1].as_str().unwrap()) {
            fails.push(format!("friendly({})\n python={}\n rust={got}", c[0], c[1]));
        }
    }
    for c in data["explain"].as_array().unwrap() {
        let got = comfy::explain(&c[0]);
        if got != desktop(c[1].as_str().unwrap()) {
            fails.push(format!("explain({})\n python={}\n rust={got}", c[0], c[1]));
        }
    }
    assert!(fails.is_empty(), "\n{}", fails.join("\n"));
}
