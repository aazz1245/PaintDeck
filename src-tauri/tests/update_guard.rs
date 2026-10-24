use anima_app::{paths::Paths, server};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn update_blocks_jobs_and_private_channel_cannot_install() {
    let root = std::env::temp_dir().join(format!("anima_update_guard_{}", std::process::id()));
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui");
    let app = server::start(Paths::new(&root, &web, Some(root.join("fakecomfy"))), "http://127.0.0.1:9").await.unwrap();
    assert!(server::update_idle(&app).await.is_ok());
    app.db.add_job("fake-queued-job", &json!({}), &json!({})).unwrap();
    assert!(server::update_idle(&app).await.is_err());
    app.db.set_job("fake-queued-job", "done", None).unwrap();
    assert!(server::update_idle(&app).await.is_ok());
    // 安裝寫鎖須等已進入 handler 的修改請求放掉讀鎖。
    let guard = app.updates.gate.read().await;
    let a = app.clone();
    let mut waiting = tokio::spawn(async move { let _lock = a.updates.gate.write().await; });
    assert!(tokio::time::timeout(std::time::Duration::from_millis(20), &mut waiting).await.is_err());
    drop(guard);
    waiting.await.unwrap();
    let _ = app.updates.setup_busy.set(Box::new(|| true));
    assert!(server::update_idle(&app).await.is_err());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let a = app.clone();
    tokio::spawn(server::serve_on(server::router(a), listener));
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://{addr}");
    let denied = http.post(format!("{base}/api/cache/clear")).json(&json!({"confirm":true})).send().await.unwrap();
    assert_eq!(denied.status().as_u16(), 400); // setup_busy 已設 true；清理不能動到進行中的安裝。
    assert!(!app.cache.cleaning.load(Ordering::SeqCst));
    app.cache.cleaning.store(true, Ordering::SeqCst);
    let denied = http.post(format!("{base}/api/generate")).json(&json!({})).send().await.unwrap();
    assert_eq!(denied.status().as_u16(), 409);
    app.cache.cleaning.store(false, Ordering::SeqCst);
    let check = http.post(format!("{base}/api/app/update/check")).send().await.unwrap();
    let v: serde_json::Value = check.json().await.unwrap();
    assert_eq!(v["enabled"], false); // headless test station cannot update
    let install = http.post(format!("{base}/api/app/update/install"))
        .json(&json!({"version":"99.1.1", "confirm":true, "channel":"public", "endpoint":"http://127.0.0.1:9"}))
        .send().await.unwrap();
    assert_eq!(install.status().as_u16(), 400);
    // 更新開始後的新工作不能進入 handler；讀狀態仍可運作。
    app.updates.installing.store(true, Ordering::SeqCst);
    let denied = http.post(format!("{base}/api/generate")).json(&json!({})).send().await.unwrap();
    assert_eq!(denied.status().as_u16(), 409);
    assert!(http.get(format!("{base}/api/app/update")).send().await.unwrap().status().is_success());
    app.updates.installing.store(false, Ordering::SeqCst);
    let denied = http.post(format!("{base}/api/app/update/install")).json(&json!({"version":"99.1.1"})).send().await.unwrap();
    assert_eq!(denied.status().as_u16(), 400);
}
