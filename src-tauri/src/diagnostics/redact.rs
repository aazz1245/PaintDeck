use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};

/// Sanitize before persistence, not merely when downloading the archive.
pub struct Redactor {
    roots: Vec<(String, String)>,
    secrets: Mutex<Vec<String>>,
}

fn secret_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase().replace(['-', '_', ' '], "");
    matches!(
        k.as_str(),
        "key"
            | "apikey"
            | "authorization"
            | "cookie"
            | "setcookie"
            | "password"
            | "passwd"
            | "secret"
            | "token"
            | "accesstoken"
            | "refreshtoken"
    ) || k.ends_with("key")
        || k.ends_with("password")
        || k.ends_with("secret")
        || k.ends_with("token")
        || k.ends_with("keydpapi")
        || k.starts_with("civitaikey")
        || k.starts_with("runpodkey")
}

pub fn sha256(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}

impl Redactor {
    pub fn new(paths: &crate::paths::Paths) -> Self {
        let mut roots = vec![
            (
                paths.comfy_root.to_string_lossy().into_owned(),
                "<COMFY_ROOT>".into(),
            ),
            (
                paths.root.to_string_lossy().into_owned(),
                "<DATA_ROOT>".into(),
            ),
            (
                paths.res.to_string_lossy().into_owned(),
                "<RESOURCES>".into(),
            ),
        ];
        if let Some(p) = std::env::var_os("USERPROFILE") {
            roots.push((p.to_string_lossy().into_owned(), "<USER_HOME>".into()));
        }
        roots.sort_by_key(|(s, _)| std::cmp::Reverse(s.len()));
        Self {
            roots,
            secrets: Mutex::new(vec![]),
        }
    }

    pub fn remember(&self, s: &str) {
        if s.len() < 6 {
            return;
        }
        let mut secrets = self.secrets.lock().unwrap_or_else(|e| e.into_inner());
        if secrets.len() < 128 && !secrets.iter().any(|x| x == s) {
            secrets.push(s.into());
        }
    }

    fn discover(&self, v: &Value, depth: usize) {
        if depth > 32 {
            return;
        }
        match v {
            Value::Object(m) => {
                for (k, v) in m {
                    if secret_key(k) {
                        if let Some(s) = v.as_str() {
                            self.remember(s);
                        }
                    } else {
                        self.discover(v, depth + 1);
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    self.discover(v, depth + 1);
                }
            }
            _ => {}
        }
    }

    pub fn text(&self, s: &str) -> String {
        static URL: OnceLock<Regex> = OnceLock::new();
        static SECRET: OnceLock<Regex> = OnceLock::new();
        static PATH: OnceLock<Regex> = OnceLock::new();
        static MEDIA: OnceLock<Regex> = OnceLock::new();
        let mut s = s.to_string();
        s = MEDIA
            .get_or_init(|| Regex::new(r#"(?i)data:[a-z0-9.+/-]+;base64,[a-z0-9+/=_-]+"#).unwrap())
            .replace_all(&s, |c: &regex::Captures<'_>| {
                format!(
                    "[INLINE_MEDIA_OMITTED sha256={} bytes={}]",
                    sha256(c[0].as_bytes()),
                    c[0].len()
                )
            })
            .into_owned();
        for value in self
            .secrets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
        {
            s = s.replace(value, "[REDACTED]");
        }
        for (path, alias) in &self.roots {
            for variant in [path.clone(), path.replace('\\', "/")] {
                let re =
                    Regex::new(&format!("(?i){}", regex::escape(&variant))).expect("escaped path");
                s = re.replace_all(&s, alias.as_str()).into_owned();
            }
        }
        // Endpoint aliases avoid signed URLs, proxy passwords and private endpoint addresses.
        s = URL
            .get_or_init(|| Regex::new(r#"(?i)https?://[^\s<>\"']+"#).unwrap())
            .replace_all(&s, "<ENDPOINT>")
            .into_owned();
        s = SECRET.get_or_init(|| Regex::new(r#"(?i)(bearer\s+|(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*[\"']?)[^\s,;\"']+"#).unwrap()).replace_all(&s, "${1}[REDACTED]").into_owned();
        s = PATH
            .get_or_init(|| Regex::new(r#"(?i)\b[A-Z]:[\\/][^\s\"'<>]*"#).unwrap())
            .replace_all(&s, "<LOCAL_PATH>")
            .into_owned();
        const MAX: usize = 256 * 1024;
        if s.len() > MAX {
            let mut end = MAX;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            s.truncate(end);
            s.push_str("\n[TRUNCATED: text limit]");
        }
        s
    }

    pub fn value(&self, v: &Value) -> Value {
        self.discover(v, 0);
        self.walk(v, 0)
    }

    fn walk(&self, v: &Value, depth: usize) -> Value {
        if depth > 32 {
            return json!({"status":"truncated","reason":"nesting_limit"});
        }
        match v {
            Value::Object(m) => Value::Object(
                m.iter()
                    .take(4096)
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            if secret_key(k) {
                                json!("[REDACTED]")
                            } else {
                                self.walk(v, depth + 1)
                            },
                        )
                    })
                    .collect(),
            ),
            Value::Array(a) => {
                let mut out: Vec<Value> = a
                    .iter()
                    .take(4096)
                    .map(|v| self.walk(v, depth + 1))
                    .collect();
                if a.len() > 4096 {
                    out.push(json!({"status":"truncated","omitted_items":a.len()-4096}));
                }
                Value::Array(out)
            }
            Value::String(s) if s.starts_with("data:") => {
                json!({"status":"omitted","reason":"inline_media","encoded_bytes":s.len(),"sha256":sha256(s.as_bytes())})
            }
            Value::String(s) => json!(self.text(s)),
            _ => v.clone(),
        }
    }
}
