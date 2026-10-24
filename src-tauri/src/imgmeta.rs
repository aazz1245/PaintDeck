//! PNG 裡的生成參數（對照舊版 server.py 的 read_params／import_existing）：
//! 生圖站寫的 anima_params，或從 ComfyUI 的節點圖（"prompt" 文字區塊）推回提示詞、模型、LoRA。
use crate::db::Db;
use crate::graphs::is_turbo_lora;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, Seek};
use std::path::Path;

/// PNG 的文字區塊（tEXt／zTXt／iTXt，只讀影像資料之前的部分；ComfyUI 和 PIL 都寫在前面）和尺寸
pub fn png_text<R: BufRead + Seek>(r: R) -> Option<(HashMap<String, String>, (u32, u32))> {
    let mut dec = png::Decoder::new(r);
    dec.set_ignore_text_chunk(false);
    let reader = dec.read_info().ok()?;
    let info = reader.info();
    let mut out = HashMap::new();
    for t in &info.uncompressed_latin1_text {
        out.insert(t.keyword.clone(), t.text.clone());
    }
    for t in &info.compressed_latin1_text {
        if let Ok(s) = t.get_text() {
            out.insert(t.keyword.clone(), s);
        }
    }
    for t in &info.utf8_text {
        if let Ok(s) = t.get_text() {
            out.insert(t.keyword.clone(), s);
        }
    }
    Some((out, (info.width, info.height)))
}

pub fn read_params_file(path: &Path) -> Option<Value> {
    let f = std::fs::File::open(path).ok()?;
    let (text, size) = png_text(std::io::BufReader::new(f))?;
    params_from_text(&text, size)
}

pub fn read_params_bytes(b: &[u8]) -> Option<Value> {
    let (text, size) = png_text(std::io::Cursor::new(b))?;
    params_from_text(&text, size)
}

fn params_from_text(text: &HashMap<String, String>, size: (u32, u32)) -> Option<Value> {
    if let Some(p) = text.get("anima_params") {
        return serde_json::from_str(p).ok();
    }
    let nodes: Map<String, Value> = serde_json::from_str(text.get("prompt")?).ok()?;
    let class = |n: &Value| {
        n.get("class_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let ks = nodes
        .values()
        .find(|n| matches!(class(n).as_str(), "KSampler" | "KSamplerAdvanced"))?;
    let txt = |r: &Value| -> Value {
        let n = r
            .as_array()
            .and_then(|a| a.first())
            .and_then(|id| nodes.get(&py_key(id)));
        match n {
            Some(n) if class(n) == "CLIPTextEncode" => {
                n["inputs"].get("text").cloned().unwrap_or(json!(""))
            }
            _ => json!(""),
        }
    };
    let unet = nodes
        .values()
        .find(|n| class(n) == "UNETLoader")
        .map(|n| n["inputs"].get("unet_name").cloned().unwrap_or(Value::Null));
    let loras: Vec<Value> = nodes
        .values()
        .filter(|n| class(n) == "LoraLoaderModelOnly")
        .map(|n| json!({"name": n["inputs"]["lora_name"], "strength": n["inputs"].get("strength_model").cloned().unwrap_or(json!(1))}))
        .collect();
    let turbo = |l: &Value| l["name"].as_str().map(is_turbo_lora).unwrap_or(false);
    let i = &ks["inputs"];
    let get = |k: &str| i.get(k).cloned().unwrap_or(Value::Null);
    let seed = match i.get("seed") {
        Some(v @ Value::Number(n)) if n.is_i64() || n.is_u64() => v.clone(),
        Some(Value::Bool(b)) => json!(*b as i64), // Python 的 bool 也是 int
        _ => json!(0),
    };
    let mut p = json!({
        "mode": "txt2img", "prompt": txt(&get("positive")), "negative": txt(&get("negative")),
        "seed": seed, "steps": get("steps"), "cfg": get("cfg"), "sampler": get("sampler_name"), "scheduler": get("scheduler"),
        "width": size.0, "height": size.1,
        "loras": loras.iter().filter(|l| !turbo(l)).cloned().collect::<Vec<_>>(),
        "turbo_lora": loras.iter().find(|l| turbo(l)).map(|l| l["name"].clone()).unwrap_or(json!(false)),
    });
    if let Some(u) = unet.filter(|u| crate::py::truthy(Some(u))) {
        p["model"] = u;
    }
    Some(p)
}

/// str(ref[0])：節點編號可能是字串或數字
fn py_key(v: &Value) -> String {
    v.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string())
}

/// 把 ComfyUI output 資料夾裡、還沒進圖庫的 PNG 匯入（例如直接在 ComfyUI 介面產生的圖）。回傳匯入張數。
pub fn import_existing(db: &Db, output: &Path) -> usize {
    let known = db.active_files().unwrap_or_default();
    let mut n = 0;
    let mut stack = vec![output.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let sub = dir
            .strip_prefix(output)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let mut subdirs = vec![];
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let path = e.path();
            if path.is_dir() {
                if !name.starts_with('_') {
                    subdirs.push(path);
                }
                continue;
            }
            if !name.to_lowercase().ends_with(".png")
                || known.contains(&(sub.clone(), name.clone()))
            {
                continue;
            }
            let Ok((w, h)) = image::image_dimensions(&path) else {
                continue;
            };
            let p = read_params_file(&path).unwrap_or_else(|| json!({}));
            let g = |k: &str, d: Value| p.get(k).cloned().unwrap_or(d);
            let info = json!({
                "mode": g("mode", json!("imported")), "prompt": g("prompt_resolved", g("prompt", json!(""))),
                "negative": g("negative", json!("")), "seed": g("seed", Value::Null), "width": w, "height": h,
            });
            let Ok(iid) = db.add_image(&name, &sub, "output", &info, &p, None) else {
                continue;
            };
            if let Ok(mtime) = std::fs::metadata(&path).and_then(|m| m.modified()) {
                let secs = mtime
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(0.0);
                let _ = db.run(
                    "UPDATE images SET created=? WHERE id=?",
                    rusqlite::params![secs, iid],
                );
            }
            n += 1;
        }
        // os.walk 是由上而下、同一層照順序：反過來推進堆疊，先處理排前面的資料夾
        stack.extend(subdirs.into_iter().rev());
    }
    n
}
