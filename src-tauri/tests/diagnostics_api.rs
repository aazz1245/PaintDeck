//! Isolated diagnostics API acceptance; no real models, media or remote services.
use anima_app::{paths::Paths, server};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn request(
    r: &axum::Router,
    method: &str,
    url: &str,
    body: Value,
) -> axum::response::Response {
    r.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(url)
                .header("host", "127.0.0.1:12345")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn value(r: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(r.into_body(), 10 * 1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn failed_request_report_export_policy_and_clear_round_trip() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../待刪除")
        .join(format!("diagnostics-api-{:016x}", rand::random::<u64>()));
    let web = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui");
    let paths = Paths::new(&root, &web, Some(root.join("comfy")));
    let app = server::start(paths.clone(), "http://127.0.0.1:9")
        .await
        .unwrap();
    let router = server::router(app.clone());
    let response = request(
        &router,
        "POST",
        "/api/agent/say",
        json!({"text":"","api_key":"fixture-api-secret"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let id = response.headers()["x-anima-diagnostic-id"]
        .to_str()
        .unwrap()
        .to_string();
    let error = value(response).await;
    assert!(error["error"].as_str().unwrap().contains("要先說"));
    let list = value(request(&router, "GET", "/api/diagnostics", json!({})).await).await;
    assert_eq!(list["records"][0]["status"], "error");
    assert_eq!(list["policy"]["success_days"], 1);
    assert_eq!(list["policy"]["error_days"], 3);
    assert_eq!(
        request(
            &router,
            "POST",
            "/api/diagnostics/preferences",
            json!({"success_days":0,"error_days":3,"max_mib":500})
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        request(
            &router,
            "POST",
            "/api/diagnostics/preferences",
            json!({"success_days":1,"error_days":2,"max_mib":100})
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        request(
            &router,
            "POST",
            &format!("/api/diagnostics/{id}/report"),
            json!({"expected":"fixture three views","actual":"fixture unchanged"})
        )
        .await
        .status(),
        200
    );
    let response = request(
        &router,
        "GET",
        &format!("/api/diagnostics/{id}/export"),
        json!({}),
    )
    .await;
    assert_eq!(response.headers()["content-type"], "application/zip");
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = to_bytes(response.into_body(), 10 * 1024 * 1024)
        .await
        .unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    use std::io::Read;
    let mut collected = String::new();
    for i in 0..zip.len() {
        let mut text = String::new();
        zip.by_index(i).unwrap().read_to_string(&mut text).unwrap();
        collected.push_str(&text);
    }
    assert!(collected.contains("fixture three views"));
    assert!(!collected.contains("fixture-api-secret"));
    assert!(collected.contains("[REDACTED]"));
    assert_eq!(
        std::fs::read_dir(paths.data.join("diagnostics/exports"))
            .unwrap()
            .count(),
        0
    );
    app.diagnostics.bind_job(&id, "fixture-api-job");
    app.diagnostics
        .job_event("fixture-api-job", "execution_success", &json!({}));
    let found = value(
        request(
            &router,
            "GET",
            "/api/diagnostics/job/fixture-api-job",
            json!({}),
        )
        .await,
    )
    .await;
    assert_eq!(found["diagnostic_id"], id);
    // A response which has not been consumed owns the export lease; dropping it simulates cancellation.
    let downloading = request(
        &router,
        "GET",
        &format!("/api/diagnostics/{id}/export"),
        json!({}),
    )
    .await;
    let _ = request(
        &router,
        "POST",
        "/api/diagnostics/clear",
        json!({"all":true,"confirm":true}),
    )
    .await;
    assert!(paths.data.join("diagnostics/runs").join(&id).exists());
    drop(downloading);
    assert_eq!(
        std::fs::read_dir(paths.data.join("diagnostics/exports"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        request(
            &router,
            "POST",
            "/api/diagnostics/clear",
            json!({"all":true})
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        request(
            &router,
            "POST",
            "/api/diagnostics/clear",
            json!({"all":true,"confirm":true})
        )
        .await
        .status(),
        200
    );
    assert!(!paths.data.join("diagnostics/runs").join(id).exists());
    // Host/origin policy still applies to both listing and exporting.
    let response = router
        .oneshot(
            Request::builder()
                .uri("/api/diagnostics")
                .header("host", "evil.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn real_comfy_submission_records_resolved_workflow_and_terminal_history() {
    use axum::{routing::post, Json};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Value::Null));
    let received = seen.clone();
    let fake = axum::Router::new().route(
        "/prompt",
        post(move |Json(v): Json<Value>| {
            let received = received.clone();
            async move {
                *received.lock().unwrap() = v;
                Json(json!({"prompt_id":"fixture-prompt","node_errors":{}}))
            }
        }),
    );
    let task = tokio::spawn(async move {
        axum::serve(listener, fake).await.unwrap();
    });
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../待刪除")
        .join(format!("diagnostics-comfy-{:016x}", rand::random::<u64>()));
    let paths = Paths::new(&root, &root.join("ui"), Some(root.join("comfy")));
    let store = anima_app::diagnostics::Store::new(&paths);
    let db = std::sync::Arc::new(anima_app::db::Db::open(&paths.db).unwrap());
    let comfy =
        anima_app::comfy::Comfy::new(&format!("http://{addr}"), db, anima_app::hub::Hub::new());
    comfy.attach_diagnostics(store.clone());
    let graph = json!({"1":{"class_type":"FixtureNode","inputs":{"seed":42,"denoise":0.7,"text":"fixture prompt"}}});
    let pid = comfy.submit(&graph, &json!({"seed":42})).await.unwrap();
    assert_eq!(seen.lock().unwrap()["prompt"], graph);
    let id = store.job_id(&pid).unwrap();
    assert!(
        store.status()["records"][0]["pending"]
            .as_array()
            .unwrap()
            .len()
            == 1
    );
    store.job_event(
        &pid,
        "execution_error",
        &json!({"node_id":"1","exception_type":"FixtureOOM","traceback":["fixture.py:42"]}),
    );
    let export = store.export(&id).unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&export.path).unwrap()).unwrap();
    use std::io::Read;
    let mut combined = String::new();
    for i in 0..zip.len() {
        let mut text = String::new();
        zip.by_index(i).unwrap().read_to_string(&mut text).unwrap();
        combined += &text;
    }
    assert!(combined.contains("workflow_api"));
    assert!(combined.contains("denoise"));
    assert!(combined.contains("fixture.py:42"));
    assert_eq!(store.status()["records"][0]["status"], "error");
    drop(zip);
    drop(export);
    store.cleanup(true);
    task.abort();
}
