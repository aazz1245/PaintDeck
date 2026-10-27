//! 接續選幀：候選以實際影格定位，裁切出點包含選中的影格。
use crate::pe::win;
use crate::studio::{self, Tools};
use serde_json::{json, Value};
use std::path::Path;
use std::process::{Command, Stdio};

pub fn candidate_frames(duration: f64, fps: f64) -> Result<Vec<u64>, String> {
    if !duration.is_finite() || duration <= 0.0 || !fps.is_finite() || fps <= 0.0 {
        return Err("影片的長度或影格率不正確".into());
    }
    let last = (duration * fps).ceil().max(1.0) as u64 - 1;
    let span = (1.5 * fps).round() as u64;
    let mut frames: Vec<u64> = (0..6).map(|i| last.saturating_sub(span * (5 - i) / 5)).collect();
    frames.dedup();
    Ok(frames)
}

fn checked_command(c: &mut Command) -> Result<(), String> {
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    win::no_window(c);
    let out = c.output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else {
        Err(format!("影片處理失敗：{}", String::from_utf8_lossy(&out.stderr).lines().rev().take(4).collect::<Vec<_>>().join(" / ")))
    }
}

pub fn extract(t: &Tools, src: &Path, dir: &Path, video_id: i64) -> Result<Value, String> {
    let p = studio::probe(t, src)?;
    // 讀取實際影格時間；不能用音軌長度或平均 fps 推算最後一格。
    let ffprobe = t.ffprobe.as_ref().ok_or("找不到 ffprobe")?;
    let mut probe = Command::new(ffprobe);
    probe.args(["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time,duration_time", "-of", "json"]).arg(src)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    win::no_window(&mut probe);
    let output = probe.output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err("讀不到影片的實際影格時間".into()); }
    let timing: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let stamps: Vec<(f64, f64)> = timing["frames"].as_array().into_iter().flatten().filter_map(|f| {
        let at = f["best_effort_timestamp_time"].as_str()?.parse::<f64>().ok()?;
        let duration = f["duration_time"].as_str().and_then(|d| d.parse::<f64>().ok()).filter(|d| *d > 0.0).unwrap_or(1.0 / p.fps);
        at.is_finite().then_some((at, duration))
    }).collect();
    let last = stamps.len().checked_sub(1).ok_or("影片沒有可讀取的影格")?;
    let first = stamps.iter().position(|s| s.0 >= stamps[last].0 - 1.5).unwrap_or(0);
    let mut frames: Vec<usize> = (0..6).map(|i| first + (last - first) * i / 5).collect();
    frames.dedup();
    let video_duration = stamps[last].0 + stamps[last].1;
    let ffmpeg = t.ffmpeg.as_ref().ok_or("找不到 ffmpeg：請先下載剪輯工具")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut candidates = vec![];
    for (k, frame) in frames.iter().enumerate() {
        let name = format!("v{video_id}_f{frame}.png");
        let dst = dir.join(&name);
        let time = stamps[*frame].0;
        let trim_out = stamps.get(*frame + 1).map(|s| s.0).unwrap_or(video_duration);
        let mut c = Command::new(ffmpeg);
        c.args(["-hide_banner", "-v", "error", "-y", "-i"]).arg(src)
            .args(["-vf", &format!("select=eq(n\\,{frame})"), "-fps_mode", "passthrough", "-frames:v", "1", "-update", "1"]).arg(&dst);
        checked_command(&mut c)?;
        if !dst.is_file() { return Err("讀不到候選影格，請改用拆幀台檢查影片".into()); }
        candidates.push(json!({"frame": frame, "time": time, "trim_out": trim_out,
            "file": name, "last": k + 1 == frames.len()}));
    }
    Ok(json!({"video_id": video_id, "duration": video_duration, "fps": p.fps, "candidates": candidates}))
}

/// 精確重編碼到選中影格的結束；保留可用音軌，不變更來源檔。
pub fn trim(t: &Tools, src: &Path, dst: &Path, out: f64) -> Result<(), String> {
    let p = studio::probe(t, src)?;
    if !out.is_finite() || out <= 0.0 || out > p.duration + 1.0 / p.fps {
        return Err("裁切出點超出影片範圍".into());
    }
    let ffmpeg = t.ffmpeg.as_ref().ok_or("找不到 ffmpeg：請先下載剪輯工具")?;
    let mut c = Command::new(ffmpeg);
    c.args(["-hide_banner", "-v", "error", "-y", "-i"]).arg(src)
        .args(["-t", &format!("{out:.9}"), "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-movflags", "+faststart"]).arg(dst);
    checked_command(&mut c)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidates_are_unique_monotonic_and_include_last_frame() {
        assert_eq!(candidate_frames(0.01, 24.0).unwrap(), [0]);
        let f = candidate_frames(5.0, 24.0).unwrap();
        assert_eq!(f.last(), Some(&119));
        assert!(f.windows(2).all(|p| p[0] < p[1]));
        assert!(f[0] >= 83);
        assert!(candidate_frames(f64::NAN, 24.0).is_err());
        assert!(candidate_frames(1.0, 0.0).is_err());
    }
}
