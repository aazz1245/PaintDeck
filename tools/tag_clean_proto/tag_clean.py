"""反推「自動清理」：把 WD tagger 的結果整理成好用的 Anima 提示詞，每個被拿掉的標籤都附上原因（網頁上可以點回來）。

規則（照順序）：
  1. 雜訊：簽名、浮水印、網址這類一律拿掉（生圖時會畫出字）。
  2. 寫實／媒材／畫風類：只在掛著「有觸發詞的 LoRA」時拿掉（realistic、nose、lips…會跟畫風 LoRA 打架；沒掛 LoRA 時可能就是想要寫實，所以留著）。
  3. 衝突：同一組只能有一個的（髮色、眼睛顏色、髮長、胸部大小、構圖、姿勢）只留分數最高的；
     有 multicolored hair／heterochromia 這類「本來就有兩種」的標籤時髮色／眼色不限制。
  4. 重複：留下的標籤已經隱含的上層標籤拿掉（pink rose 已經代表 rose、flower；隱含關係來自 tag_rules.json）。
排序：人數（1girl、solo…）放最前，其餘照分數；觸發詞由網頁插在品質詞後面。
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))

NOISE = {"signature", "artist name", "watermark", "web address", "dated", "twitter username", "patreon username",
         "pixiv username", "copyright notice", "artist logo", "company name", "character name", "sample watermark",
         "jpeg artifacts", "lowres", "highres", "absurdres", "commentary request"}
REAL = {"realistic", "photorealistic", "photo (medium)", "3d", "nose", "lips", "asian", "traditional media",
        "painting (medium)", "oil painting (medium)", "watercolor (medium)", "acrylic paint (medium)", "photo background",
        "flat color", "outline", "thick outlines", "white outline", "black outline", "lineart", "cel shading",
        "anime coloring", "no lineart", "sketch", "faux traditional media", "impasto"}
COUNT = re.compile(r"^(\d\+?(girl|boy|other)s?|solo|solo focus|multiple (girls|boys|others)|no humans)$")

COLORS = "aqua|black|blonde|blue|brown|green|grey|light blue|light brown|light green|light purple|orange|pink|purple|red|silver|white|yellow|dark blue|dark green"
GROUPS = [  # (名稱, 比對, 遇到這些標籤時不限制)
    ("髮色", re.compile(rf"^({COLORS}) hair$"), {"multicolored hair", "two-tone hair", "gradient hair", "streaked hair", "split-color hair", "colored inner hair"}),
    ("眼睛顏色", re.compile(rf"^({COLORS}) eyes$"), {"heterochromia", "multicolored eyes"}),
    ("髮長", re.compile(r"^(short|medium|long|very long|absurdly long) hair$"), set()),
    ("胸部大小", re.compile(r"^(flat chest|small breasts|medium breasts|large breasts|huge breasts|gigantic breasts)$"), set()),
    ("構圖", re.compile(r"^(full body|cowboy shot|upper body|portrait|close-up|lower body|feet out of frame|head out of frame)$"), set()),
    ("姿勢", re.compile(r"^(standing|sitting|lying|kneeling|squatting|on back|on stomach|on side|all fours|on couch|on bed|on chair|on floor)$"), set()),
]
# Danbooru 沒建、但意思上確實包含的關係（補在 tag_rules.json 上）
EXTRA_IMPLIES = {"lace-trimmed legwear": ["lace trim"], "lace trim": ["lace"], "strappy heels": ["high heels"],
                 "red lips": ["lips"]}

_implies = None


def _plain(t):
    """網頁顯示用的 tag（空白、括號跳脫）→ 規則用的純文字"""
    return t.replace("\\(", "(").replace("\\)", ")").strip().lower()


def implies():
    global _implies
    if _implies is None:
        _implies = {}
        p = os.path.join(HERE, "tag_rules.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                for k, v in json.load(f).get("implies", {}).items():
                    _implies[k.replace("_", " ")] = [c.replace("_", " ") for c in v]
        for k, v in EXTRA_IMPLIES.items():
            _implies.setdefault(k, []).extend(c for c in v if c not in _implies.get(k, []))
    return _implies


def ancestors(tag, imp):
    out, todo = set(), list(imp.get(tag, []))
    while todo:
        t = todo.pop()
        if t not in out:
            out.add(t)
            todo.extend(imp.get(t, []))
    return out


def clean(tags, style_lora=False):
    """tags：[(顯示用 tag, 分數)]，已照分數由高到低。
    回傳 (order, notes)：order＝全部 tag 的建議順序（留下的在前），notes＝{被拿掉的 tag: 原因}。"""
    imp = implies()
    plain = {t: _plain(t) for t, _ in tags}
    score = {t: p for t, p in tags}
    notes = {}

    for t, _ in tags:
        if plain[t] in NOISE:
            notes[t] = "雜訊（簽名、浮水印這類，生圖會畫出字）"
        elif style_lora and plain[t] in REAL:
            notes[t] = "寫實／畫風類，會跟畫風 LoRA 打架"

    have = {plain[t] for t, _ in tags if t not in notes}
    for name, rx, exempt in GROUPS:
        if have & exempt:
            continue
        members = [t for t, _ in tags if t not in notes and rx.match(plain[t])]
        for t in members[1:]:  # tags 已照分數排序，第一個分數最高
            notes[t] = f"{name}衝突：留分數較高的「{members[0]}」"

    kept = [t for t, _ in tags if t not in notes]
    by_plain = {plain[t]: t for t in kept}
    for t in kept:
        for a in ancestors(plain[t], imp):
            if a in by_plain and by_plain[a] not in notes and by_plain[a] != t:
                notes[by_plain[a]] = f"重複：「{t}」已經包含"

    kept = [t for t, _ in tags if t not in notes]
    kept.sort(key=lambda t: (not COUNT.match(plain[t]), -score[t]))
    dropped = [t for t, _ in tags if t in notes]
    return kept + dropped, notes
