//! 節點圖 golden test：tests/make_golden_graphs.py 用舊版 Python 產生的結果，Rust 必須完全一樣。
mod common;

use anima_app::graphs;
use common::{first_diff, golden_dir};
use serde_json::Value;

#[test]
fn graphs_match_python() {
    let dir = golden_dir();
    let data: Vec<Value> = serde_json::from_str(
        &std::fs::read_to_string(dir.join("golden_graphs.json"))
            .expect("先跑 make_golden_graphs.py"),
    )
    .unwrap();
    let input = dir.join("input");
    let mut fails = vec![];
    for c in &data {
        let name = c["name"].as_str().unwrap();
        let got = graphs::build(&c["params"], &input, c["offset"].as_i64().unwrap());
        match (c.get("error"), got) {
            (Some(e), Err(g)) => {
                if e.as_str() != Some(g.0.as_str()) {
                    fails.push(format!("[{name}] 錯誤訊息不同：python={e} rust={}", g.0));
                }
            }
            (Some(e), Ok(_)) => fails.push(format!("[{name}] python 報錯 {e}，rust 卻成功")),
            (None, Err(g)) => fails.push(format!("[{name}] rust 報錯：{}", g.0)),
            (None, Ok((nodes, info))) => {
                if let Some(d) = first_diff(&c["nodes"], &Value::Object(nodes), "nodes") {
                    fails.push(format!("[{name}] {d}"));
                }
                if let Some(d) = first_diff(&c["info"], &info, "info") {
                    fails.push(format!("[{name}] {d}"));
                }
            }
        }
    }
    println!("{} 個案例，{} 個不一致", data.len(), fails.len());
    assert!(fails.is_empty(), "\n{}", fails.join("\n"));
}
