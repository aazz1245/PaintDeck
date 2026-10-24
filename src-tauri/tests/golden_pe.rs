//! AI 改寫純函式 golden test：tests/make_golden_pe.py 用 ComfyUI 節點的 pe_core.py（Python）產生的結果。
//! 系統提示詞讀 tests/golden/pe_prompts（產生 golden 時從節點複製的那一份）。
mod common;

use anima_app::pe::{self, Core, Delta, SegKind};
use anima_app::py::dumps;
use common::{first_diff, golden_dir};
use serde_json::{json, Value};

fn load() -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(golden_dir().join("golden_pe.json"))
            .expect("先跑 make_golden_misc.py"),
    )
    .unwrap()
}

fn core() -> Core {
    let g = golden_dir();
    Core::with_dirs(
        &g.join("no_such_node"),
        &g.join("pe_prompts"),
        &g.join("no_such_models"),
    )
}

fn segs_json(segs: &[(String, SegKind)]) -> Value {
    json!(segs
        .iter()
        .map(|(s, k)| json!([s, k.as_str()]))
        .collect::<Vec<_>>())
}

fn segs_of(v: &Value) -> Vec<(String, SegKind)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| {
            (
                x[0].as_str().unwrap().to_string(),
                if x[1] == "tags" {
                    SegKind::Tags
                } else {
                    SegKind::Prose
                },
            )
        })
        .collect()
}

fn bytes_of(v: &Value) -> Vec<Vec<u8>> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().as_bytes().to_vec())
        .collect()
}

/// 比對一組案例；回傳不一致的說明
fn check(fails: &mut Vec<String>, what: &str, input: &Value, py: &Value, rust: &Value) {
    if let Some(d) = first_diff(py, rust, "") {
        fails.push(format!(
            "{what}({input})\n {d}\n python={py}\n rust  ={rust}"
        ));
    }
}

#[test]
fn pe_core_matches_python() {
    let data = load();
    let core = core();
    let mut fails = vec![];
    let mut n = 0;
    for c in data["split"].as_array().unwrap() {
        check(
            &mut fails,
            "split_segments",
            &c[0],
            &c[1],
            &segs_json(&pe::split_segments(c[0].as_str().unwrap())),
        );
        n += 1;
    }
    for c in data["join"].as_array().unwrap() {
        check(
            &mut fails,
            "join_segments",
            &c[0],
            &c[1],
            &json!(pe::join_segments(&segs_of(&c[0]))),
        );
        n += 1;
    }
    for c in data["patch"].as_array().unwrap() {
        let got = match pe::apply_patch(c[0].as_str().unwrap(), c[1].as_object().unwrap()) {
            Some((p, k)) => json!([p, k]),
            None => json!([null, 0]),
        };
        check(&mut fails, "apply_patch", &c[1], &c[2], &got);
        n += 1;
    }
    for c in data["strip_ratio"].as_array().unwrap() {
        check(
            &mut fails,
            "strip_ratio",
            &c[0],
            &c[1],
            &json!(pe::strip_ratio(c[0].as_str().unwrap())),
        );
        n += 1;
    }
    for c in data["parse"].as_array().unwrap() {
        let got = pe::parse_output(
            c[0].as_str().unwrap(),
            c[1].as_str().unwrap(),
            c[2].as_str().unwrap(),
        );
        let got = got
            .as_ref()
            .map(pe::Parsed::to_value)
            .unwrap_or(Value::Null);
        check(
            &mut fails,
            "parse_output",
            &json!([c[0], c[1]]),
            &c[3],
            &got,
        );
        n += 1;
        if let (Some(p), Some(note)) = (
            pe::parse_output(
                c[0].as_str().unwrap(),
                c[1].as_str().unwrap(),
                c[2].as_str().unwrap(),
            ),
            c[3].as_object(),
        ) {
            let want = data["note"]
                .as_array()
                .unwrap()
                .iter()
                .find(|x| x[0].as_object() == Some(note))
                .map(|x| x[1].clone());
            check(
                &mut fails,
                "result_note",
                &c[3],
                &want.unwrap_or(Value::Null),
                &json!(pe::result_note(&p)),
            );
            n += 1;
        }
    }
    for c in data["noct"].as_array().unwrap() {
        check(
            &mut fails,
            "fix_noct_anime",
            &c[0],
            &c[1],
            &json!(pe::fix_noct_anime(c[0].as_str().unwrap())),
        );
        n += 1;
    }
    for c in data["cache_key"].as_array().unwrap() {
        let kw = c[0].as_object().unwrap();
        let parts: Vec<(&str, Value)> = kw
            .iter()
            .filter(|(k, _)| *k != "images")
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        let imgs = kw.get("images").map(bytes_of);
        check(
            &mut fails,
            "cache_key",
            &c[0],
            &c[1],
            &json!(core.cache_key(&parts, imgs.as_deref())),
        );
        n += 1;
    }
    for c in data["messages"].as_array().unwrap() {
        let m = c[0].as_array().unwrap();
        let s = |i: usize| m[i].as_str().unwrap();
        let got = core
            .build_messages(
                s(0),
                s(1),
                &bytes_of(&m[2]),
                s(3),
                s(4),
                m[5].as_bool().unwrap(),
                s(6),
            )
            .unwrap();
        check(
            &mut fails,
            "build_messages",
            &json!([m[0], m[1]]),
            &c[1],
            &got,
        );
        n += 1;
    }
    for c in data["payload"].as_array().unwrap() {
        let a = c[0].as_array().unwrap();
        let got = pe::payload(
            &a[0],
            a[1].as_f64().unwrap(),
            a[2].as_i64().unwrap(),
            a[3].as_bool().unwrap(),
            a[4].as_i64(),
            a[5].as_bool().unwrap(),
        );
        // 刻意的差異：新版照官方模型卡不加重複懲罰（舊版 1.05），其他都要一樣
        let mut want = c[1].clone();
        want["repeat_penalty"] = json!(1.0);
        check(&mut fails, "payload", &c[0], &want, &got);
        if dumps(&got) != dumps(&want) {
            fails.push(format!(
                "payload 鍵順序不同\n python={}\n rust  ={}",
                dumps(&want),
                dumps(&got)
            ));
        }
        n += 1;
    }
    for c in data["sse"].as_array().unwrap() {
        let got = match pe::sse_delta(c[0].as_str().unwrap()) {
            None => json!([null, null]),
            Some(Delta::Done) => json!(["done", null]),
            Some(Delta::Content(t)) => json!(["content", t]),
            Some(Delta::Reasoning(t)) => json!(["reasoning", t]),
            Some(Delta::Timings(v)) => json!(["timings", v]),
        };
        check(&mut fails, "sse_delta", &c[0], &c[1], &got);
        n += 1;
    }
    assert!(
        fails.is_empty(),
        "{} / {n} 個不一致：\n{}",
        fails.len(),
        fails.join("\n\n")
    );
    eprintln!("pe golden：{n} 個案例全部一致");
}

/// 跟 Python（pe_core.py）的互通測試，由 tests/api/pe_interop.py 帶環境變數呼叫：
///   ANIMA_PE_TEST=lock_busy|lock_free|lock_hold|cache，ANIMA_PE_DIR=測試資料夾
#[test]
#[ignore]
fn interop_with_python() {
    use std::time::{Duration, Instant};
    let phase = std::env::var("ANIMA_PE_TEST").expect("ANIMA_PE_TEST");
    let dir = std::path::PathBuf::from(std::env::var("ANIMA_PE_DIR").expect("ANIMA_PE_DIR"));
    let lock = dir.join("server.lock");
    match phase.as_str() {
        "lock_busy" => {
            let t0 = Instant::now();
            assert!(
                pe::FileLock::acquire(&lock, Duration::from_secs(1)).is_err(),
                "Python 鎖著時 Rust 不該拿到鎖"
            );
            eprintln!(
                "lock_busy：等了 {:.1} 秒拿不到（正確）",
                t0.elapsed().as_secs_f64()
            );
        }
        "lock_free" => {
            let t0 = Instant::now();
            let _g = pe::FileLock::acquire(&lock, Duration::from_secs(10))
                .expect("Python 放開後 Rust 要拿得到鎖");
            eprintln!("lock_free：{:.1} 秒拿到", t0.elapsed().as_secs_f64());
        }
        "lock_hold" => {
            let _g = pe::FileLock::acquire(&lock, Duration::from_secs(5)).expect("拿鎖");
            std::fs::write(dir.join("rust_holding"), "1").unwrap();
            std::thread::sleep(Duration::from_secs(4));
        }
        "cache" => {
            // Python 用同樣的參數寫了一筆快取；Rust 算出同一個鍵、讀得到同樣的值，再寫一筆給 Python 讀
            let core = Core::with_dirs(&dir, &golden_dir().join("pe_prompts"), &dir);
            let key = core.cache_key(
                &[
                    ("task", json!("anima")),
                    ("idea", json!("一個女孩 in the rain")),
                    ("prev", json!("")),
                    ("instruction", json!("")),
                    ("ratio", json!("")),
                    ("temperature", json!(1.0)),
                    ("seed", json!(42)),
                    ("think", json!(false)),
                    ("noct_anime", json!(false)),
                    ("model", json!("pe_t2i_heretic-Q4_K_M.gguf")),
                ],
                Some(&[]),
            );
            let hit = core.cache_get(&key).expect("讀不到 Python 寫的快取");
            assert_eq!(hit["prompt"], json!("from python 中文"), "快取內容不一樣");
            let k2 = core.cache_key(&[("task", json!("zh")), ("idea", json!("from rust"))], None);
            core.cache_put(&k2, &json!({"prompt": "Rust 寫的"}));
            eprintln!("cache：讀到 Python 的值，也寫了一筆");
        }
        other => panic!("不認得的 ANIMA_PE_TEST={other}"),
    }
}
