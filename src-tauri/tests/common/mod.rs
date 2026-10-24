//! golden test 共用：找出兩個 JSON 第一個不一樣的地方
#![allow(dead_code)] // 每個測試檔只用到其中一部分
use serde_json::Value;
use std::path::PathBuf;

pub fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("golden")
}

pub fn first_diff(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                match (x.get(k), y.get(k)) {
                    (Some(u), Some(v)) => {
                        if let Some(d) = first_diff(u, v, &format!("{path}.{k}")) {
                            return Some(d);
                        }
                    }
                    (u, v) => return Some(format!("{path}.{k}: python={u:?} rust={v:?}")),
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (u, v))| first_diff(u, v, &format!("{path}[{i}]"))),
        _ if a == b => None,
        _ => Some(format!("{path}: python={a} rust={b}")),
    }
}
