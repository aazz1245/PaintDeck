//! 拆幀包含修圖成果，必須獨立確認；不納入一般「清除全部快取」。
use super::*;
use crate::cache::{Group, clear_files, safe_path};

fn all(_: &Path) -> bool { true }
fn payload(p: &Path) -> bool { p.file_name().is_none_or(|n| n != "meta.json") }

/// 僅移除固定範圍內的普通檔案與空目錄；碰到連結或讀取失敗就停止。
pub(super) fn remove_tree(anchor: &Path, dir: &Path) -> Result<(), String> {
    let group = Group::tree(anchor, dir, all);
    if group.skipped > 0 || !safe_path(anchor, dir) { return Err("拆幀資料夾含連結或無法讀取的檔案，未清除".into()); }
    let (_, _, skipped) = clear_files(&group);
    if skipped > 0 { return Err("部分拆幀檔案正在使用，請稍後重試".into()); }
    empty_dirs(anchor, dir)
}

fn empty_dirs(anchor: &Path, dir: &Path) -> Result<(), String> {
    if !safe_path(anchor, dir) { return Err("拆幀資料夾路徑不安全".into()); }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let p = entry.map_err(|e| e.to_string())?.path();
        if !safe_path(anchor, &p) { return Err("拆幀資料夾路徑不安全".into()); }
        if p.is_dir() { empty_dirs(anchor, &p)?; }
    }
    std::fs::remove_dir(dir).map_err(|e| e.to_string())
}

impl Frames {
    fn clean_targets(&self, root: &Path, scope: &str, sid: &str) -> Result<Vec<PathBuf>, String> {
        match scope {
            "session" => Ok(vec![self.dir(sid)?]),
            "trash" => {
                let dir = root.join("待刪除/拆幀台");
                if !dir.exists() { return Ok(vec![]); }
                if !safe_path(root, &dir) { return Err("待刪除的拆幀資料夾含連結，未清除".into()); }
                let mut targets = vec![];
                for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                    let p = entry.map_err(|e| e.to_string())?.path();
                    if p.join("meta.json").is_file() {
                        if !safe_path(root, &p.join("meta.json")) { return Err("待刪除的拆幀資料夾含連結，未清除".into()); }
                        targets.push(p);
                    }
                }
                Ok(targets)
            }
            _ => Err("清理範圍只能是 session 或 trash".into()),
        }
    }

    pub fn storage(&self, root: &Path, sid: &str) -> Result<Value, String> {
        let describe = |scope: &str| -> Result<Value, String> {
            let targets = self.clean_targets(root, scope, sid)?;
            let (mut bytes, mut skipped) = (0u64, 0usize);
            for p in &targets {
                let g = Group::tree(root, p, all);
                bytes = bytes.saturating_add(g.bytes); skipped += g.skipped;
            }
            let path = if scope == "session" { self.root.join(sid) } else { root.join("待刪除/拆幀台") };
            Ok(json!({"path": path, "bytes": bytes, "sessions": targets.len(), "skipped": skipped}))
        };
        Ok(json!({"session": if sid.is_empty() { Value::Null } else { describe("session")? }, "trash": describe("trash")?}))
    }

    /// 呼叫端持 frames_lock；確認完所有目標再刪。部分失敗時保留 meta，讓使用者能重試。
    pub fn clear(&self, root: &Path, scope: &str, sid: &str) -> Result<Value, String> {
        let targets = self.clean_targets(root, scope, sid)?;
        let groups: Vec<_> = targets.iter().map(|p| Group::tree(root, p, all)).collect();
        if groups.iter().any(|g| g.skipped > 0) { return Err("拆幀資料夾含連結或無法讀取的檔案，未清除".into()); }
        let (mut bytes, mut skipped, mut removed) = (0u64, 0usize, 0usize);
        for p in targets {
            let (b, _, s) = clear_files(&Group::tree(root, &p, payload));
            bytes += b; skipped += s;
            if s > 0 { continue; }
            let meta = p.join("meta.json");
            let (b, _, s) = clear_files(&Group::tree(root, &meta, all));
            bytes += b; skipped += s;
            if s == 0 {
                if empty_dirs(root, &p).is_ok() { removed += 1; } else { skipped += 1; }
            }
        }
        Ok(json!({"bytes": bytes, "skipped": skipped, "removed": removed}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../待刪除").join(format!("frames-clean-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(&root).unwrap(); root.canonicalize().unwrap()
    }
    fn put(p: &Path) { std::fs::create_dir_all(p.parent().unwrap()).unwrap(); std::fs::write(p, b"fixture").unwrap(); }
    #[test]
    fn cleanup_only_selected_session_and_trashed_frames() {
        let root = fixture();
        let f = Frames::new(&root.join("data"));
        for sid in ["one", "two"] { for name in ["meta.json", "f/1.png", "orig/1.png", "t/1.jpg", "audio.mka"] { put(&f.root.join(sid).join(name)); } }
        let keep = [root.join("original.mp4"), root.join("output/built.mp4"), root.join("待刪除/other/keep.png"), root.join("待刪除/拆幀台/unknown/note.txt")];
        for p in &keep { put(p); }
        assert_eq!(f.storage(&root, "one").unwrap()["session"]["bytes"], 35);
        assert!(f.clear(&root, "session", "../two").is_err());
        let r = f.clear(&root, "session", "one").unwrap();
        assert_eq!(r["bytes"], 35); assert_eq!(r["removed"], 1); assert!(!f.root.join("one").exists());
        assert!(f.root.join("two/meta.json").exists());
        for name in ["meta.json", "f/1.png"] { put(&root.join("待刪除/拆幀台/old").join(name)); }
        assert_eq!(f.clear(&root, "trash", "").unwrap()["removed"], 1);
        assert!(keep.iter().all(|p| p.is_file()));
    }
    #[cfg(windows)]
    #[test]
    fn cleanup_refuses_junction_before_deleting_any_frames() {
        let root = fixture(); let f = Frames::new(&root.join("data"));
        put(&f.root.join("one/meta.json")); put(&f.root.join("one/f/1.png")); put(&root.join("outside/keep.png"));
        let link = f.root.join("one/orig");
        let status = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&link).arg(root.join("outside")).output().unwrap();
        assert!(status.status.success());
        assert!(f.clear(&root, "session", "one").is_err());
        assert!(root.join("outside/keep.png").exists()); assert!(f.root.join("one/f/1.png").exists());
        std::fs::remove_dir(link).unwrap(); // 只拆除這個測試 junction。
    }
}
