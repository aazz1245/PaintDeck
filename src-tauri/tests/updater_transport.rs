//! 真正使用官方 updater，連本機假 Release；只驗下載和簽章，不執行安裝檔。
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri_plugin_updater::UpdaterExt;

#[tokio::test]
async fn fake_release_versions_signatures_offline_and_proxy_client() {
    let manifest = Arc::new(Mutex::new(Value::Null));
    let data = Arc::new(Mutex::new(include_bytes!("fixtures/updater/payload.txt").to_vec()));
    let m = manifest.clone();
    let d = data.clone();
    let router = axum::Router::new()
        .route("/latest.json", axum::routing::get(move || {
            let v = m.lock().unwrap().clone();
            async move { axum::Json(v) }
        }))
        .route("/artifact", axum::routing::get(move || {
            let v = d.lock().unwrap().clone();
            async move { v }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let url = format!("http://{addr}/latest.json");
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert("updater".into(), json!({
        "pubkey": include_str!("fixtures/updater/test.pub").trim(),
        "requireSignedVersion": true,
        "dangerousInsecureTransportProtocol": true,
        "endpoints": [url],
    }));
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap();
    let updater = app.updater_builder().target("windows-x86_64")
        .version_comparator(|_, r| anima_app::updater::newer("26.1024.1", &r.version.to_string()))
        .configure_client(|c| c.no_proxy().proxy(anima_app::net::proxy()))
        .timeout(Duration::from_secs(2)).build().unwrap();
    let release = |version: &str| json!({"version": version, "notes": "isolated test", "platforms": {
        "windows-x86_64": {"url": format!("http://{addr}/artifact"),
            "signature": include_str!("fixtures/updater/payload.txt.sig").trim()}
    }});
    *manifest.lock().unwrap() = release("26.1024.1");
    assert!(updater.check().await.unwrap().is_none());
    *manifest.lock().unwrap() = release("26.10.24");
    assert!(updater.check().await.unwrap().is_none());
    *manifest.lock().unwrap() = release("99.1.1");
    let update = updater.check().await.unwrap().unwrap();
    let bytes = update.download(|_, _| {}, || {}).await.unwrap();
    assert_eq!(bytes, include_bytes!("fixtures/updater/payload.txt"));
    // 假更新檔的位元組被改過：官方驗簽必須拒絕。
    data.lock().unwrap().push(b'!');
    assert!(update.download(|_, _| {}, || {}).await.is_err());
    *data.lock().unwrap() = include_bytes!("fixtures/updater/payload.txt").to_vec();
    // 真簽章搭配假的新版號仍應拒絕，避免舊檔被冒充新版。
    *manifest.lock().unwrap() = release("99.1.2");
    assert!(updater.check().await.unwrap().unwrap().download(|_, _| {}, || {}).await.is_err());
    server.abort();
    assert!(updater.check().await.is_err());
}
