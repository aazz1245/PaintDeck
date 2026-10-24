use anima_app::{paths::Paths, server, settings, setup};
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::Ordering;
use tower::ServiceExt;

async fn call(router: axum::Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = router.oneshot(Request::builder().method(method).uri(path)
        .header("host", "127.0.0.1:12345").header("x-anima-setup", "1").header("content-type", "application/json")
        .body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn put(path: &Path) { std::fs::create_dir_all(path.parent().unwrap()).unwrap(); std::fs::write(path, b"fixture").unwrap(); }

// 此獨立測試程序只有一個測試；建立 runtime／背景工作前設定不連真剪輯台的 port。
#[test]
fn cache_routes_preserve_originals_and_secrets_and_respect_busy_guards() {
    unsafe { std::env::set_var("ANIMA_STUDIO_PORT", "9"); }
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../待刪除")
            .join(format!("cache-api-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let comfy = root.join("fakecomfy"); put(&comfy.join("main.py"));
        let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui");
        let paths = Paths::new(&root, &web, Some(comfy));
        put(&paths.thumbs.join("1.webp")); put(&paths.data.join("_dl/tool.zip.part"));
        let keep = [paths.output.join("original.png"), paths.input.join("reference.png"), paths.previews.join("lora.png"),
            paths.data.join("models/model.safetensors"), root.join("待刪除/恢復原廠_fixture/backup.png")];
        for path in &keep { put(path); }
        let mut saved = settings::defaults(); saved.insert(settings::KEY.into(), json!("TEST-ONLY-CACHE-KEY"));
        settings::save(&paths.settings, &saved).unwrap();
        let settings_before = std::fs::read(&paths.settings).unwrap();
        let app = server::start(paths, "http://127.0.0.1:9").await.unwrap();
        let wizard = setup::Setup::new(&root.join("config.json"), &app.paths.res);
        server::attach_setup(&app, wizard.clone());
        let router = server::router(app.clone()).merge(setup::router(wizard, &web));
        let (status, info) = call(router.clone(), "GET", "/api/cache", json!({})).await;
        assert_eq!(status, StatusCode::OK); assert_eq!(info["bytes"], 14);
        let (status, _) = call(router.clone(), "POST", "/api/cache/clear", json!({})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST); assert!(app.paths.thumbs.join("1.webp").exists());
        let (status, _) = call(router.clone(), "POST", "/api/cache/clear", json!({"confirm":true,"parts":["../models"]})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        app.db.add_job("cache-test-busy", &json!({}), &json!({})).unwrap();
        let (status, _) = call(router.clone(), "POST", "/api/cache/clear", json!({"confirm":true})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST); assert!(!app.cache.cleaning.load(Ordering::SeqCst));
        app.db.set_job("cache-test-busy", "done", None).unwrap();
        app.cache.cleaning.store(true, Ordering::SeqCst);
        let (status, _) = call(router.clone(), "POST", "/api/generate", json!({})).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = call(router.clone(), "POST", "/api/setup/run", json!({})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        app.cache.cleaning.store(false, Ordering::SeqCst);
        let (status, result) = call(router.clone(), "POST", "/api/cache/clear", json!({"confirm":true})).await;
        assert_eq!(status, StatusCode::OK); assert_eq!(result["freed_bytes"], 14); assert_eq!(result["removed_files"], 2);
        assert_eq!(result["skipped"], 0);
        assert!(keep.iter().all(|p| std::fs::read(p).unwrap() == b"fixture"));
        assert_eq!(std::fs::read(&app.paths.settings).unwrap(), settings_before);
        let (_, info) = call(router.clone(), "GET", "/api/cache", json!({})).await;
        assert_eq!(info["bytes"], 0); assert!(!info.to_string().contains("TEST-ONLY-CACHE-KEY"));
        let (_, state) = call(router, "GET", "/api/state", json!({})).await;
        assert_eq!(state["settings"]["has_civitai_key"], true);
        assert!(!state.to_string().contains("TEST-ONLY-CACHE-KEY"));
    });
}
