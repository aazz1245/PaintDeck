use anima_app::setup;
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use serde_json::{json, Value};
use std::path::Path;
use tower::ServiceExt;

async fn call(router: axum::Router, path: &str, body: Value) -> (StatusCode, Value) {
    let response = router.oneshot(Request::builder().method("POST").uri(path)
        .header("host", "127.0.0.1:12345").header("x-anima-setup", "1").header("content-type", "application/json")
        .body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[test]
fn reuse_validation_happens_before_settings_keys_or_downloads_are_written() {
    unsafe { std::env::set_var("ANIMA_FAKE_GPUS", "fail"); }
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap().block_on(async {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../待刪除").join(format!("setup-reuse-api-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&root).unwrap(); let root = root.canonicalize().unwrap();
        let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui");
        let res = Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources");
        let cfg = root.join("config.json");
        let missing = root.join("missing"); let comfy = root.join("fake-comfy");
        let original = setup::Config { data_root: missing.clone(), comfy_dir: comfy.clone() };
        original.save(&cfg).unwrap(); let before = std::fs::read(&cfg).unwrap();
        let wizard = setup::Setup::new(&cfg, &res);
        let router = setup::router(wizard, &web);
        let body = json!({"data_root":missing,"data_mode":"reuse","comfy_dir":comfy,"packs":[],"civitai_key":"TEST-ONLY-KEY"});
        let (status, result) = call(router.clone(), "/api/setup/run", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST); assert!(result["error"].as_str().unwrap().contains("原資料位置不存在"));
        assert!(!missing.exists()); assert_eq!(std::fs::read(&cfg).unwrap(), before);
        assert!(!root.join("comfy.json").exists());
        let data = root.join("old/data"); std::fs::create_dir_all(&data).unwrap();
        let db = rusqlite::Connection::open(data.join("anima.db")).unwrap();
        db.execute_batch("CREATE TABLE images(id INTEGER PRIMARY KEY, trashed TEXT); INSERT INTO images VALUES(1,NULL);").unwrap(); drop(db);
        let (status, info) = call(router.clone(), "/api/setup/check", json!({"data_root":data,"data_mode":"reuse","comfy_dir":comfy,"gpu":"cpu"})).await;
        assert_eq!(status, StatusCode::OK); assert_eq!(info["data"]["valid"], true); assert_eq!(info["data"]["images"], 1);
        assert_eq!(info["data"]["path"], root.join("old").to_string_lossy().to_string());
        assert!(!data.join("data").exists()); assert_eq!(std::fs::read(&cfg).unwrap(), before);
        let (status, _) = call(router, "/api/setup/run", json!({"data_root":root.join("old"),"data_mode":"new","comfy_dir":comfy,"packs":[]})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST); assert_eq!(std::fs::read(&cfg).unwrap(), before);
    });
}
