//! 改名接手只讀位置與圖庫筆數；不搬檔、不解除安裝、不讀圖片或金鑰。
use super::*;

pub(super) fn normalize_data_root(path: &Path, mode: Option<&str>) -> PathBuf {
    if mode == Some("reuse") && path.file_name().is_some_and(|s| s.eq_ignore_ascii_case("data"))
        && path.join("anima.db").is_file()
    {
        return path.parent().unwrap_or(path).to_path_buf();
    }
    path.to_path_buf()
}

pub(super) fn data_info(root: &Path) -> Value {
    let db = root.join("data/anima.db");
    let images = if db.is_file() { image_count(root) } else { None };
    let status = if images.is_some() { Ok(()) }
        else if db.exists() { Err("找到了圖庫資料庫，但目前讀不到；請確認權限或關閉舊版後再試，不會建立空白圖庫取代它") }
        else if !root.exists() { Err("原資料位置不存在，可能磁碟未連接或資料夾已搬動；請指定原本的資料位置") }
        else { Err("這裡找不到生圖站的圖庫資料庫；請選包含 data 資料夾的那一層") };
    json!({"path": root, "valid": images.is_some(), "images": images, "problem": status.err()})
}

pub(super) fn validate_choice(root: &Path, mode: Option<&str>) -> Result<(), String> {
    if !matches!(mode, None | Some("reuse" | "new")) { return Err("資料使用方式只能是 reuse 或 new".into()); }
    let info = data_info(root);
    if mode == Some("reuse") && info["valid"] != true {
        return Err(info["problem"].as_str().unwrap_or("無法確認資料位置，請重新檢查").into());
    }
    if mode == Some("new") && info["valid"] == true {
        return Err("這個位置已經有圖庫，請改選「沿用這份資料」，或另選全新的位置".into());
    }
    if mode != Some("reuse") && root.join("anima.db").is_file() {
        return Err("選到了資料庫所在的內層，請改選「自己指定舊資料」，避免建立 data 裡面的另一層 data".into());
    }
    // 即使是舊客戶端，讀不到既有 DB 也不能當成全新安裝。
    if root.join("data/anima.db").exists() && info["valid"] != true {
        return Err(info["problem"].as_str().unwrap_or("無法確認資料位置，請重新檢查").into());
    }
    Ok(())
}

pub(super) fn installations() -> Vec<Value> {
    let mut items: Vec<Value> = vec![];
    for (query, label) in [("anima 生圖站", "Anima 生圖站"), ("paintdeck", "繪匣 PaintDeck")] {
        for path in uninstall_locations(query) {
            if items.iter().any(|v| v["name"] == label && v["path"].as_str().is_some_and(|p| crate::model_dirs::same(Path::new(p), &path))) { continue; }
            items.push(json!({"name": label, "exists": path.is_dir(), "path": path, "legacy": query.starts_with("anima")}));
        }
    }
    items
}

/// 原設定不受三層掃描限制；安裝位置附近只當線索，不能把程式目錄當資料目錄。
pub(super) fn include_known(current: Option<&Config>, installs: &[Value], program: Option<&Path>, data: &mut Vec<PathBuf>, comfy: &mut Vec<PathBuf>) {
    let add = |list: &mut Vec<PathBuf>, path: PathBuf| {
        if !list.iter().any(|p| crate::model_dirs::same(p, &path)) { list.push(path); }
    };
    if let Some(c) = current {
        add(data, c.data_root.clone());
        if comfy_install(&c.comfy_dir) { add(comfy, c.comfy_dir.clone()); }
    }
    let locations = installs.iter().filter_map(|v| v["path"].as_str().map(PathBuf::from))
        .chain(program.map(Path::to_path_buf));
    for dir in locations {
        for base in [Some(dir.as_path()), dir.parent()].into_iter().flatten() {
            for root in [base.to_path_buf(), base.join("anima_data")] {
                if root.join("data/anima.db").is_file() { add(data, root); }
            }
            let c = base.join("ComfyUI_windows_portable");
            if comfy_install(&c) { add(comfy, c); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../待刪除").join(format!("reuse-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&p).unwrap(); p.canonicalize().unwrap()
    }
    fn database(root: &Path) {
        std::fs::create_dir_all(root.join("data")).unwrap();
        let c = rusqlite::Connection::open(root.join("data/anima.db")).unwrap();
        c.execute_batch("CREATE TABLE images(id INTEGER PRIMARY KEY, trashed TEXT); INSERT INTO images VALUES(1,NULL);").unwrap();
    }
    #[test]
    fn reuse_never_recreates_missing_or_unreadable_gallery() {
        let root = fixture(); let missing = root.join("missing");
        assert!(validate_choice(&missing, Some("reuse")).is_err()); assert!(!missing.exists());
        database(&root); let before = std::fs::read(root.join("data/anima.db")).unwrap();
        assert_eq!(data_info(&root)["images"], 1);
        assert!(validate_choice(&root, Some("reuse")).is_ok());
        assert!(validate_choice(&root, Some("new")).is_err());
        assert_eq!(std::fs::read(root.join("data/anima.db")).unwrap(), before);
        std::fs::write(root.join("data/anima.db"), b"broken fixture").unwrap();
        assert!(validate_choice(&root, None).is_err());
        assert!(validate_choice(&root, Some("reuse")).is_err());
        assert_eq!(std::fs::read(root.join("data/anima.db")).unwrap(), b"broken fixture");
    }
    #[test]
    fn inner_data_folder_is_normalized_only_for_reuse() {
        let root = fixture(); database(&root); let inner = root.join("data");
        assert_eq!(normalize_data_root(&inner, Some("reuse")), root);
        assert_eq!(normalize_data_root(&inner, Some("new")), inner);
        assert!(validate_choice(&inner, Some("new")).is_err());
        assert!(!inner.join("data").exists());
    }
    #[test]
    fn known_paths_are_deduplicated_and_missing_current_is_kept_as_warning() {
        let base = fixture(); let root = base.join("deep/a/b/c/anima_data"); database(&root);
        let current = Config { data_root: base.join("missing"), comfy_dir: base.join("comfy") };
        let installs = vec![json!({"path":root.parent().unwrap().join("PaintDeck")})];
        let mut data = vec![root.clone()]; let mut comfy = vec![];
        include_known(Some(&current), &installs, None, &mut data, &mut comfy);
        assert_eq!(data.len(), 2); assert!(data.contains(&current.data_root));
        assert!(comfy.is_empty()); assert!(!current.data_root.exists());
    }
}
