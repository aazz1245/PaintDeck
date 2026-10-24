use anima_app::{paths::Paths, server, setup};
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use serde_json::{json, Value};
use std::path::Path;
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

#[test]
fn frame_cleanup_requires_confirmation_and_idle_and_preserves_source() {
    unsafe { std::env::set_var("ANIMA_STUDIO_PORT", "9"); }
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../待刪除").join(format!("frames-api-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        let comfy = root.join("fakecomfy"); put(&comfy.join("main.py"));
        let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui");
        let paths = Paths::new(&root, &web, Some(comfy));
        let frame = paths.data.join("frames/one/f/1.png"); put(&frame);
        put(&paths.data.join("frames/one/meta.json"));
        let source = paths.output.join("source.mp4"); put(&source);
        let app = server::start(paths, "http://127.0.0.1:9").await.unwrap();
        let wizard = setup::Setup::new(&root.join("config.json"), &app.paths.res);
        server::attach_setup(&app, wizard.clone());
        let router = server::router(app.clone()).merge(setup::router(wizard, &web));
        let (status, info) = call(router.clone(), "GET", "/api/studio/frames/storage?sid=one", json!({})).await;
        assert_eq!(status, StatusCode::OK); assert_eq!(info["session"]["bytes"], 14);
        let (status, _) = call(router.clone(), "POST", "/api/studio/frames/clear", json!({"scope":"session","sid":"one"})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST); assert!(frame.exists());
        let guard = app.frames_lock.clone().lock_owned().await;
        let (status, _) = call(router.clone(), "POST", "/api/studio/frames/clear", json!({"scope":"session","sid":"one","confirm":true})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST); assert!(frame.exists());
        assert!(server::update_idle(&app).await.is_err());
        drop(guard);
        let (status, _) = call(router.clone(), "POST", "/api/studio/frames/clear", json!({"scope":"session","sid":"../one","confirm":true})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST); assert!(frame.exists());
        let (status, result) = call(router, "POST", "/api/studio/frames/clear", json!({"scope":"session","sid":"one","confirm":true})).await;
        assert_eq!(status, StatusCode::OK); assert_eq!(result["bytes"], 14); assert_eq!(result["removed"], 1);
        assert!(!frame.exists()); assert_eq!(std::fs::read(source).unwrap(), b"fixture");
    });
}
