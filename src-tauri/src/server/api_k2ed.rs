//! 「隨機」頁的 Krea 2 隨機產生器：
//! 用 Comfyui-K2-Editorial（作者灵冻不冻）當引擎。外掛不在專案內附帶，
//! 而是從本機資料夾內的 Comfyui-K2-Editorial.zip 解壓安裝到 ComfyUI\custom_nodes\Comfyui-K2-Editorial，
//! 並原樣轉送 /k2ed/*（/manifest、/chars、/outfits、/favs、/pick、/build、/thumb/…）請求。
use super::api_wardrobe::safe_segments;
use super::{bad, blocking, ok, ApiError, ApiResult, Shared};
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, RawQuery, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};

pub const DIR: &str = "Comfyui-K2-Editorial";
pub const ZIP_NAME: &str = "Comfyui-K2-Editorial.zip";
const PREFIX: &str = "/k2ed/";

fn node_dir(app: &Shared) -> PathBuf {
    app.paths.comfy_root.join("custom_nodes").join(DIR)
}

/// 依序在繪匣目錄、上層目錄與 ComfyUI 上層目錄尋找本機的 Comfyui-K2-Editorial.zip
pub fn find_zip(root: &Path, comfy_root: &Path) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![root.to_path_buf()];
    if let Some(p) = root.parent() {
        dirs.push(p.to_path_buf());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent() {
            dirs.push(p.to_path_buf());
            if let Some(pp) = p.parent() {
                dirs.push(pp.to_path_buf());
            }
        }
    }
    if let Some(p) = comfy_root.parent() {
        dirs.push(p.to_path_buf());
        if let Some(pp) = p.parent() {
            dirs.push(pp.to_path_buf());
        }
    }
    dirs.push(comfy_root.join("custom_nodes"));
    for d in dirs {
        let cand = d.join(ZIP_NAME);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// 過濾 zip 內的條目路徑：剝離頂層 Comfyui-K2-Editorial/、擋掉路徑穿越、略過 .git／__pycache__／_bak_*
fn clean_entry_path(raw: &str) -> Option<PathBuf> {
    let norm = raw.replace('\\', "/");
    let stripped = norm.strip_prefix("Comfyui-K2-Editorial/").unwrap_or(&norm);
    let trimmed = stripped.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let mut out = PathBuf::new();
    for (idx, comp) in Path::new(trimmed).components().enumerate() {
        let Component::Normal(seg) = comp else {
            return None;
        };
        let s = seg.to_str()?;
        if s.is_empty() || s.contains([':', '*', '?', '"', '<', '>', '|']) {
            return None;
        }
        if idx == 0 && (s == ".git" || s == "__pycache__" || s.starts_with("_bak_")) {
            return None;
        }
        if s == "__pycache__" || s.ends_with(".pyc") {
            return None;
        }
        out.push(s);
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// 從本機 zip 安全解壓到 dest；若已存在 __init__.py 則不動使用者資料，回 Ok(false)
pub fn extract_zip_to(zip_path: &Path, dest: &Path) -> Result<bool, String> {
    if dest.join("__init__.py").is_file() {
        return Ok(false);
    }
    let parent = dest.parent().ok_or_else(|| "目標路徑不對".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("建資料夾失敗：{e}"))?;

    let f = File::open(zip_path).map_err(|e| format!("開不了壓縮檔 {}：{e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| format!("壓縮檔格式不對：{e}"))?;

    let stage = parent.join(format!(".{DIR}_install_tmp"));
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|e| format!("建暫存資料夾失敗：{e}"))?;

    let res: Result<(), String> = (|| {
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| format!("讀壓縮項目失敗：{e}"))?;
            if entry.is_dir() {
                continue;
            }
            let Ok(entry_name) = entry.name() else {
                continue;
            };
            let Some(rel) = clean_entry_path(&entry_name) else {
                continue;
            };
            let target = stage.join(&rel);
            if let Some(p) = target.parent() {
                fs::create_dir_all(p).map_err(|e| format!("建子資料夾失敗：{e}"))?;
            }
            let mut out = File::create(&target).map_err(|e| format!("寫檔 {} 失敗：{e}", rel.display()))?;
            io::copy(&mut entry, &mut out).map_err(|e| format!("解壓 {} 失敗：{e}", rel.display()))?;
        }
        if !stage.join("__init__.py").is_file() {
            return Err(format!("{ZIP_NAME} 裡面找不到 __init__.py，請確認壓縮檔內容正確"));
        }
        if dest.exists() {
            fs::remove_dir_all(dest).map_err(|e| format!("清舊資料夾失敗：{e}"))?;
        }
        fs::rename(&stage, dest).map_err(|e| format!("搬移外掛資料夾失敗：{e}"))?;
        Ok(())
    })();

    if res.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    res.map(|_| true)
}

async fn loaded(app: &Shared) -> bool {
    let Ok(url) = reqwest::Url::parse(&format!("{}{PREFIX}manifest", app.comfy.url())) else {
        return false;
    };
    matches!(app.comfy.forward(reqwest::Method::GET, url, None).await, Ok((200, _, _)))
}

/// GET /api/k2ed/status → {installed, loaded, online, remote, zip_found, zip_path}
pub async fn status(State(app): State<Shared>) -> ApiResult {
    let dir = node_dir(&app);
    let root = app.paths.root.clone();
    let comfy_root = app.paths.comfy_root.clone();
    let (installed, zip_path) = blocking(move || (dir.join("__init__.py").is_file(), find_zip(&root, &comfy_root))).await;
    let online = app.comfy.live().online;
    let loaded = online && loaded(&app).await;
    ok(json!({
        "installed": installed,
        "loaded": loaded,
        "online": online,
        "remote": app.comfy.is_remote(),
        "zip_found": zip_path.is_some(),
        "zip_path": zip_path.as_ref().map(|p| p.display().to_string()),
    }))
}

/// POST /api/k2ed/install → 從資料夾內的 Comfyui-K2-Editorial.zip 解壓安裝到 ComfyUI\custom_nodes
pub async fn install(State(app): State<Shared>) -> ApiResult {
    static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _g = INSTALLING.lock().await;
    if app.comfy.is_remote() {
        return Err(bad("現在連的是雲端的 ComfyUI：Krea 2 隨機產生器只能裝在本機的 ComfyUI"));
    }
    let dest = node_dir(&app);
    let root = app.paths.root.clone();
    let comfy_root = app.paths.comfy_root.clone();
    let (fresh, zip_str) = blocking(move || -> Result<(bool, Option<String>), String> {
        if dest.join("__init__.py").is_file() {
            return Ok((false, find_zip(&root, &comfy_root).map(|p| p.display().to_string())));
        }
        let zip_path = find_zip(&root, &comfy_root).ok_or_else(|| {
            format!("資料夾裡找不到 {ZIP_NAME}：請把 {ZIP_NAME} 放在繪匣資料夾或其上層資料夾後再按安裝")
        })?;
        let fresh = extract_zip_to(&zip_path, &dest)?;
        Ok((fresh, Some(zip_path.display().to_string())))
    })
    .await
    .map_err(bad)?;
    ok(json!({
        "installed": true,
        "fresh": fresh,
        "restart": fresh || !loaded(&app).await,
        "zip_path": zip_str,
    }))
}

/// GET／POST /api/k2ed/x/<路徑> → 本機 ComfyUI 的 /k2ed/<路徑>（query、body、content-type 原樣轉）
pub async fn forward(
    State(app): State<Shared>,
    method: Method,
    UrlPath(rest): UrlPath<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let segs = safe_segments(&rest).ok_or_else(|| bad("路徑不對"))?;
    if !app.comfy.live().online {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "本機的 ComfyUI 沒有連線：Krea 2 隨機產生器要 ComfyUI 開著".into(),
        ));
    }
    let mut url = reqwest::Url::parse(&format!("{}{PREFIX}", app.comfy.url())).map_err(|e| bad(e.to_string()))?;
    url.path_segments_mut().map_err(|_| bad("ComfyUI 網址不對"))?.pop_if_empty().extend(segs);
    url.set_query(query.as_deref());
    let m = if method == Method::POST { reqwest::Method::POST } else { reqwest::Method::GET };
    let send = (m == reqwest::Method::POST).then(|| {
        let ct = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
        (body.to_vec(), ct)
    });
    let (code, ct, bytes) = app.comfy.forward(m, url, send).await.map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.0))?;
    if code == 404 && !loaded(&app).await {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "本機 ComfyUI 還沒有 Krea 2 隨機產生器（Comfyui-K2-Editorial 外掛）：到「隨機 → Krea 2 隨機」按「從本機壓縮包安裝」，裝好重開 ComfyUI".into(),
        ));
    }
    let status = StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY);
    let cache = if rest.starts_with("thumb/") { "max-age=86400" } else { "no-store" };
    Ok((status, [(header::CONTENT_TYPE, ct), (header::CACHE_CONTROL, cache.to_string())], bytes).into_response())
}

/// GET /api/k2ed/ext/<file> → 讀取本機 Comfyui-K2-Editorial/js/<file>
pub async fn ext_file(State(app): State<Shared>, UrlPath(rest): UrlPath<String>) -> Result<Response, ApiError> {
    super::api_wardrobe::serve_plugin_js(node_dir(&app), rest).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn extract_zip_skips_git_bak_and_traversal() {
        let tmp = std::env::temp_dir().join(format!("pd_k2ed_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let zp = tmp.join(ZIP_NAME);
        {
            let mut zw = zip::ZipWriter::new(File::create(&zp).unwrap());
            let opt = SimpleFileOptions::default();
            for (name, data) in [
                ("Comfyui-K2-Editorial/__init__.py", "print('ok')"),
                ("Comfyui-K2-Editorial/presets/manifest.json", "{\"motifs\":[]}"),
                ("Comfyui-K2-Editorial/.git/config", "git"),
                ("Comfyui-K2-Editorial/_bak_old/a.py", "bak"),
                ("Comfyui-K2-Editorial/__pycache__/a.pyc", "pyc"),
                ("../evil.txt", "nope"),
            ] {
                zw.start_file(name, opt).unwrap();
                zw.write_all(data.as_bytes()).unwrap();
            }
            zw.finish().unwrap();
        }
        let dest = tmp.join("custom_nodes").join(DIR);
        assert_eq!(extract_zip_to(&zp, &dest), Ok(true));
        assert!(dest.join("__init__.py").is_file());
        assert!(dest.join("presets").join("manifest.json").is_file());
        assert!(!dest.join(".git").exists());
        assert!(!dest.join("_bak_old").exists());
        assert!(!dest.join("__pycache__").exists());
        assert!(!tmp.join("evil.txt").exists());
        // 已裝過不再覆蓋
        assert_eq!(extract_zip_to(&zp, &dest), Ok(false));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_zip_searches_parent_dir() {
        let tmp = std::env::temp_dir().join(format!("pd_k2ed_find_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let root = tmp.join("PaintDeck");
        let comfy = tmp.join("ComfyUI-aki").join("ComfyUI");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&comfy).unwrap();
        let zp = tmp.join(ZIP_NAME);
        fs::write(&zp, b"zip").unwrap();
        assert_eq!(find_zip(&root, &comfy), Some(zp));
        let _ = fs::remove_dir_all(&tmp);
    }
}
