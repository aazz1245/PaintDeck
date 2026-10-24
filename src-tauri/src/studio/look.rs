//! 拆幀台的「觀測」：讓 AI（和人）把一支影片看清楚。
//!   - 對照表：放大、裁切局部、隔幾幀取一張，每格標幀號和「原片第幾秒」
//!   - 分析：每幀跟前一幀差多少、硬剪接、小跳動（接縫）、重複幀（補幀／定格）、每幀音量、鏡頭段落
//!   - 差異圖：兩幀並排＋差異熱度圖（哪裡動了一眼看出來）
//!   - 時間軸圖：變化量長條＋剪接點＋重複幀＋音量曲線＋秒數刻度
use super::*;
use image::imageops::FilterType;

/// 對照表一次最多幾格
const MAX_CELLS: usize = 100;
/// 對照表、時間軸圖的長邊上限（太大的圖 AI 也看不清）
const MAX_SIDE: u32 = 6000;
/// 分析用的縮圖寬（灰階）
const ANA_W: u32 = 64;

pub struct SheetOpts {
    pub from: u64,
    pub to: u64,
    /// 隔幾幀取一張（1＝每一幀）
    pub step: u64,
    pub cols: u32,
    /// 每格高幾像素（160 以下用縮圖，比較快；更高或有裁切就讀原圖）
    pub h: u32,
    /// 只看畫面的一塊：[x, y, w, h]，都是 0～1 的比例
    pub crop: Option<[f64; 4]>,
}

impl Default for SheetOpts {
    fn default() -> Self {
        SheetOpts { from: 1, to: 48, step: 1, cols: 8, h: THUMB_H, crop: None }
    }
}

/// "x,y,w,h"（0～1）→ 裁切比例；格式不對回 None
pub fn parse_crop(s: &str) -> Option<[f64; 4]> {
    let v: Vec<f64> = s.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    if v.len() != 4 {
        return None;
    }
    let [x, y, w, h] = [v[0], v[1], v[2], v[3]];
    let okv = |a: f64| (0.0..=1.0).contains(&a);
    (okv(x) && okv(y) && w > 0.0 && h > 0.0 && x + w <= 1.0001 && y + h <= 1.0001).then_some([x, y, w, h])
}

// ---------------------------------------------------------------- 小字（3×5 點陣）
fn glyph(c: char) -> Option<[u8; 5]> {
    Some(match c {
        '0'..='9' => DIGITS[c as usize - '0' as usize],
        '.' => [0, 0, 0, 0, 2],
        ':' => [0, 2, 0, 2, 0],
        '-' => [0, 0, 7, 0, 0],
        '/' => [1, 1, 2, 4, 4],
        ' ' => [0, 0, 0, 0, 0],
        _ => return None,
    })
}

/// 黑底黃字（k＝每個點幾像素）；認不得的字略過
pub(super) fn draw_text(img: &mut RgbImage, x0: u32, y0: u32, s: &str, k: u32, color: [u8; 3]) {
    let chars: Vec<[u8; 5]> = s.chars().filter_map(glyph).collect();
    let (bw, bh) = (chars.len() as u32 * 4 * k + k, 7 * k);
    for y in y0..(y0 + bh).min(img.height()) {
        for x in x0..(x0 + bw).min(img.width()) {
            img.put_pixel(x, y, image::Rgb([0, 0, 0]));
        }
    }
    for (i, d) in chars.iter().enumerate() {
        for (row, bits) in d.iter().enumerate() {
            for col in 0..3u32 {
                if bits & (4 >> col) == 0 {
                    continue;
                }
                for dy in 0..k {
                    for dx in 0..k {
                        let x = x0 + k + (i as u32 * 4 + col) * k + dx;
                        let y = y0 + k + row as u32 * k + dy;
                        if x < img.width() && y < img.height() {
                            img.put_pixel(x, y, image::Rgb(color));
                        }
                    }
                }
            }
        }
    }
}

fn jpeg(img: &RgbImage, q: u8) -> Result<Vec<u8>, String> {
    let mut buf = vec![];
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q)
        .encode_image(img)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn png(img: &RgbImage) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(vec![]);
    img.write_to(&mut buf, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

fn crop_frac(im: DynamicImage, c: [f64; 4]) -> DynamicImage {
    let (w, h) = im.dimensions();
    let x = (c[0] * w as f64).round() as u32;
    let y = (c[1] * h as f64).round() as u32;
    let cw = ((c[2] * w as f64).round() as u32).clamp(1, w.saturating_sub(x).max(1));
    let ch = ((c[3] * h as f64).round() as u32).clamp(1, h.saturating_sub(y).max(1));
    im.crop_imm(x.min(w - 1), y.min(h - 1), cw, ch)
}

fn to_h(im: DynamicImage, h: u32) -> DynamicImage {
    let (w0, h0) = im.dimensions();
    if h0 == h {
        return im;
    }
    let w = ((w0 as f64 * h as f64 / h0.max(1) as f64).round() as u32).max(1);
    im.resize_exact(w, h, FilterType::Triangle)
}

impl Frames {
    /// 第 n 幀在原片的第幾秒（拆的時候有指定 start 就加上去）
    fn src_t(m: &Value, n: u64) -> f64 {
        let fps = m["fps"].as_f64().filter(|f| *f > 0.0).unwrap_or(24.0);
        m["range"]["start"].as_f64().unwrap_or(0.0) + (n.saturating_sub(1)) as f64 / fps
    }

    /// 對照表：每格左上角兩行字＝幀號、原片第幾秒
    pub fn sheet_ex(&self, sid: &str, o: &SheetOpts) -> Result<Vec<u8>, String> {
        let m = self.meta(sid)?;
        let total = m["frames"].as_u64().unwrap_or(0);
        let (from, step) = (o.from.max(1), o.step.max(1));
        let to = o.to.min(total);
        if from > to {
            return Err(format!("範圍不對（共 {total} 幀）"));
        }
        let ns: Vec<u64> = (from..=to).step_by(step as usize).take(MAX_CELLS).collect();
        let d = self.dir(sid)?;
        let full = o.h > THUMB_H || o.crop.is_some();
        let cols = o.cols.clamp(1, 12).min(ns.len() as u32);
        let rows = (ns.len() as u32).div_ceil(cols);
        let gap = 4;
        // 太大就自動縮格子（長邊不超過 MAX_SIDE）
        let mut h = o.h.clamp(48, 1080);
        h = h.min(MAX_SIDE / rows - gap);
        let cells: Vec<(u64, DynamicImage)> = ns
            .iter()
            .filter_map(|&n| {
                let p = d.join(if full { "f" } else { "t" }).join(name(n, if full { "png" } else { "jpg" }));
                let im = image::open(p).ok()?;
                let im = match o.crop {
                    Some(c) => crop_frac(im, c),
                    None => im,
                };
                Some((n, im))
            })
            .collect();
        let first = cells.first().ok_or("讀不到幀")?.1.dimensions();
        let mut cw = ((first.0 as f64 * h as f64 / first.1.max(1) as f64).round() as u32).max(1);
        if cols * (cw + gap) + gap > MAX_SIDE {
            cw = MAX_SIDE / cols - gap;
            h = ((cw as f64 * first.1 as f64 / first.0.max(1) as f64).round() as u32).max(1);
        }
        let mut out = RgbImage::from_pixel(cols * (cw + gap) + gap, rows * (h + gap) + gap, image::Rgb([40, 40, 40]));
        let k = if h >= 320 { 3 } else { 2 };
        for (i, (n, im)) in cells.into_iter().enumerate() {
            let (x, y) = (gap + (i as u32 % cols) * (cw + gap), gap + (i as u32 / cols) * (h + gap));
            let im = im.resize_exact(cw, h, FilterType::Triangle).to_rgb8();
            image::imageops::overlay(&mut out, &im, x as i64, y as i64);
            draw_text(&mut out, x, y, &n.to_string(), k, [255, 230, 80]);
            draw_text(&mut out, x, y + 7 * k, &format!("{:.2}", Self::src_t(&m, n)), k, [140, 220, 255]);
        }
        jpeg(&out, 85)
    }

    /// 每幀的灰階小圖（分析用）
    fn luma_small(&self, d: &Path, n: u64) -> Option<(u32, u32, Vec<u8>)> {
        let im = image::open(d.join("t").join(name(n, "jpg"))).ok()?;
        let (w, h) = im.dimensions();
        let ah = ((ANA_W as f64 * h as f64 / w.max(1) as f64).round() as u32).max(1);
        let g = im.resize_exact(ANA_W, ah, FilterType::Triangle).to_luma8();
        Some((ANA_W, ah, g.into_raw()))
    }

    /// 每幀的音量（dBFS），沒有聲音回空的
    fn loudness(&self, t: &Tools, d: &Path, frames: u64, fps: f64) -> Vec<f64> {
        let a = d.join("audio.mka");
        if !a.is_file() {
            return vec![];
        }
        let Ok(ff) = t.ffmpeg() else { return vec![] };
        let Ok(raw) = run(
            ff,
            &[os("-v"), os("error"), os("-i"), a.into_os_string(), os("-ac"), os("1"), os("-ar"), os("16000"), os("-f"), os("s16le"), os("-")],
        ) else {
            return vec![];
        };
        let s: Vec<f64> = raw.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b) as f64 / 32768.0).collect();
        let per = 16000.0 / fps;
        (0..frames)
            .map(|i| {
                let (a, b) = ((i as f64 * per) as usize, (((i + 1) as f64 * per) as usize).min(s.len()));
                if a >= b {
                    return -90.0;
                }
                let rms = (s[a..b].iter().map(|x| x * x).sum::<f64>() / (b - a) as f64).sqrt();
                ((20.0 * (rms + 1e-9).log10()) * 10.0).round() / 10.0
            })
            .collect()
    }

    /// 分析整份：結果存在 analysis.json，幀沒換過就直接用
    pub fn analyze(&self, t: &Tools, sid: &str) -> Result<Value, String> {
        let m = self.meta(sid)?;
        let d = self.dir(sid)?;
        let key = m["rev"].to_string();
        let cache = d.join("analysis.json");
        if let Some(v) = std::fs::read(&cache).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            if v["rev_key"].as_str() == Some(key.as_str()) && v["version"] == ANA_VERSION {
                return Ok(v);
            }
        }
        let total = m["frames"].as_u64().unwrap_or(0);
        let fps = m["fps"].as_f64().filter(|f| *f > 0.0).unwrap_or(24.0);
        let mut score = vec![0.0f64; total as usize];
        let mut prev: Option<Vec<u8>> = None;
        for n in 1..=total {
            let cur = self.luma_small(&d, n).map(|x| x.2);
            if let (Some(a), Some(b)) = (&prev, &cur) {
                if a.len() == b.len() && !a.is_empty() {
                    let s: u64 = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y) as u64).sum();
                    score[(n - 1) as usize] = ((s as f64 / a.len() as f64 / 255.0 * 100.0) * 100.0).round() / 100.0;
                }
            }
            prev = cur;
        }
        let ana = analyze_scores(&score, fps, |n| Self::src_t(&m, n));
        let loud = self.loudness(t, &d, total, fps);
        let mut v = json!({
            "version": ANA_VERSION, "rev_key": key, "id": sid, "frames": total, "fps": fps,
            "start": m["range"]["start"].as_f64().unwrap_or(0.0),
            "how": "score＝這一幀跟前一幀的平均差異（0～100，灰階 64 寬小圖）。cut＝硬剪接；jump＝比附近大很多的小跳動（常是接縫、掉幀、閃一下）；dup＝跟前一幀幾乎一樣（補幀、定格、低幀率放大）。t＝這份裡第幾秒，src_t＝原片第幾秒。",
            "score": score, "loud_db": loud,
        });
        if let (Some(o), Some(a)) = (v.as_object_mut(), ana.as_object()) {
            for (k, x) in a {
                o.insert(k.clone(), x.clone());
            }
        }
        let _ = std::fs::write(&cache, serde_json::to_vec(&v).unwrap_or_default());
        Ok(v)
    }

    /// 兩幀並排＋差異熱度圖（差越多越紅黃）
    pub fn diff(&self, sid: &str, a: u64, b: u64, h: u32, crop: Option<[f64; 4]>) -> Result<Vec<u8>, String> {
        let m = self.meta(sid)?;
        Self::check_n(&m, a)?;
        Self::check_n(&m, b)?;
        let load = |n: u64| -> Result<RgbImage, String> {
            let im = image::open(self.frame_path(sid, n, false)?).map_err(|e| e.to_string())?;
            let im = match crop {
                Some(c) => crop_frac(im, c),
                None => im,
            };
            Ok(to_h(im, h.clamp(120, 1080)).to_rgb8())
        };
        let (x, y) = (load(a)?, load(b)?);
        let (w, hh) = x.dimensions();
        let heat = RgbImage::from_fn(w, hh, |i, j| {
            let (p, q) = (x.get_pixel(i, j), y.get_pixel(i, j));
            let d: u32 = (0..3).map(|c| p[c].abs_diff(q[c]) as u32).sum::<u32>() * 4 / 3;
            let d = d.min(255) as u8;
            // 黑 → 紅 → 黃 → 白
            image::Rgb([d.saturating_mul(2), d.saturating_sub(96).saturating_mul(2), d.saturating_sub(192).saturating_mul(4)])
        });
        let gap = 6;
        let mut out = RgbImage::from_pixel(w * 3 + gap * 4, hh + gap * 2, image::Rgb([40, 40, 40]));
        for (i, im) in [&x, &y, &heat].into_iter().enumerate() {
            image::imageops::overlay(&mut out, im, (gap + i as u32 * (w + gap)) as i64, gap as i64);
        }
        let k = if hh >= 320 { 3 } else { 2 };
        draw_text(&mut out, gap, gap, &a.to_string(), k, [255, 230, 80]);
        draw_text(&mut out, gap + w + gap, gap, &b.to_string(), k, [255, 230, 80]);
        draw_text(&mut out, gap + 2 * (w + gap), gap, &format!("{a}-{b}"), k, [255, 120, 120]);
        jpeg(&out, 88)
    }

    /// 時間軸圖：上面變化量長條（紅線＝硬剪接、橘線＝小跳動、藍點＝重複幀）、下面音量曲線、底下秒數（原片）
    pub fn graph(&self, t: &Tools, sid: &str, from: u64, to: u64, w: u32) -> Result<Vec<u8>, String> {
        let a = self.analyze(t, sid)?;
        let total = a["frames"].as_u64().unwrap_or(0);
        let (from, to) = (from.max(1), to.min(total));
        if from >= to {
            return Err(format!("範圍不對（共 {total} 幀）"));
        }
        let m = self.meta(sid)?;
        let n = (to - from + 1) as u32;
        let w = w.clamp(400, MAX_SIDE);
        let (top, mid, bot) = (220u32, 90u32, 26u32);
        let mut img = RgbImage::from_pixel(w, top + mid + bot, image::Rgb([24, 24, 28]));
        let xs = |f: u64| (((f - from) as f64 + 0.5) / n as f64 * w as f64) as u32;
        let score: Vec<f64> = a["score"].as_array().map(|v| v.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect()).unwrap_or_default();
        let loud: Vec<f64> = a["loud_db"].as_array().map(|v| v.iter().map(|x| x.as_f64().unwrap_or(-90.0)).collect()).unwrap_or_default();
        // 長條用開根號（小跳動也看得到），頂端＝這段的最大值
        let mx = (from..=to).map(|f| score.get(f as usize - 1).copied().unwrap_or(0.0)).fold(0.5, f64::max).sqrt();
        let line = |img: &mut RgbImage, x: u32, y0: u32, y1: u32, c: [u8; 3]| {
            for y in y0..y1.min(img.height()) {
                if x < img.width() {
                    img.put_pixel(x, y, image::Rgb(c));
                }
            }
        };
        for f in from..=to {
            let s = score.get(f as usize - 1).copied().unwrap_or(0.0);
            let bh = ((s.sqrt() / mx) * (top - 10) as f64) as u32;
            let x0 = xs(f);
            let x1 = xs(f + 1).max(x0 + 1);
            for x in x0..x1 {
                line(&mut img, x, top - bh, top, [200, 200, 210]);
            }
        }
        let mark = |img: &mut RgbImage, key: &str, c: [u8; 3]| {
            for e in a[key].as_array().into_iter().flatten() {
                let f = e["n"].as_u64().unwrap_or(0);
                if (from..=to).contains(&f) {
                    // 2 像素寬的線＋頂端 8×10 的色塊（縮小看也找得到）
                    let x = xs(f);
                    for xx in x.saturating_sub(1)..=x {
                        line(img, xx, 0, top, c);
                    }
                    for xx in x.saturating_sub(4)..x + 4 {
                        line(img, xx, 0, 10, c);
                    }
                }
            }
        };
        mark(&mut img, "jumps", [255, 160, 40]);
        mark(&mut img, "cuts", [255, 60, 60]);
        for f in a["dup_frames"].as_array().into_iter().flatten().filter_map(|x| x.as_u64()) {
            if (from..=to).contains(&f) {
                let x = xs(f);
                for y in top - 6..top {
                    line(&mut img, x, y, y + 1, [80, 160, 255]);
                }
            }
        }
        // 音量：-60～0 dB
        if !loud.is_empty() {
            let mut last: Option<(u32, u32)> = None;
            for f in from..=to {
                let db = loud.get(f as usize - 1).copied().unwrap_or(-90.0).clamp(-60.0, 0.0);
                let y = top + mid - 4 - ((db + 60.0) / 60.0 * (mid - 8) as f64) as u32;
                let x = xs(f);
                if let Some((px, py)) = last {
                    let (y0, y1) = (py.min(y), py.max(y) + 1);
                    for xx in px..=x {
                        line(&mut img, xx, y0, y1, [90, 220, 120]);
                    }
                }
                last = Some((x, y));
            }
        }
        // 秒數刻度：大約 12 格
        let fps = a["fps"].as_f64().unwrap_or(24.0);
        let span = n as f64 / fps;
        let tick = [0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 15.0, 30.0, 60.0].into_iter().find(|s| span / s <= 14.0).unwrap_or(120.0);
        let t0 = Self::src_t(&m, from);
        let mut s = (t0 / tick).ceil() * tick;
        while s <= Self::src_t(&m, to) {
            let f = from + ((s - t0) * fps).round() as u64;
            let x = xs(f.min(to));
            line(&mut img, x, top + mid, top + mid + 6, [160, 160, 160]);
            draw_text(&mut img, x.saturating_sub(4), top + mid + 7, &format!("{}", (s * 100.0).round() / 100.0), 2, [200, 200, 200]);
            s += tick;
        }
        draw_text(&mut img, 2, 2, &format!("{from}-{to}"), 2, [255, 230, 80]);
        png(&img)
    }
}

const ANA_VERSION: u32 = 1;

fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    s[s.len() / 2]
}

/// 從每幀變化量找：硬剪接、小跳動、重複幀、鏡頭段落（純計算，好測）
fn analyze_scores(score: &[f64], fps: f64, src_t: impl Fn(u64) -> f64) -> Value {
    let total = score.len();
    let med = median(&score[1.min(total)..]);
    let win = (fps * 0.5).round().max(3.0) as usize; // 前後半秒
    let mut cuts = vec![];
    let mut jumps = vec![];
    for i in 1..total {
        let s = score[i];
        let (a, b) = (i.saturating_sub(win).max(1), (i + win + 1).min(total));
        let around: Vec<f64> = (a..b).filter(|&j| j != i).map(|j| score[j]).collect();
        let local = median(&around);
        let peak = around.iter().all(|x| s >= *x);
        let e = |kind: &str| json!({"n": i + 1, "t": (i as f64 / fps * 100.0).round() / 100.0, "src_t": (src_t(i as u64 + 1) * 100.0).round() / 100.0, "score": s, "kind": kind});
        if peak && s >= 12.0 && s >= 4.0 * local {
            cuts.push(e("cut"));
        } else if peak && s >= 1.5 && s >= 5.0 * local.max(0.2) {
            jumps.push(e("jump"));
        }
    }
    // 重複幀：比整支中位數小很多、而且幾乎沒動
    let dup_th = (med * 0.15).clamp(0.05, 0.5);
    let dups: Vec<u64> = (1..total).filter(|&i| score[i] <= dup_th).map(|i| i as u64 + 1).collect();
    let mut gaps = std::collections::BTreeMap::<u64, u64>::new();
    for w in dups.windows(2) {
        *gaps.entry(w[1] - w[0]).or_default() += 1;
    }
    let mut common: Vec<(u64, u64)> = gaps.into_iter().collect();
    common.sort_by_key(|a| std::cmp::Reverse(a.1));
    common.truncate(4);
    // 鏡頭段落：用硬剪接切開
    let mut shots = vec![];
    let mut s0 = 1u64;
    for c in cuts.iter().filter_map(|c| c["n"].as_u64()).chain([total as u64 + 1]) {
        if c > s0 {
            let n = c - s0;
            shots.push(json!({"from": s0, "to": c - 1, "frames": n, "secs": (n as f64 / fps * 100.0).round() / 100.0,
                              "src_t": (src_t(s0) * 100.0).round() / 100.0}));
        }
        s0 = c;
    }
    let dup_ratio = if total > 1 { dups.len() as f64 / (total - 1) as f64 } else { 0.0 };
    json!({
        "median": med,
        "cuts": cuts, "jumps": jumps, "shots": shots,
        "dups": {"count": dups.len(), "ratio": (dup_ratio * 1000.0).round() / 1000.0, "threshold": dup_th,
                 "common_gaps": common.iter().map(|(g, c)| json!([g, c])).collect::<Vec<_>>(),
                 "hint": "common_gaps 是兩個重複幀之間最常見的距離：一直是 5 → 很可能 24fps 硬轉 30fps；一直是 2 → 原本只有一半幀率"},
        "dup_frames": dups,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crops() {
        assert_eq!(parse_crop("0.25,0,0.5,0.5"), Some([0.25, 0.0, 0.5, 0.5]));
        assert_eq!(parse_crop("0.8,0,0.5,0.5"), None); // 超出右邊
        assert_eq!(parse_crop("1,2,3"), None);
        let im = DynamicImage::new_rgb8(200, 100);
        assert_eq!(crop_frac(im, [0.5, 0.5, 0.5, 0.5]).dimensions(), (100, 50));
    }

    #[test]
    fn finds_cuts_jumps_and_dups() {
        // 30fps、6 秒：平常 0.8；第 60 幀硬剪接 30；第 120 幀小跳動 5；每 5 幀一個重複幀（0.01）
        let mut s = vec![0.8; 180];
        s[0] = 0.0;
        for i in (4..180).step_by(5) {
            s[i] = 0.01;
        }
        s[59] = 30.0;
        s[119] = 5.0;
        let v = analyze_scores(&s, 30.0, |n| 10.0 + (n - 1) as f64 / 30.0);
        let cuts: Vec<u64> = v["cuts"].as_array().unwrap().iter().map(|c| c["n"].as_u64().unwrap()).collect();
        let jumps: Vec<u64> = v["jumps"].as_array().unwrap().iter().map(|c| c["n"].as_u64().unwrap()).collect();
        assert_eq!(cuts, vec![60]);
        assert_eq!(jumps, vec![120]);
        assert_eq!(v["cuts"][0]["src_t"], 11.97);
        assert_eq!(v["dups"]["common_gaps"][0][0], 5);
        assert_eq!(v["shots"].as_array().unwrap().len(), 2);
        assert_eq!(v["shots"][1]["from"], 60);
    }

    #[test]
    fn text_draws() {
        let mut im = RgbImage::new(80, 30);
        draw_text(&mut im, 0, 0, "12.5:-/", 2, [255, 0, 0]);
        assert!(im.pixels().any(|p| p[0] == 255));
    }
}
