//! 生圖助手的工具（2026-10-27）整合測試：確認卡按「准／不准」之後，工具真的經過自己的 API 跑完並記進對話。
//! 不需要模型、ComfyUI、llama-server（助手接著想的那一步會因為沒選生圖模型停下來，這裡只看工具那段）。
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

async fn station(name: &str) -> (String, PathBuf) {
    let root = std::env::temp_dir().join("anima_route_test").join(name);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("ui");
    let paths = anima_app::paths::Paths::new(&root, &web, Some(root.join("comfy")));
    let app = anima_app::server::start(paths, "http://127.0.0.1:9").await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(anima_app::server::serve_on(anima_app::server::router(app), listener));
    (format!("http://{addr}"), root)
}

async fn post(base: &str, path: &str, body: Value) -> (u16, Value) {
    let r = reqwest::Client::new().post(format!("{base}{path}")).json(&body).send().await.unwrap();
    let code = r.status().as_u16();
    (code, r.json().await.unwrap_or(Value::Null))
}

/// 開一段對話，事件換成「助手要把圖移到回收區、等你准」
async fn waiting_session(base: &str, root: &Path) -> String {
    let (_, s) = post(base, "/api/agent/session/new", json!({})).await;
    let id = s["id"].as_str().unwrap().to_string();
    let file = root.join("data").join("agent").join("sessions").join(format!("{id}.json"));
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    v["events"] = json!([
        {"kind": "user", "text": "把第 999 張移到回收區", "t": 1},
        {"kind": "act", "action": {"action": "call", "tool": "trash", "args": {"ids": [999]}, "say": "", "confirm": "把 1 張圖移到回收區"}, "t": 2},
        {"kind": "confirm", "call": {"tool": "trash", "args": {"ids": [999]}}, "why": "把 1 張圖移到回收區", "state": "wait", "t": 3}
    ]);
    std::fs::write(&file, serde_json::to_string(&v).unwrap()).unwrap();
    id
}

/// 等背景工作停下來，回傳整段對話
async fn settled(base: &str, id: &str) -> Value {
    for _ in 0..100 {
        let s: Value = reqwest::get(format!("{base}/api/agent/session/{id}")).await.unwrap().json().await.unwrap();
        if s["running"] == false {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("助手一直沒停");
}

#[tokio::test]
async fn approved_tool_runs_through_the_api() {
    let (base, root) = station("agent_confirm_yes").await;
    let id = waiting_session(&base, &root).await;
    let (code, _) = post(&base, "/api/agent/confirm", json!({"id": id, "ok": true})).await;
    assert_eq!(code, 200);
    let s = settled(&base, &id).await;
    let ev = s["events"].as_array().unwrap();
    assert_eq!(ev[2]["state"], "yes");
    let tool = ev.iter().find(|e| e["kind"] == "tool").expect("工具結果有記下來");
    assert_eq!((tool["tool"].clone(), tool["ok"].clone()), (json!("trash"), json!(true)), "{tool}");
    assert!(tool["text"].as_str().unwrap().starts_with("Moved 0 image(s)"), "{tool}");
    // 沒有等確認的卡了：再按一次是錯誤
    let (code, err) = post(&base, "/api/agent/confirm", json!({"id": id, "ok": true})).await;
    assert_eq!(code, 400, "{err}");
}

#[tokio::test]
async fn denied_tool_is_reported_back() {
    let (base, root) = station("agent_confirm_no").await;
    let id = waiting_session(&base, &root).await;
    let (code, _) = post(&base, "/api/agent/confirm", json!({"id": id, "ok": false})).await;
    assert_eq!(code, 200);
    let s = settled(&base, &id).await;
    let ev = s["events"].as_array().unwrap();
    assert_eq!(ev[2]["state"], "no");
    let tool = ev.iter().find(|e| e["kind"] == "tool").unwrap();
    assert_eq!((tool["ok"].clone(), tool["zh"].clone()), (json!(false), json!("沒有准，不做")));
}

#[tokio::test]
async fn prompt_only_accepts_request_without_image_model_or_comfy() {
    let (base, _) = station("agent_prompt_offline").await;
    let (code, body) = post(&base, "/api/agent/say", json!({
        "text": "寫一隻橘貓的提示詞", "settings": {"mode": "prompt", "target": "qwen"}
    })).await;
    assert_eq!(code, 200, "{body}");
    let s = settled(&base, body["id"].as_str().unwrap()).await;
    assert!(s["events"].as_array().unwrap().iter().all(|e|
        e["kind"] != "result" && e["kind"] != "tool" &&
        !(e["kind"] == "act" && e["action"]["action"] == "generate")
    ));
    let (code, _) = post(&base, "/api/agent/say", json!({
        "text": "畫橘貓", "settings": {"mode": "tools"}
    })).await;
    assert_eq!(code, 400, "動手做仍須選繪圖模型");
    let (code, _) = post(&base, "/api/agent/say", json!({
        "text": "畫橘貓", "settings": {"mode": "tools", "base": {"model":"test.safetensors"}}
    })).await;
    assert_eq!(code, 400, "動手做仍須連上 ComfyUI");
}
