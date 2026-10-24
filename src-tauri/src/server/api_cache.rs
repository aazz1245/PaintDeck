use super::{bad, blocking, ok, ApiResult, Body, Shared};
use axum::extract::State;
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};

struct Cleaning(Arc<crate::cache::Control>);
impl Drop for Cleaning { fn drop(&mut self) { self.0.cleaning.store(false, Ordering::SeqCst); } }

pub async fn status(State(app): State<Shared>) -> ApiResult {
    let a = app.clone();
    let groups = blocking(move || crate::cache::inventory(&a.paths, a.setup.get().and_then(|s| s.config()).as_ref())).await;
    let bytes: u64 = groups.iter().map(|g| g.bytes).sum();
    ok(json!({"groups": groups, "bytes": bytes, "cleaning": app.cache.cleaning.load(Ordering::SeqCst)}))
}

pub async fn clear(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    if body["confirm"] != true { return Err(bad("請先確認要清理快取")); }
    if body.get("parts").is_some_and(|v| !v.is_array() || v.as_array().unwrap().iter().any(|x| !x.is_string())) {
        return Err(bad("快取項目格式不正確"));
    }
    let exclusive = app.cache.gate.clone().try_write_owned().map_err(|_| bad("還有操作正在進行，請稍後再清理快取"))?;
    app.cache.cleaning.store(true, Ordering::SeqCst);
    let cleaning = Cleaning(app.cache.clone());
    if super::update_idle(&app).await.is_err() { return Err(bad("還有工作正在進行或無法確認狀態，請稍後再清理快取")); }
    if app.studio.status().await["running"] == true { return Err(bad("請先關閉剪輯台，再清理快取")); }
    let a = app.clone();
    let parts: Option<Vec<String>> = body["parts"].as_array().map(|p| p.iter().filter_map(|s| s.as_str().map(str::to_string)).collect());
    let result = blocking(move || {
        // blocking 工作不會隨 HTTP 中斷而停止；鎖與狀態也必須跟著工作一起存活。
        let (_exclusive, _cleaning) = (exclusive, cleaning);
        let groups = crate::cache::inventory(&a.paths, a.setup.get().and_then(|s| s.config()).as_ref());
        if parts.as_ref().is_some_and(|p| p.iter().any(|id| !groups.iter().any(|g| g.id == id))) {
            return Err("不認得這個快取項目".to_string());
        }
        let (mut freed, mut files, mut skipped) = (0u64, 0usize, 0usize);
        let mut warnings = vec![];
        for group in groups.iter().filter(|g| parts.as_ref().is_none_or(|p| p.iter().any(|id| id == g.id))) {
            if group.id == "rewrite" {
                if group.skipped > 0 { skipped += group.skipped; continue; }
                if group.files == 0 { continue; }
                match a.pe.clear_cache() {
                    Ok(bytes) => freed += bytes,
                    Err(e) => { skipped += group.files; warnings.push(e); }
                }
            } else {
                let (bytes, count, skip) = crate::cache::clear_files(group);
                freed += bytes; files += count; skipped += skip;
            }
        }
        Ok(json!({"freed_bytes":freed, "removed_files":files, "skipped":skipped, "warnings":warnings}))
    }).await.map_err(bad)?;
    ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_request_keeps_gate_until_blocking_cleanup_finishes() {
        let control = Arc::new(crate::cache::Control::default());
        let guard = control.gate.clone().try_write_owned().unwrap();
        control.cleaning.store(true, Ordering::SeqCst);
        let cleaning = Cleaning(control.clone());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (finish, wait) = std::sync::mpsc::channel();
        let request = tokio::spawn(async move {
            blocking(move || {
                let (_guard, _cleaning) = (guard, cleaning);
                let _ = started.send(());
                wait.recv().unwrap();
            }).await;
        });
        ready.await.unwrap();
        request.abort();
        assert!(control.cleaning.load(Ordering::SeqCst));
        assert!(control.gate.try_read().is_err());
        finish.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while control.cleaning.load(Ordering::SeqCst) || control.gate.try_read().is_err() { tokio::task::yield_now().await; }
        }).await.unwrap();
        assert!(control.gate.try_read().is_ok());
    }
}
