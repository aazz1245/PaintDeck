//! 設定頁「模型與工作流」（2026-10-21）：外部模型資料夾（原地使用電腦裡本來就有的模型，model_dirs.rs）、掃描、
//! 模型總覽、加裝模型（拖檔案上傳、從電腦裡的路徑複製、貼網址下載）、重開 ComfyUI。
//!
//!   GET  /api/models/dirs                  外部資料夾清單＋分類
//!   POST /api/models/dirs/add  {path, kind}     kind＝auto 會自己看（ComfyUI／A1111 資料夾會展開成好幾筆）
//!   POST /api/models/dirs/remove {kind, path}
//!   POST /api/models/scan、GET /api/models/scan、POST /api/models/scan/cancel、POST /api/models/scan/apply {dirs}
//!   GET  /api/models/inventory             每一類有哪些模型檔＋安裝精靈清單還缺哪些
//!   POST /api/models/classify {path}       猜一個檔是哪一類
//!   PUT  /api/models/upload?name=&kind=    檔案本體當請求內容（拖進設定頁的檔），先寫進 models\_incoming 再歸位
//!   POST /api/models/import {path, kind}   從電腦裡的路徑複製進來
//!   POST /api/models/place {name, kind}    _incoming 裡猜不出分類的檔，使用者選好分類後歸位
//!   POST /api/models/download {url, kind}、GET /api/models/downloads   貼網址下載（Hugging Face、Civitai、一般直接連結）
//!   POST /api/models/restart_comfy         重開 ComfyUI（外部資料夾改了要重開才生效；只有生圖站自己開的 ComfyUI 能重開）
use super::{bad, blocking, internal, ok, ApiResult, Body, Shared};
use crate::model_dirs::{self, Dir};
use crate::{dl, families, settings};
use axum::extract::{Query, State};
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::io::AsyncWriteExt;

fn models_root(app: &Shared) -> PathBuf {
    app.paths.comfy_root.join("models")
}

fn incoming(app: &Shared) -> PathBuf {
    models_root(app).join("_incoming")
}

fn dir_json(d: &Dir) -> Value {
    let (files, bytes) = model_dirs::count_models(&d.path);
    json!({"kind": d.kind, "label": model_dirs::kind_label(&d.kind), "path": d.path.to_string_lossy(), "source": d.source,
           "added": d.added, "exists": d.path.is_dir(), "files": files, "bytes": bytes})
}

fn kinds() -> Vec<Value> {
    model_dirs::KINDS.iter().map(|(k, l)| json!({"id": k, "label": l})).collect()
}

/// 外部資料夾清單。restart＝這個程式能不能自己重開 ComfyUI
pub async fn dirs(State(app): State<Shared>) -> ApiResult {
    let list = blocking(|| model_dirs::current().iter().map(dir_json).collect::<Vec<_>>()).await;
    let yaml = model_dirs::yaml_path(&app.paths.comfy_root);
    // 另外沿用的：使用者自己 ComfyUI 的 extra_model_paths.yaml（唯讀，生圖站不改它）
    let comfy = app.paths.comfy_root.clone();
    let comfy_yaml = blocking(move || model_dirs::comfy_extra_view(&comfy)).await;
    ok(json!({"dirs": list, "kinds": kinds(), "yaml": yaml.to_string_lossy(), "yaml_exists": yaml.is_file(),
              "comfy_yaml": comfy_yaml,
              "comfy_models": models_root(&app).to_string_lossy(), "can_restart": app.restart_comfy.get().is_some()}))
}

/// 存清單：回 (存好的清單, 警告)。清單裡有資料夾找不到不會讓整批失敗（見 model_dirs::save_checked）
async fn save_merged(app: &Shared, add: Vec<Dir>) -> Result<(Vec<Dir>, Vec<String>), super::ApiError> {
    let mut all = model_dirs::current();
    all.extend(add);
    let (data, comfyui) = (app.paths.data.clone(), app.paths.comfy_root.clone());
    blocking(move || model_dirs::save_checked(&data, &comfyui, all)).await.map_err(bad)
}

pub async fn dirs_add(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let path = PathBuf::from(body["path"].as_str().unwrap_or("").trim().trim_matches('"'));
    let kind = body["kind"].as_str().unwrap_or("auto").to_string();
    let (p2, k2) = (path.clone(), kind.clone());
    let add = blocking(move || model_dirs::expand(&p2, &k2)).await.map_err(bad)?;
    let before = model_dirs::current();
    let (saved, warnings) = save_merged(&app, add.clone()).await?;
    // 真的新加進清單的（生圖站自己的 models\<分類>、本來就在清單裡的不算）
    let has = |list: &[Dir], d: &Dir| list.iter().any(|x| x.kind == d.kind && model_dirs::same(&x.path, &d.path));
    let added: Vec<Value> = add
        .iter()
        .filter(|d| has(&saved, d) && !has(&before, d))
        .map(|d| json!({"kind": d.kind, "label": model_dirs::kind_label(&d.kind), "path": d.path.to_string_lossy()}))
        .collect();
    ok(json!({"ok": true, "added": added, "restart": !added.is_empty(), "warnings": warnings}))
}

pub async fn dirs_remove(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let (kind, path) = (body["kind"].as_str().unwrap_or(""), body["path"].as_str().unwrap_or(""));
    let all: Vec<Dir> = model_dirs::current().into_iter().filter(|d| !(d.kind == kind && d.path == Path::new(path))).collect();
    let (data, comfyui) = (app.paths.data.clone(), app.paths.comfy_root.clone());
    let (_, warnings) = blocking(move || model_dirs::save_checked(&data, &comfyui, all)).await.map_err(bad)?;
    ok(json!({"ok": true, "restart": true, "warnings": warnings}))
}

// ---------------------------------------------------------------- 掃描
pub async fn scan_start(State(app): State<Shared>) -> ApiResult {
    let wants = crate::setup::manifest_wants(&app.paths.res);
    if !model_dirs::scan_start(wants, vec![]) {
        return Err(bad("已經在掃描了"));
    }
    ok(json!({"ok": true}))
}

pub async fn scan_status(State(app): State<Shared>) -> ApiResult {
    let comfyui = app.paths.comfy_root.clone();
    ok(blocking(move || model_dirs::scan_view(&comfyui, &model_dirs::current())).await)
}

pub async fn scan_cancel() -> ApiResult {
    model_dirs::scan_cancel();
    ok(json!({"ok": true}))
}

pub async fn scan_apply(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let mut add = vec![];
    for d in body["dirs"].as_array().into_iter().flatten() {
        let (Some(kind), Some(path)) = (d["kind"].as_str(), d["path"].as_str()) else {
            return Err(bad("dirs 每一項要有 kind、path"));
        };
        add.push(Dir { kind: kind.into(), path: path.into(), source: "scan".into(), added: String::new() });
    }
    let (saved, warnings) = save_merged(&app, add).await?;
    ok(json!({"ok": true, "dirs": saved.len(), "restart": true, "warnings": warnings}))
}

// ---------------------------------------------------------------- 總覽
/// checkpoints、主模型資料夾裡「生圖站內建流程不會畫、要靠匯入工作流才能用」的模型各家族有幾個，例如 {"sdxl": 12, "flux": 2}。
/// 家族只有 sdxl、sd15、flux、sd3 會算（看檔頭判斷，結果依檔案快取）；沒有就是空物件。網頁拿來提示「這些模型可以用『匯入工作流』來用」
pub fn other_families(comfyui: &Path) -> Map<String, Value> {
    let mut count: Map<String, Value> = Map::new();
    for kind in ["checkpoints", "diffusion_models"] {
        for f in model_dirs::list_kind(comfyui, kind) {
            let p = Path::new(f["root"].as_str().unwrap_or("")).join(f["name"].as_str().unwrap_or(""));
            let fam = families::detect(&p);
            if fam != families::OTHER && !families::is_builtin(fam) {
                let n = count.get(fam).and_then(Value::as_u64).unwrap_or(0) + 1;
                count.insert(fam.to_string(), json!(n));
            }
        }
    }
    count
}

/// GET /api/models/other_families：上面那個統計（20 秒內重複問不重算）
pub async fn other_families_get(State(app): State<Shared>) -> ApiResult {
    static CACHE: Mutex<Option<(std::time::Instant, Map<String, Value>)>> = Mutex::new(None);
    if let Some((t, m)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if t.elapsed() < std::time::Duration::from_secs(20) {
            return ok(json!({"other_families": m}));
        }
    }
    let comfyui = app.paths.comfy_root.clone();
    let m = blocking(move || other_families(&comfyui)).await;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((std::time::Instant::now(), m.clone()));
    ok(json!({"other_families": m}))
}

pub async fn inventory(State(app): State<Shared>) -> ApiResult {
    let (comfyui, res) = (app.paths.comfy_root.clone(), app.paths.res.clone());
    let v = blocking(move || {
        let mut groups: Vec<Value> = vec![];
        for (kind, label) in model_dirs::KINDS {
            let mut files = model_dirs::list_kind(&comfyui, kind);
            if matches!(*kind, "diffusion_models" | "loras" | "checkpoints") {
                for f in files.iter_mut() {
                    let p = Path::new(f["root"].as_str().unwrap_or("")).join(f["name"].as_str().unwrap_or(""));
                    f["family"] = json!(families::detect(&p));
                    // SDXL 再細分 Pony／Illustrious／NoobAI（看檔頭 metadata，看不出來就是 null）
                    f["sub"] = json!(families::sublabel(&p));
                }
            }
            groups.push(json!({"kind": kind, "label": label, "files": files}));
        }
        let missing = crate::setup::missing_report(&res, &comfyui.join("models"), &model_dirs::current());
        let other = other_families(&comfyui);
        json!({"groups": groups, "missing": missing, "other_families": other, "families": families::FAMILY_NAMES.iter().map(|(k, l)| json!({"id": k, "label": l})).collect::<Vec<_>>()})
    })
    .await;
    ok(v)
}

pub async fn classify(Body(body): Body) -> ApiResult {
    let p = PathBuf::from(body["path"].as_str().unwrap_or("").trim().trim_matches('"'));
    if !p.is_file() {
        return Err(bad(format!("找不到檔案 {}", p.display())));
    }
    let (kind, fam, why) = blocking(move || model_dirs::classify_file(&p)).await;
    ok(json!({"kind": kind, "family": fam, "why": why}))
}

// ---------------------------------------------------------------- 加裝：歸位
/// 只留檔名，副檔名要是模型檔
fn model_name(raw: &str) -> Result<String, super::ApiError> {
    let n = super::basename(raw.trim());
    if n.is_empty() || n.starts_with('.') || !model_dirs::is_model_file(Path::new(&n)) {
        return Err(bad(format!("「{raw}」不是模型檔（要是 {} 其中一種）", model_dirs::EXTS.join("、"))));
    }
    Ok(n)
}

/// _incoming 裡的檔（已經是正式檔名）放進 models\<分類>。kind 空的＝自己猜；猜不出來就留在 _incoming 等使用者選
fn place_file(models: &Path, src: &Path, kind: Option<&str>) -> Value {
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let (guess, fam, why) = model_dirs::classify_file(src);
    let kind = kind.filter(|k| !k.is_empty() && *k != "auto").and_then(model_dirs::canonical).or(guess);
    let fam = if kind.is_some_and(|k| k == "diffusion_models" || k == "loras") && fam == families::OTHER {
        families::detect(src)
    } else {
        fam
    };
    let Some(k) = kind else {
        return json!({"name": name, "placed": false, "need_kind": true, "why": why, "family": fam});
    };
    let dst = models.join(k).join(&name);
    if dst.exists() {
        // src 一定是 _incoming 裡生圖站自己收下的那份（上傳、複製、下載來的），原檔還在使用者那邊：丟掉，免得越堆越多
        let _ = std::fs::remove_file(src);
        return json!({"name": name, "placed": false, "kind": k, "error": format!("{} 已經有同名的檔，這次的沒有放進去：要換新的就先把舊的改名或移走，再加一次", dst.display()),
                      "family": fam, "why": why});
    }
    let r = std::fs::create_dir_all(dst.parent().unwrap_or(models)).and_then(|_| std::fs::rename(src, &dst));
    match r {
        Ok(()) => json!({"name": name, "placed": true, "kind": k, "label": model_dirs::kind_label(k), "path": dst.to_string_lossy(),
                         "family": fam, "why": why}),
        Err(e) => json!({"name": name, "placed": false, "kind": k, "error": format!("搬到 {} 失敗：{e}", dst.display())}),
    }
}

/// 拖進來的檔：請求內容就是檔案本體（不整個讀進記憶體，邊收邊寫）
pub async fn upload(State(app): State<Shared>, Query(q): Query<HashMap<String, String>>, body: axum::body::Body) -> ApiResult {
    let name = model_name(q.get("name").map(String::as_str).unwrap_or(""))?;
    let kind = q.get("kind").cloned().unwrap_or_default();
    let dir = incoming(&app);
    tokio::fs::create_dir_all(&dir).await.map_err(internal)?;
    let part = dir.join(format!("{name}.part"));
    let mut f = tokio::fs::File::create(&part).await.map_err(|e| internal(format!("建立 {} 失敗：{e}", part.display())))?;
    let mut stream = body.into_data_stream();
    let mut n: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(f);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(bad(format!("上傳中斷：{e}")));
            }
        };
        n += chunk.len() as u64;
        f.write_all(&chunk).await.map_err(|e| internal(format!("寫入失敗（硬碟滿了？）：{e}")))?;
    }
    f.flush().await.map_err(internal)?;
    drop(f);
    if n == 0 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(bad("收到的檔案是空的"));
    }
    let done = dir.join(&name);
    let _ = tokio::fs::remove_file(&done).await;
    tokio::fs::rename(&part, &done).await.map_err(internal)?;
    let models = models_root(&app);
    ok(blocking(move || place_file(&models, &done, Some(&kind))).await)
}

/// 從電腦裡的路徑複製進來（原本的檔不動）
pub async fn import_path(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let src = PathBuf::from(body["path"].as_str().unwrap_or("").trim().trim_matches('"'));
    if !src.is_file() {
        return Err(bad(format!("找不到檔案 {}", src.display())));
    }
    let name = model_name(&src.to_string_lossy())?;
    let kind = body["kind"].as_str().unwrap_or("").to_string();
    let (dir, models) = (incoming(&app), models_root(&app));
    let r = blocking(move || -> Result<Value, String> {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(&name);
        std::fs::copy(&src, &tmp).map_err(|e| format!("複製失敗（硬碟滿了？）：{e}"))?;
        Ok(place_file(&models, &tmp, Some(&kind)))
    })
    .await
    .map_err(bad)?;
    ok(r)
}

/// _incoming 裡的檔選好分類後歸位
pub async fn place(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let name = model_name(body["name"].as_str().unwrap_or(""))?;
    let kind = body["kind"].as_str().unwrap_or("").to_string();
    if model_dirs::canonical(&kind).is_none() {
        return Err(bad("選一個分類"));
    }
    let src = incoming(&app).join(&name);
    if !src.is_file() {
        return Err(bad(format!("找不到 {}（可能已經歸位了）", src.display())));
    }
    let models = models_root(&app);
    ok(blocking(move || place_file(&models, &src, Some(&kind))).await)
}

// ---------------------------------------------------------------- 貼網址下載
static DLS: Mutex<Vec<Map<String, Value>>> = Mutex::new(Vec::new());
/// 網址的短記號 → 正在下載它的 id：同一個網址不要同時開兩個下載（兩個一起寫同一個 .part 會壞掉）
static RUNNING: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());

fn dl_set(id: u64, f: impl FnOnce(&mut Map<String, Value>)) {
    let mut g = DLS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(d) = g.iter_mut().find(|d| d["id"] == id) {
        f(d)
    }
}

/// 網頁上的網址 → 真的下載網址。Hugging Face 的 /blob/ 換 /resolve/；Civitai 模型頁換成下載 API
pub fn download_url(raw: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(raw.trim()).map_err(|_| "網址看不懂：要是 https:// 開頭的完整網址".to_string())?;
    if !matches!(u.scheme(), "https" | "http") {
        return Err("只能下載 http／https 網址".into());
    }
    let host = u.host_str().unwrap_or("").to_lowercase();
    if host.ends_with("huggingface.co") {
        return Ok(u.as_str().replacen("/blob/", "/resolve/", 1));
    }
    if host.ends_with("civitai.com") && u.path().starts_with("/models/") {
        let version = u.query_pairs().find(|(k, _)| k == "modelVersionId").map(|(_, v)| v.to_string());
        return match version {
            Some(v) if v.chars().all(|c| c.is_ascii_digit()) => Ok(format!("https://civitai.com/api/download/models/{v}")),
            _ => Err("Civitai 的網址要選好版本：在模型頁點一下想要的版本，網址會多出 ?modelVersionId=…，再貼一次".into()),
        };
    }
    Ok(u.to_string())
}

/// %E4%B8%AD → 中（網址、Content-Disposition 裡的檔名）
fn pct_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).ok()?, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// Content-Disposition 的 filename*=UTF-8''… 或 filename="…"
fn disposition_name(v: &str) -> Option<String> {
    if let Some(i) = v.find("filename*=") {
        let s = v[i + 10..].split(';').next()?.trim();
        let s = s.split("''").last()?;
        return pct_decode(s.trim_matches('"'));
    }
    let i = v.find("filename=")?;
    Some(v[i + 9..].split(';').next()?.trim().trim_matches('"').to_string())
}

/// 在下載清單（/api/models/downloads）登記一筆：回傳（id, 是不是同一個網址已經在下載）
fn dl_begin(url: &str) -> (u64, bool) {
    let mut g = DLS.lock().unwrap_or_else(|e| e.into_inner());
    let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let tag = dl::tag(url);
    // 這個網址正在下載：回傳那一個的 id（status 不是 run 的留著也沒關係，會被換掉）
    if let Some(&(_, old)) = running.iter().find(|(t, _)| *t == tag) {
        if g.iter().any(|d| d["id"] == old && d["status"] == "run") {
            return (old, true);
        }
    }
    let id = g.iter().filter_map(|d| d["id"].as_u64()).max().unwrap_or(0) + 1;
    running.retain(|(t, _)| *t != tag);
    running.push((tag, id));
    // 網址只留給人看的部分（不會有金鑰：Civitai 金鑰放在標頭）
    let shown = reqwest::Url::parse(url).map(|u| format!("{}{}", u.host_str().unwrap_or(""), u.path())).unwrap_or_default();
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("url".into(), json!(shown));
    m.insert("status".into(), json!("run"));
    m.insert("done".into(), json!(0));
    m.insert("total".into(), json!(null));
    g.push(m);
    (id, false)
}

/// 下載一個位置、大小（和 SHA256）都已經知道的檔（例如讀圖用的 mmproj）。先存成「檔名.verify」，核對過才改成正式檔名，
/// 核對不過就丟掉（是這次自己下載的暫存檔）。進度在 /api/models/downloads；回傳 id
pub(crate) fn download_to(url: String, dest: PathBuf, size: u64, sha256: Option<String>) -> u64 {
    let (id, already) = dl_begin(&url);
    if already {
        return id;
    }
    let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    dl_set(id, |d| {
        d.insert("name".into(), json!(name));
        d.insert("total".into(), json!(size));
    });
    tokio::spawn(async move {
        let r = fetch_to(id, &url, &dest, size, sha256.as_deref()).await;
        dl_set(id, |d| match r {
            Ok(()) => {
                d.remove("note"); // 「核對中」只在下載中顯示
                d.insert("status".into(), json!("done"));
                d.insert("result".into(), json!({"placed": true, "path": dest.to_string_lossy(), "name": name}));
            }
            Err(e) => {
                d.remove("note");
                d.insert("status".into(), json!("error"));
                d.insert("error".into(), json!(e));
            }
        });
    });
    id
}

async fn fetch_to(id: u64, url: &str, dest: &Path, size: u64, sha256: Option<&str>) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .proxy(crate::net::proxy())
        .user_agent("Mozilla/5.0 (anima-app models)")
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let tmp = PathBuf::from(format!("{}.verify", dest.display()));
    let job = dl::Job { size: Some(size), ..dl::Job::new(&client, url) };
    dl::fetch(&job, dl::Dest::Path(tmp.clone()), &mut |done, total| {
        dl_set(id, |d| {
            d.insert("done".into(), json!(done));
            if total.is_some() {
                d.insert("total".into(), json!(total));
            }
        });
    })
    .await?;
    if let Some(want) = sha256 {
        dl_set(id, |d| {
            d.insert("note".into(), json!("核對檔案內容中…"));
        });
        let t = tmp.clone();
        let got = blocking(move || crate::setup::sha256_file(&t).map_err(|e| e.to_string())).await?;
        if !got.eq_ignore_ascii_case(want) {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err("下載完了，但內容跟來源公布的檔案核對不上（SHA256 不同），可能是下載途中壞掉：已經丟掉，再按一次會重新下載".into());
        }
    }
    tokio::fs::rename(&tmp, dest).await.map_err(|e| format!("改名成 {} 失敗：{e}", dest.display()))
}

pub async fn download(State(app): State<Shared>, Body(body): Body) -> ApiResult {
    let url = download_url(body["url"].as_str().unwrap_or("")).map_err(bad)?;
    let kind = body["kind"].as_str().unwrap_or("").to_string();
    let (id, already) = dl_begin(&url);
    if already {
        return ok(json!({"ok": true, "id": id}));
    }
    let key = settings::civitai_key(&settings::load(&app.paths.settings));
    let (dir, models) = (incoming(&app), models_root(&app));
    tokio::spawn(async move {
        // 以前失敗留下的 .part 留著等續傳，不自動刪（規則：不刪使用者硬碟上的檔；dl::sweep 留著備用）
        let r = fetch(id, &url, &key, &dir).await;
        match r {
            Ok(path) => {
                let res = blocking(move || place_file(&models, &path, Some(&kind))).await;
                dl_set(id, |d| {
                    d.insert("status".into(), json!(if res["placed"] == true { "done" } else if res["need_kind"] == true { "need_kind" } else { "error" }));
                    if let Some(e) = res.get("error") {
                        d.insert("error".into(), e.clone());
                    }
                    d.insert("result".into(), res);
                });
            }
            Err(e) => dl_set(id, |d| {
                d.insert("status".into(), json!("error"));
                d.insert("error".into(), json!(e));
            }),
        }
    });
    ok(json!({"ok": true, "id": id}))
}

/// 下載到 dir 裡（先寫 檔名.記號.part，下載完才改名）。斷線會自動接著下載，用法和重試規則見 dl.rs；
/// 就算最後還是失敗，已經下載的部分也留著，再貼一次同一個網址會接著下載
async fn fetch(id: u64, url: &str, civitai_key: &str, dir: &Path) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .proxy(crate::net::proxy())
        .user_agent("Mozilla/5.0 (anima-app models)")
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let tag = dl::tag(url);
    let job = dl::Job {
        // Civitai 的金鑰放在標頭（dl 只會送給 civitai.com），不在網址裡
        bearer: Some(civitai_key).filter(|k| !k.is_empty() && url.contains("civitai.com")),
        tag: Some(&tag),
        ..dl::Job::new(&client, url)
    };
    // 檔名要看伺服器的回應（Content-Disposition、轉址後網址的最後一段）才知道
    let pick = dl::Dest::Pick(Box::new(|h: &dl::Head| {
        let name = h
            .disposition
            .as_deref()
            .and_then(disposition_name)
            .or_else(|| h.last_segment.as_deref().and_then(pct_decode))
            .unwrap_or_default();
        let name = super::basename(&name);
        if name.is_empty() || !model_dirs::is_model_file(Path::new(&name)) {
            return Err(format!("下載的檔名「{name}」不是模型檔（要是 {} 其中一種）", model_dirs::EXTS.join("、")));
        }
        dl_set(id, |d| {
            d.insert("name".into(), json!(name));
            d.insert("total".into(), json!(h.total));
        });
        Ok(dir.join(&name))
    }));
    dl::fetch(&job, pick, &mut |done, total| {
        dl_set(id, |d| {
            d.insert("done".into(), json!(done));
            if total.is_some() {
                d.insert("total".into(), json!(total));
            }
        });
    })
    .await
}

pub async fn downloads() -> ApiResult {
    let g = DLS.lock().unwrap_or_else(|e| e.into_inner());
    ok(json!({"downloads": g.iter().rev().take(30).cloned().collect::<Vec<_>>()}))
}

// ---------------------------------------------------------------- 重開 ComfyUI
pub async fn restart_comfy(State(app): State<Shared>) -> ApiResult {
    let Some(f) = app.restart_comfy.get() else {
        return Err(bad("這個 ComfyUI 不是生圖站開的：請自己把 ComfyUI 關掉再開一次，新的模型資料夾才會生效"));
    };
    f().map_err(bad)?;
    ok(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_urls() {
        assert_eq!(
            download_url("https://huggingface.co/a/b/blob/main/x.safetensors").unwrap(),
            "https://huggingface.co/a/b/resolve/main/x.safetensors"
        );
        assert_eq!(
            download_url("https://civitai.com/models/123/some-name?modelVersionId=456").unwrap(),
            "https://civitai.com/api/download/models/456"
        );
        assert!(download_url("https://civitai.com/models/123").is_err());
        assert!(download_url("ftp://x/y.safetensors").is_err());
        assert!(download_url("not a url").is_err());
        assert_eq!(download_url("https://example.com/a.safetensors").unwrap(), "https://example.com/a.safetensors");
    }

    #[test]
    fn disposition() {
        assert_eq!(disposition_name("attachment; filename=\"a b.safetensors\"").as_deref(), Some("a b.safetensors"));
        assert_eq!(disposition_name("attachment; filename*=UTF-8''%E4%B8%AD.safetensors").as_deref(), Some("中.safetensors"));
    }
}
