//! 資料庫 golden test：tests/make_golden_db.py 用舊版 db.py 跑一串操作和查詢；
//! Rust 重播同樣的操作，資料表內容、每個操作的回傳值、每個查詢結果都要一樣。
//! 另外直接讀 Python 建的 golden.db（複製一份）再查一次，確認讀舊資料庫也一樣。
mod common;

use anima_app::db::{to_sql, Db, GalleryQuery};
use common::{first_diff, golden_dir};
use rusqlite::params_from_iter;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn load() -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(golden_dir().join("golden_db.json"))
            .expect("先跑 make_golden_db.py"),
    )
    .unwrap()
}

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("anima_golden_{tag}_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&p); // 測試自己的暫存檔
    p
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}

fn opt(v: &Value) -> Option<&str> {
    v.as_str()
}

fn replay(db: &Db, op: &Value) -> Value {
    let a = &op["args"];
    match s(&op["op"]) {
        "add_job" => {
            db.add_job(s(&a[0]), &a[1], &a[2]).unwrap();
            Value::Null
        }
        "set_job" => {
            db.set_job(s(&a[0]), s(&a[1]), opt(&a[2])).unwrap();
            Value::Null
        }
        "add_image" => json!(db
            .add_image(s(&a[0]), s(&a[1]), s(&a[2]), &a[3], &a[4], opt(&a[5]))
            .unwrap()),
        "save_preset" => json!(db.save_preset(s(&a[0]), &a[1]).unwrap()),
        "set_lora_meta" => {
            db.set_lora_meta(s(&a[0]), &a[1]).unwrap();
            Value::Null
        }
        "sql" => {
            let args: Vec<_> = a[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| to_sql(Some(v)))
                .collect();
            db.run(s(&a[0]), params_from_iter(args)).unwrap();
            Value::Null
        }
        other => panic!("不認得的操作 {other}"),
    }
}

fn gallery_query(g: &Value) -> GalleryQuery {
    let text = |k: &str| g[k].as_str().map(str::to_owned);
    GalleryQuery {
        offset: g["offset"].as_i64().unwrap(),
        limit: g["limit"].as_i64().unwrap(),
        fav: g["fav"].as_bool().unwrap(),
        mode: text("mode"),
        q: text("q"),
        trash: g["trash"].as_bool().unwrap(),
        model: text("model"),
        family: text("family"),
        lora: text("lora"),
        date_from: g["date_from"].as_f64(),
        date_to: g["date_to"].as_f64(),
        sort: text("sort").unwrap(),
    }
}

fn query(db: &Db, x: &Value) -> Value {
    let a = &x["args"];
    let rows = |r: Vec<serde_json::Map<String, Value>>| {
        Value::Array(r.into_iter().map(Value::Object).collect())
    };
    match s(&x["q"]) {
        "job" => db
            .job(s(&a[0]))
            .unwrap()
            .map(Value::Object)
            .unwrap_or(Value::Null),
        "open_jobs" => json!(db.open_jobs().unwrap()),
        "jobs" => rows(db.jobs(a[0].as_i64().unwrap()).unwrap()),
        "avg_seconds" => json!(db.avg_seconds(opt(&a[0]), opt(&a[1]), 20).unwrap()),
        "image" => db
            .image(a[0].as_i64().unwrap())
            .unwrap()
            .map(Value::Object)
            .unwrap_or(Value::Null),
        "gallery" => {
            let (total, items) = db.gallery(&gallery_query(&a[0])).unwrap();
            json!({"total": total, "items": rows(items)})
        }
        "facets" => db.facets().unwrap(),
        "images_by_ids" => {
            let ids: Vec<i64> = a[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_i64().unwrap())
                .collect();
            rows(db.images_by_ids(&ids).unwrap())
        }
        "known_files" => {
            let mut v: Vec<_> = db.known_files().unwrap().into_iter().collect();
            v.sort();
            json!(v
                .into_iter()
                .map(|(a, b)| json!([a, b]))
                .collect::<Vec<_>>())
        }
        "presets" => rows(db.presets().unwrap()),
        "lora_meta" => Value::Object(db.lora_meta().unwrap()),
        other => panic!("不認得的查詢 {other}"),
    }
}

/// 資料表內容；存 JSON 的欄位解開來比（Python 保留插入順序、Rust 依鍵排序，字面可能不同但內容要一樣）
fn dump_tables(db: &Db) -> Value {
    const JSON_COLS: [&str; 4] = ["params", "info", "data", "_"];
    let mut out = json!({});
    let mut cols = json!({});
    for t in ["images", "jobs", "presets", "lora_meta"] {
        let rows: Vec<Value> = db
            .q(&format!("SELECT * FROM {t} ORDER BY rowid"), [])
            .unwrap()
            .into_iter()
            .map(|mut r| {
                for k in JSON_COLS {
                    if let Some(Value::String(txt)) = r.get(k) {
                        let v = serde_json::from_str(txt)
                            .unwrap_or_else(|_| Value::String(txt.clone()));
                        r.insert(k.into(), v);
                    }
                }
                Value::Object(r)
            })
            .collect();
        out[t] = Value::Array(rows);
        cols[t] = json!(db
            .q(&format!("PRAGMA table_info({t})"), [])
            .unwrap()
            .iter()
            .map(|r| r["name"].clone())
            .collect::<Vec<_>>());
    }
    out["columns"] = cols;
    out
}

fn normalize_python_tables(mut t: Value) -> Value {
    for name in ["images", "jobs", "presets", "lora_meta"] {
        for r in t[name].as_array_mut().unwrap() {
            for k in ["params", "info", "data"] {
                if let Some(Value::String(txt)) = r.get(k) {
                    r[k] = serde_json::from_str(txt).unwrap_or_else(|_| Value::String(txt.clone()));
                }
            }
        }
    }
    t
}

fn check_queries(db: &Db, data: &Value, label: &str, fails: &mut Vec<String>) {
    for (x, want) in data["queries"]
        .as_array()
        .unwrap()
        .iter()
        .zip(data["expected"].as_array().unwrap())
    {
        if let Some(d) = first_diff(want, &query(db, x), "") {
            fails.push(format!("[{label}] {} {}：{d}", s(&x["q"]), x["args"]));
        }
    }
}

#[test]
fn db_matches_python() {
    let data = load();
    let mut fails = vec![];

    // 1) Rust 從空資料庫重播操作
    let path = temp_db("replay");
    let db = Db::open(&path).unwrap();
    for (i, (op, want)) in data["ops"]
        .as_array()
        .unwrap()
        .iter()
        .zip(data["op_results"].as_array().unwrap())
        .enumerate()
    {
        let got = replay(&db, op);
        if &got != want {
            fails.push(format!(
                "[操作 {i} {}] 回傳 python={want} rust={got}",
                s(&op["op"])
            ));
        }
    }
    if let Some(d) = first_diff(
        &normalize_python_tables(data["tables"].clone()),
        &dump_tables(&db),
        "tables",
    ) {
        fails.push(format!("[資料表] {d}"));
    }
    check_queries(&db, &data, "重播", &mut fails);
    drop(db);
    let _ = std::fs::remove_file(&path);

    // 2) 直接讀 Python 建的資料庫（複製一份，原檔不動）
    let copy = temp_db("pyfile");
    std::fs::copy(golden_dir().join("golden.db"), &copy).unwrap();
    let db = Db::open(Path::new(&copy)).unwrap();
    check_queries(&db, &data, "讀舊檔", &mut fails);
    drop(db);
    let _ = std::fs::remove_file(&copy);

    let n = data["queries"].as_array().unwrap().len();
    println!(
        "{} 個操作、{n} 個查詢 ×2，{} 個不一致",
        data["ops"].as_array().unwrap().len(),
        fails.len()
    );
    assert!(fails.is_empty(), "\n{}", fails.join("\n"));
}

/// 拿真的圖庫（複製出來的檔）比對：ANIMA_DB_CHECK＝Python 查詢結果 JSON、ANIMA_DB_FILE＝資料庫副本。
/// 資料是使用者自己的，所以不放進專案，平常不跑：cargo test --test golden_db -- --ignored
#[test]
#[ignore]
fn real_db_matches_python() {
    let (Ok(check), Ok(file)) = (
        std::env::var("ANIMA_DB_CHECK"),
        std::env::var("ANIMA_DB_FILE"),
    ) else {
        panic!("要設 ANIMA_DB_CHECK 和 ANIMA_DB_FILE");
    };
    let data: Value = serde_json::from_str(&std::fs::read_to_string(check).unwrap()).unwrap();
    let db = Db::open(Path::new(&file)).unwrap();
    let mut fails = vec![];
    check_queries(&db, &data, "真圖庫", &mut fails);
    println!(
        "{} 個查詢，{} 個不一致",
        data["queries"].as_array().unwrap().len(),
        fails.len()
    );
    assert!(
        fails.is_empty(),
        "\n{}",
        fails
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
