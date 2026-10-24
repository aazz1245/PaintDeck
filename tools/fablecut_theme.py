"""剪輯台（FableCut）換成生圖站的外觀：讀它原本的 style.css，產生 anima-style.css，index.html 改成載入這一份。

FableCut 本體不動（resources\\extras\\fablecut 是原封不動的 1.15.0）；升級 FableCut 之後重跑這支就好：
    python tools\\fablecut_theme.py

配色走生圖站深色那套（design\\cassette.html 的「飛船主控台」：暖黑機身、琥珀／橘色重點、螢光綠資訊）。
生圖站淺色模式下的觀景窗本來就是深色螢幕，剪輯台當成嵌進機身的一塊螢幕，兩種模式都一致。
規則（app.css 開頭）：不要藍紫色漸層、字一定要清楚。
"""
import colorsys
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FC = ROOT / "resources" / "extras" / "fablecut"

# 生圖站深色（ui\css\app.css 的 :root[data-theme="dark"]）
VARS = """:root {
  /* Anima 生圖站的外觀（tools\\fablecut_theme.py 產生，不要手改） */
  --bg: #0e0d0c;
  --panel: #1d1c19;
  --panel-2: #26251f;
  --border: #3c3a34;
  --text: #e1dac6;
  --dim: #a39b88;
  --accent: #e2a72b;
  --accent-2: #e6742c;
  --danger: #e0533f;
  --clip-video: linear-gradient(180deg, #e2a72b22, #e2a72b11), #5c4419;
  --track-h-video: 58px;
  --track-h-audio: 42px;
  --side-panel-w: 320px;
  color-scheme: dark;
}"""

# 藍紫色 → 生圖站的琥珀／橘／綠（小寫、不含透明度；透明度原樣保留）
MAP = {
    "7b6cff": "e2a72b",  # 主色紫 → 琥珀
    "4f8cff": "e6742c",  # 第二主色藍 → 橘
    "3d5afe": "e2a72b",
    "4c66ff": "e2a72b", "273575": "5c4419", "2b3b8f": "5c4419",  # 影片片段
    "5ad1ff": "8dffb0", "1d4f63": "1f4a33",  # 圖形片段 → 螢光綠
    "c084fc": "e6742c", "4c2a73": "5a2f1c",  # 合成片段 → 橘
    "38bdf8": "ffb547", "155e75": "6b4a2b",  # 調整片段
    "cfc8ff": "ffd28a", "b9baff": "ffd28a", "b9b3ff": "ffd28a", "cfd0ff": "ffd28a",  # 淡紫字 → 淡琥珀
    "e8e8ff": "fff1d0", "e9d5ff": "fff1d0", "f3e8ff": "fff1d0",
    "9a8fff": "f0b84a", "8d80ff": "f0b84a", "b0a6ff": "f5c565", "c58cff": "e6742c",
    "e5484d": "e0533f",
}
# 色相環滑桿（#f33 … #f3f）是真的要彩虹色，不換
KEEP = {"33f", "f3f", "f33", "ff3", "3f3", "3ff"}

# 生圖站的補充樣式（接在最後面）
EXTRA = """
/* ================= Anima 生圖站外皮的補充（tools\\fablecut_theme.py） ================= */
/* 琥珀底上的字用深色（白字看不清楚） */
.logo-mark, .btn.primary, .monitor-mode .btn.on, #btnPlay.on { color: #1a1408; }
.btn.primary:hover { filter: brightness(1.08); }
/* 按鍵：跟生圖站一樣有一點厚度，按下去會沉 */
.btn { box-shadow: 0 2px 0 #0a0a08; }
.btn:active { box-shadow: 0 1px 0 #0a0a08; }
.btn.ghost { box-shadow: none; }
/* 面板：生圖站機身的凹槽感 */
.topbar, .panel { box-shadow: inset 0 1px 0 #3c3a34, inset 0 -1px 0 #0a0a08; }
/* 時間碼：跟生圖站的螢幕字一樣用琥珀 */
.timecode { color: #ffb547; }
* { scrollbar-color: #4a463d #1b1a17; }
"""


def warm_gray(r, g, b):
    """冷灰（帶藍）換成生圖站的暖灰：亮度不變，色相 43°，暗的幾乎沒彩度、亮的帶一點米色"""
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    ns = 0.07 if l < 0.5 else min(0.28, 0.12 + (l - 0.5) * 0.45)
    nr, ng, nb = colorsys.hls_to_rgb(43 / 360, l, ns)
    return "%02x%02x%02x" % (round(nr * 255), round(ng * 255), round(nb * 255))


def recolor(m):
    h = m.group(1).lower()
    if h in KEEP:
        return m.group(0)
    if len(h) in (3, 4):
        base, alpha = "".join(c * 2 for c in h[:3]), (h[3] * 2 if len(h) == 4 else "")
    elif len(h) in (6, 8):
        base, alpha = h[:6], h[6:]
    else:
        return m.group(0)
    if base in MAP:
        return "#" + MAP[base] + alpha
    r, g, b = (int(base[i:i + 2], 16) for i in (0, 2, 4))
    hh, ll, ss = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    if base in ("000000", "ffffff") or ss > 0.25 or ll < 0.03 or ll > 0.97:
        return m.group(0)  # 黑、白、本來就有顏色的（黃、綠、紅…）不動
    if not (0.5 < hh < 0.8 or ss < 0.04):
        return m.group(0)  # 本來就是暖色系的灰
    return "#" + warm_gray(r, g, b) + alpha


def main():
    src = (FC / "style.css").read_text(encoding="utf-8")
    root = re.search(r":root\s*\{[^}]*\}", src)
    if not root or "--accent" not in root.group(0):
        sys.exit("style.css 的 :root 跟預期不一樣（FableCut 改版了？），請先看過再改這支程式")
    out = src[:root.start()] + VARS + src[root.end():]
    out = re.sub(r"#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b", recolor, out)
    # 中文字用正黑體（FableCut 原本只寫 Segoe UI，中文會退回新細明體）
    out = out.replace('"Segoe UI"', '"Segoe UI", "Microsoft JhengHei UI"')
    out = out.replace("ui-sans-serif, system-ui", 'ui-sans-serif, "Microsoft JhengHei UI", system-ui')
    out = "/* 由 tools\\fablecut_theme.py 從 FableCut 的 style.css 產生，不要手改 */\n" + out + EXTRA
    (FC / "anima-style.css").write_text(out, encoding="utf-8", newline="\n")

    idx = (FC / "index.html").read_text(encoding="utf-8")
    old = '<link rel="stylesheet" href="style.css">'
    new = '<link rel="stylesheet" href="anima-style.css"><!-- Anima 生圖站：換成生圖站外觀（tools\\fablecut_theme.py） -->'
    if new not in idx:
        if old not in idx:
            sys.exit("index.html 找不到 style.css 那一行（FableCut 改版了？）")
        idx = idx.replace(old, new, 1)
    idx = idx.replace('<meta name="theme-color" content="#0e0e10">', '<meta name="theme-color" content="#0e0d0c">')
    (FC / "index.html").write_text(idx, encoding="utf-8", newline="\n")
    left = sorted(set(re.findall(r"#7b6cff|#4f8cff|#cfc8ff", out, re.I)))
    print("anima-style.css", len(out), "bytes；還剩的紫藍色：", left or "沒有")


if __name__ == "__main__":
    main()
