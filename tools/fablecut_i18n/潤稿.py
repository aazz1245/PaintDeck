"""剪輯台譯文潤稿：讀 譯稿\\done_*.json（sonnet 分批翻的初稿）→ 統一用詞、改大陸用語、分隔符、中英文之間補空白 → 套小克的逐句修改（下面 FIX）
→ 寫成 zh_src.json（fablecut_i18n.py build 用的正式字典）和 args.json（句型變數專用的小字典）。可以重跑：初稿不動，改的東西都在這支裡。
    C:\\Users\\User\\AppData\\Local\\Python\\bin\\python -I -X utf8 tools\\fablecut_i18n\\潤稿.py
"""
import html
import json
import pathlib
import re

D = pathlib.Path(__file__).resolve().parent

# 各批翻得不一樣的詞：統一成一種（照順序換）
TERMS = [
    ("收藏集", "素材集"),
    ("入場", "進場"), ("退場", "出場"),
    ("匯出範圍框", "匯出框"), ("範圍框", "匯出框"),
    ("點擊", "按一下"), ("雙擊", "按兩下"), ("連按兩下", "按兩下"),
    ("母片", "母帶"), ("主檔", "母帶"),
    ("音頻", "音訊"), ("視頻", "影片"),
    ("關閉空隙", "移除空隙"), ("閉合", "封閉"),
    ("把手", "控制桿"),
    ("時長", "長度"), ("時間長度", "長度"),
    ("色度鍵", "色度去背"), ("摳圖", "去背"),
    ("標誌動畫", "Logo 動畫"),
    ("主混音", "主輸出"),
    ("精確到幀", "逐幀精準"),
]

# 逐句修改（英文原文 → 譯文；None＝不翻）。2026-10-20 小克逐句審過全部 1,706 句後寫的。
FIX = {
    # 初稿就有的
    "DUR": "長度",
    "IN–OUT": "入點–出點",
    "fade {0} {1}s": "{0} {1} 秒",
    # 句型、變數
    '"{0}" {1} {2}–{3} s ({4} samples)': "「{0}」{1} {2}–{3} 秒（{4} 個取樣點）",
    "Imported {0}": "已匯入 {0}",  # toast("Imported " + 檔名)
    "Imported": "已匯入",
    "Tokens: {0}": "檔名代號：{0}",  # "Tokens: " + 清單
    "Tokens:": "檔名代號：",
    "{0} effects": "{0} 的效果",  # Master／A1／匯流排名稱 + effects
    "{5} effects": "{5} 的效果",
    "{0} of {1}": "{0}／{1}",
    "Track {0}": "軌道 {0}",  # 混音器 `Track ${id}`
    "{0}×{1} canvas → {2}×{3} export · {4}fps": "畫布 {0}×{1} → 匯出 {2}×{3} · {4} fps",
    "Export queue: {0} done{1}{2}": "匯出佇列：已完成 {0} 個{1}{2}",
    ", layers": None,  # 開發者錯誤訊息裡拼的欄位清單
    # 分隔符、標點
    "+click adds a keyframe ·": "+點一下可新增關鍵幀 ·",
    "+click or double-click removes one · corner grips drag fades": "+點一下或按兩下可移除 · 拖曳角落控點可調整淡入／淡出",
    "+drag a key pulls new handles · double-click a key makes it a corner again": "+拖曳關鍵幀可拉出新的控制桿 · 按兩下關鍵幀可變回尖角",
    ", packed": "，或連著打",
    ", the edge handles resize": "，拖曳邊緣控點可調整大小",
    "= fine) · double-click resets the colour · double-click a label or slider name to reset it": "＝微調）· 按兩下可重設顏色 · 按兩下標籤或滑桿名稱可重設",
    "Drag to move · click to jump · double-click or right-click to name / colour / delete ·": "拖曳可移動 · 點一下可跳到該處 · 按兩下或按右鍵可命名／改顏色／刪除 ·",
    "Drag to resize · double-click to reset": "拖曳可調整大小 · 按兩下可重設",
    "Drag to change the level ·": "拖曳可調整音量 ·",
    "In · Out · At playhead · Loop menus key a ready-made animation onto the selected clips ·": "「進場」「出場」「在播放頭位置」「循環」選單，可把現成的動畫關鍵幀套到所選片段 ·",
    "In: from the clip's start · Out: up to its end · Loop: the whole clip": "進場：從片段開頭開始 · 出場：到片段結尾為止 · 循環：整個片段",
    "Markers — list, jump, rename, recolour (M add · ⇧M next · Alt+⇧M previous)": "標記：列出、跳轉、重新命名、改顏色（M 新增 · ⇧M 下一個 · Alt+⇧M 上一個）",
    "Scrub source · drag to seek": "快速瀏覽來源 · 拖曳可跳到指定位置",
    "Source = loaded clip · Program = timeline": "來源＝已載入的片段 · 節目＝時間軸",
    "Star it · list where it is used (click one to jump there)": "加上星號 · 列出使用位置（點一下任一項可跳過去）",
    "Stereo: as recorded · Mono: fold L+R to one channel · Left / Right: use one side only · Swap: exchange L and R": "立體聲：維持原錄音 · 單聲道：把 L 和 R 混成一個聲道 · 左／右：只用單邊 · 對調：左右互換",
    "matches tags only ·": "只比對標籤 ·",
    "· its fields are in the Inspector": "· 欄位在屬性面板中",
    "· skipped: {0}": "· 略過：{0}",
    "— point it at the footage where it is now ·": "：指向素材目前所在的位置 ·",
    "— this list live-updates.": "，這份清單會即時更新。",
    "closes ·": "即可封閉 ·",
    "puts it back ·": "可還原 ·",
    # 用詞：追蹤軌跡、空隙、長度、主輸出、我的最愛、峰值…
    "A clip to pin to this track": "要固定在這條追蹤軌跡上的片段",
    "Attach to the track": "附加到追蹤軌跡",
    "Delete this track (what follows it keeps its keys)": "刪除這條追蹤軌跡（跟著它動的內容會保留各自的關鍵幀）",
    "That clip and the track don't overlap in time": "那個片段和這條追蹤軌跡在時間上沒有重疊",
    "clip {0}: it does not overlap the track in time — nothing keyed": "片段 {0}：跟追蹤軌跡在時間上沒有重疊，沒有打任何關鍵幀",
    "Close gap": "移除空隙",
    "Closed {0}s gap": "已移除 {0} 秒的空隙",
    "Nothing to close at playhead": "播放頭位置沒有可移除的空隙",
    "Duration": "長度",
    "Marked duration": "已標記的長度",
    "Playhead / sequence duration": "播放頭／序列長度",
    "Master": "主輸出",  # 輸出規格的 Master 和混音器的 Master 共用這個字
    "→ Master": "→ 主輸出",
    "Master, YouTube 1080p, Reel 1080×1920, Square 1080 and a 720p preview": "主輸出、YouTube 1080p、Reels 1080×1920、方形 1080，以及 720p 預覽",
    "Favorite — click to unstar": "已加入我的最愛，點一下取消",
    "Mark as favorite": "加入我的最愛",
    "Click to switch RMS / LUFS / Peak": "點一下切換 RMS／LUFS／峰值",
    "Cycle RMS → LUFS → Peak": "依序切換 RMS → LUFS → 峰值",
    "Entire timeline": "整條時間軸",
    "Export checked": "匯出勾選的項目",
    "Export checked ({0})": "匯出勾選的項目（{0}）",
    "Ascending — click for descending": "遞增排序，點一下改成遞減",
    "Descending — click for ascending": "遞減排序，點一下改成遞增",
    "(bypassed)": "（已略過）",
    "−23 LUFS (broadcast)": "−23 LUFS（電視播出）",
    "Background removal unavailable — couldn't load MediaPipe (offline?). Using chroma key still works.": "背景移除無法使用：MediaPipe 載入失敗（可能沒有連上網路）。改用色度去背還是可以。",
    "Link audio / video": "連結音訊與影片",
    "Unlink audio / video": "解除音訊與影片的連結",
    "Show the path's points and handles on the monitor": "在監看螢幕上顯示路徑的點和控制桿",
    "Noise reduction works on audio — this picture has no linked audio stems": "降噪只適用於音訊，這個影片片段沒有連結的音訊",
    # 一詞多義：看過原始碼決定（括號裡是用到的地方）
    "Color": "顏色",  # 調色側欄分頁、輸出規格的色彩、圖形的顏色欄
    "Centre": "中心",  # 錨點歸中按鈕、選色的色相中心
    "Hold": "保持",  # 噪音閘參數；快捷鍵表「Hold K and tap…」接下面那句
    "and tap to step one frame; hold both to crawl at ¼ speed": "按著，點按另一鍵可逐幀移動 · 兩鍵都按住則以 ¼ 速度慢慢播放",
    "Bottom": "下方線", "Top": "上方線",  # 範本裡的線條圖層名稱
    "Back L": "左後", "Back R": "右後",  # 環繞聲道
    "Keying / Cut-out": "去背",
    "Invert": "反轉",
    "Knee": "膝點",
    "Amount": "強度",
    "It is open": "它正開著",
    "Unlocked": "未鎖定",
    "Serif drop": "襯線落下",
    "Clean voice": "清晰人聲",
    "Track padlock": "軌道鎖",
    "color {0}{1}": "顏色 {0}{1}",
    # 抽字抽不到、程式動態拼的（實測畫面上看到的）
    "Image": "圖片", "Svg": "SVG",  # 素材區篩選的「類型」選單（首字大寫是程式轉的）
    "image": "圖片", "video": "影片", "audio": "音訊", "svg": "SVG", "comp": "合成", "title": "標題",  # 素材區檔名下面「video · 00:05:00 · …」
    "🟢 connected": "🟢 已連線", "⚪ local session": "⚪ 本機工作階段",  # 頂端專案名稱後面
    # 快捷鍵表裡夾在 <kbd> 中間的單字（抽字時單一小寫字會被當成程式碼丟掉）
    "stops": "停止", "/ click timecode": "／點時間碼", "Right-click": "按右鍵點", "tab": "分頁",
    "clears": "清除", "cancels": "取消", "deselects": "取消選取",
    "Auto-orient": "自動轉向", "Swap": "對調",
    "off": "關", "on": "開", "PEAK": "峰值", "Light": "輕微", "Medium": "中等", "Strong": "強烈",
    # 屬性面板的滑桿名稱：程式把參數鍵名第一個字大寫當標籤（app.js 的 slider()）
    "BgOpacity": "背景不透明度", "Brightness": "亮度", "ChromaSoftness": "去背柔化", "ChromaTolerance": "去背容許度",
    "CornerRadius": "圓角", "Grayscale": "灰階", "LetterSpacing": "字距", "LineHeight": "行高", "RgbSplit": "RGB 色差",
    "ShakeSpeed": "震動速度", "StrokeWidth": "描邊粗細", "Temperature": "色溫", "TextShadow": "文字陰影",
    "TrimEnd": "修剪終點", "TrimOffset": "修剪偏移", "TrimStart": "修剪起點", "WordRate": "逐字速度",
    # 下拉選單：程式直接拿英文代號當選項文字（選到的值不會變，runtime 會先把原文補成 value）
    "normal": "正常", "multiply": "色彩增值", "screen": "濾色", "overlay": "覆蓋", "darken": "變暗", "lighten": "變亮",
    "color-dodge": "加亮顏色", "color-burn": "加深顏色", "hard-light": "實光", "soft-light": "柔光", "difference": "差異化",
    "exclusion": "排除", "hue": "色相", "saturation": "飽和度", "color": "顏色", "luminosity": "明度", "lighter": "線性加亮",
    "none": "無", "alpha": "Alpha", "alpha inverted": "Alpha 反轉", "luma": "亮度", "luma inverted": "亮度反轉",
    "contain": "符合大小", "cover": "填滿", "stretch": "拉伸",
    "left": "靠左", "center": "置中", "right": "靠右", "justify": "左右對齊", "top": "靠上", "middle": "垂直置中", "bottom": "靠下",
    "auto": "自動", "ltr": "由左到右", "rtl": "由右到左",
    "cinematic": "電影感", "teal-orange": "青橙", "noir": "黑色電影", "vintage": "復古", "faded": "褪色", "warm": "暖色",
    "cold": "冷色", "pop": "鮮豔", "dreamy": "夢幻", "retro": "懷舊", "bw-soft": "柔和黑白", "cyberpunk": "賽博龐克",
    "sunset": "夕陽", "midnight": "午夜",
    "fade": "淡化", "slide-left": "向左滑", "slide-right": "向右滑", "slide-up": "向上滑", "slide-down": "向下滑", "zoom": "縮放",
    "wipe": "擦除", "wipe-right": "向右擦除", "wipe-up": "向上擦除", "wipe-down": "向下擦除", "iris": "圓形展開",
    "spin": "旋轉", "blur": "模糊", "whip": "甩鏡", "glitch": "故障",
    "silent{0}": "無聲{0}",
    # 其他潤飾
    "+drag a point pulls new handles ·": "+拖曳點可拉出新的控制桿 ·",
    "Canvas aspect preset": "畫布長寬比預設集",
    "At playhead…": "在播放頭位置…",
    "Auto-duck under other tracks": "其他軌道有聲音時自動壓低",
    "Comma-separated. Search #tag to find them.": "用半形逗號（,）分隔。搜尋「#標籤」就能找到它們。",
    "Drag around what this layer should grade": "拖曳圈出這個圖層要調色的範圍",
    "Drag around what this layer should grade. Esc cancels.": "拖曳圈出這個圖層要調色的範圍。按 Esc 取消。",
    "Drag on the monitor to move the anchor point; the picture stays put (": "在監看螢幕上拖曳可移動錨點，畫面本身不會動（",
    "Drag to tint (": "拖曳可調整色偏（",
    "Drag to tint (Shift: fine) · double-click: reset colour": "拖曳可調整色偏（Shift：微調）· 按兩下：重設顏色",
    "Frame-accurate. Browser HW-encodes H.264; server muxes with audio. Faster upload than Fast.": "逐幀精準。由瀏覽器以硬體編碼 H.264，再由伺服器合併音訊。上傳比「快速」模式更快。",
    "Key the shape at the playhead — with keys, every change keys": "在播放頭位置為圖形打關鍵幀；有了關鍵幀之後，每次修改都會自動打關鍵幀",
    "Key the mask at the playhead — with keys, every change keys": "在播放頭位置為遮罩打關鍵幀；有了關鍵幀之後，每次修改都會自動打關鍵幀",
    "Motion → Presets": "動態 → 預設集",
    "On the monitor: drag inside to move, the knob rotates (Shift: 15° steps){22}. Esc deselects. Every change undoes with Ctrl+Z (redo: Ctrl+Shift+Z or Ctrl+Y).": "在監看螢幕上：拖曳內部可移動，拖曳旋轉鈕可旋轉（按住 Shift 以 15° 為單位）{22}。按 Esc 取消選取。每項修改都能用 Ctrl+Z 復原（重做：Ctrl+Shift+Z 或 Ctrl+Y）。",
    "On the monitor: drag the item to move it, the knob turns it (Shift: 15° steps), the corners resize it{25}. Esc deselects.": "在監看螢幕上：拖曳項目可移動，拖曳旋轉鈕可旋轉（按住 Shift 以 15° 為單位），拖曳四角可調整大小{25}。按 Esc 取消選取。",
    "You are editing this composition — Esc or ◀ Main goes back": "你正在編輯這個合成，按 Esc 或「◀ 主時間軸」可以返回",
    "Upscaled: the part of the picture used is {0}×{1} and the output {2}×{3} — a larger{4} project size keeps it sharp": "已放大：使用的畫面範圍是 {0}×{1}，輸出是 {2}×{3}，把專案尺寸設大一點{4}可以保持清晰",
}

# 句型變數專用（例：「fade {0} {1}s」的 {0} 是程式拼的 in／out）：只在套句型時查，不會拿去換畫面上單獨出現的字
ARGS = {
    "in": "淡入", "out": "淡出", "extract": "擷取", "lift": "提取",
    "video": "影片", "audio": "音訊", "text": "文字", "image": "圖片", "title": "標題", "shape": "圖形",
    "clip": "片段", "clips": "片段", "track": "軌道", "tracks": "軌道", "a video": "影片", "an audio": "音訊", "an image": "圖片",
    "a": "", "an": "",
}

CJK = r"\u3400-\u9fff\uf900-\ufaff"


def spacing(src, s):
    """中文和英文、數字、{n} 之間補一個半形空白（生圖站其他畫面的寫法，例如「佇列 0」「第 01 章」）。
    {n} 例外：英文原文 {n} 那一側本來就沒空白（例如「file{1}」的複數 s、「rotates{9}」接的括號說明），譯文那側也不加。"""
    tight_l = {m.group(1) for m in re.finditer(r"\S\{(\d+)\}", src)}  # 原文 {n} 左邊沒空白
    tight_r = {m.group(1) for m in re.finditer(r"\{(\d+)\}\S", src)}  # 原文 {n} 右邊沒空白
    s = re.sub(rf"([{CJK}])([A-Za-z0-9])", r"\1 \2", s)
    s = re.sub(rf"([A-Za-z0-9%°])([{CJK}])", r"\1 \2", s)
    s = re.sub(rf"([{CJK}])\{{(\d+)\}}", lambda m: m.group(1) + ("" if m.group(2) in tight_l else " ") + "{" + m.group(2) + "}", s)
    s = re.sub(rf"\{{(\d+)\}}([{CJK}])", lambda m: "{" + m.group(1) + "}" + ("" if m.group(1) in tight_r else " ") + m.group(2), s)
    return s


def separators(src, s):
    """原文用「 · 」分段、譯文卻寫成「；」的（各批不一致），改回「 · 」"""
    if "·" in src and ";" not in src and "；" in s:
        s = re.sub(r"；\s*$", " ·", s)
        s = s.replace("；", " · ")
    return s


def main():
    d = {}
    for f in sorted((D / "譯稿").glob("done_*.json")):
        for k, v in json.loads(f.read_text(encoding="utf-8")).items():
            d[html.unescape(k)] = v
    n_terms = n_sep = n_space = 0
    for k, v in d.items():
        if not v:
            continue
        w = v
        for a, b in TERMS:
            w = w.replace(a, b)
        n_terms += w != v
        x = separators(k, w)
        n_sep += x != w
        y = spacing(k, x)
        n_space += y != x
        d[k] = y
    missing = [k for k in FIX if k not in d and not re.search(r"\{\d+\}", k) and k not in ("Imported", "Tokens:")]
    if missing:
        print("注意：FIX 裡這些原文不在初稿裡（新加的字）：", missing)
    d.update(FIX)
    out = dict(sorted(d.items()))
    (D / "zh_src.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    (D / "args.json").write_text(json.dumps(ARGS, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"共 {len(out)} 筆（不翻 {sum(v is None for v in out.values())}）；統一用詞改了 {n_terms} 句、分隔符 {n_sep} 句、補空白 {n_space} 句、逐句修改 {len(FIX)} 句")


if __name__ == "__main__":
    main()
