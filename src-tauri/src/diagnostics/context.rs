use super::{Run, Store};
use futures_util::FutureExt;
use serde_json::Value;
use std::{cell::RefCell, future::Future, sync::Arc};

tokio::task_local! { static CURRENT: Arc<Run>; }
thread_local! { static BLOCKING: RefCell<Option<Arc<Run>>> = const { RefCell::new(None) }; }

pub fn current() -> Option<Arc<Run>> {
    CURRENT
        .try_with(Arc::clone)
        .ok()
        .or_else(|| BLOCKING.with(|c| c.borrow().clone()))
}
pub fn event(kind: &str, data: Value) {
    if let Some(r) = current() {
        r.event(kind, data);
    }
}
pub fn snapshot(label: &str, data: &Value) {
    if let Some(r) = current() {
        r.snapshot(label, data);
    }
}
pub fn failure(message: &str) {
    if let Some(r) = current() {
        r.fail(message);
    }
}

struct Completion {
    run: Arc<Run>,
    done: bool,
}
impl Drop for Completion {
    fn drop(&mut self) {
        if !self.done {
            self.run.interrupted();
        }
    }
}

pub async fn scope<T>(run: Arc<Run>, fut: impl Future<Output = T>) -> T {
    let mut completion = Completion {
        run: run.clone(),
        done: false,
    };
    let value = CURRENT.scope(run, fut).await;
    completion.done = true;
    value
}

/// Propagate diagnostic ownership to asynchronous worker tasks, including cancellation/panic.
pub fn spawn<F>(f: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let run = current();
    tokio::spawn(async move {
        match run {
            None => f.await,
            Some(run) => {
                scope(run.clone(), async move {
                    match std::panic::AssertUnwindSafe(f).catch_unwind().await {
                        Ok(value) => value,
                        Err(panic) => {
                            run.fail("background task panicked");
                            std::panic::resume_unwind(panic)
                        }
                    }
                })
                .await
            }
        }
    })
}

pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    let run = current();
    tokio::task::spawn_blocking(move || {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                BLOCKING.with(|c| c.replace(None));
            }
        }
        BLOCKING.with(|c| c.replace(run));
        let _reset = Reset;
        f()
    })
    .await
    .expect("blocking task")
}

pub fn hub_event(v: &Value) {
    let Some(run) = current() else { return };
    let kind = v["type"].as_str().unwrap_or("");
    if matches!(
        kind,
        "agent" | "agent_llm" | "director" | "comic" | "h3" | "h3chain" | "agent_learn"
    ) {
        run.event("site_event", v.clone());
        if v["phase"] == "error"
            || v["state"] == "error"
            || v["status"] == "error"
            || v["event"]["kind"] == "error"
        {
            run.fail(v.to_string().as_str());
        }
        if v["msg"] == "已停止" || v["phase"] == "cancelled" {
            run.cancel();
        }
    }
}

pub fn remember_secret(store: &Store, secret: Option<&str>) {
    if let Some(s) = secret {
        store.redactor.remember(s);
    }
}
