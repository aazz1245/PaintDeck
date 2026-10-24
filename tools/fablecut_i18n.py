"""剪輯台（FableCut）中文化：FableCut 本體是英文，生圖站不改它的程式，只多載入一支 anima-i18n.js 在畫面上換字。

用法（在 D:\\AI\\anima_app 底下，用 C:\\Users\\User\\AppData\\Local\\Python\\bin\\python -I -X utf8 跑）：
    python tools\\fablecut_i18n.py extract   從 index.html 和網頁會載入的 .js 抽英文字串，
                                            只把 tools\\fablecut_i18n\\zh_src.json 還沒有的寫成 todo_NN.json（每批 BATCH 筆）
    （翻好的存成 tools\\fablecut_i18n\\譯稿\\done_NN.json：{"英文原文": "繁中"}；不是介面文字的填 null；
      編號接在現有的後面，不要蓋掉 01～06。翻法照 tools\\fablecut_i18n\\翻譯說明.md）
    python tools\\fablecut_i18n\\潤稿.py      （第一次翻完）從 tools\\fablecut_i18n\\譯稿\\done_*.json 統一用詞、套逐句修改 → zh_src.json、args.json
    python tools\\fablecut_i18n.py build     併進 zh_src.json，產生 resources\\extras\\fablecut\\anima-i18n.js（繁中＋用 OpenCC 轉的簡中），
                                            index.html 第一支 script 前面插一行載入它
升級 FableCut 之後：先跑 tools\\fablecut_theme.py，再跑這支的 extract → 翻新的 → build。

句型：原文裡 ${…} 的地方寫成 {0}、{1}…（例：「Maximum {0} {1} tracks」），譯文用同樣的 {0}、{1}，可以省略（例如英文複數的 s）。
"""
import html.parser
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FC = ROOT / "resources" / "extras" / "fablecut"
DIR = ROOT / "tools" / "fablecut_i18n"
SRC = DIR / "zh_src.json"
OUT = FC / "anima-i18n.js"
BATCH = 350
TAG = '<script src="anima-i18n.js"></script><!-- Anima 生圖站：剪輯台中文化（tools\\fablecut_i18n.py） -->'

# ---------------------------------------------------------------- 掃 JS 字串
KW_BEFORE_REGEX = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"}
ESC = {"n": "\n", "t": "\t", "r": "", "'": "'", '"': '"', "`": "`", "\\": "\\", "0": "\0", "b": "", "f": "", "v": ""}


def unescape(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c != "\\" or i + 1 >= len(s):
            out.append(c); i += 1; continue
        n = s[i + 1]
        if n == "u" and s[i + 2:i + 3] == "{":
            j = s.index("}", i); out.append(chr(int(s[i + 3:j], 16))); i = j + 1
        elif n == "u":
            out.append(chr(int(s[i + 2:i + 6], 16))); i += 6
        elif n == "x":
            out.append(chr(int(s[i + 2:i + 4], 16))); i += 4
        elif n in "\r\n":
            i += 2
        else:
            out.append(ESC.get(n, n)); i += 2
    return "".join(out)


def scan_js(src, emit, line0=1):
    """把 JS 原始碼裡的字串一個一個丟給 emit(text, line, before, is_template)。
    樣板字串的 ${…} 換成 {0}、{1}…，裡面的運算式再遞迴掃一次。"""
    i, n = 0, len(src)
    last = ""  # 上一個有意義的字元或關鍵字（判斷 / 是除號還是正規式）
    while i < n:
        c = src[i]
        if c in " \t\r\n":
            i += 1; continue
        if src.startswith("//", i):
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == "\\" else 1
            emit(unescape(src[i + 1:j]), line0 + src.count("\n", 0, i), src[max(0, i - 60):i], False)
            i = j + 1; last = "str"; continue
        if c == "`":
            j, parts, exprs = i + 1, [], []
            buf = []
            while j < n and src[j] != "`":
                if src[j] == "\\":
                    buf.append(src[j:j + 2]); j += 2; continue
                if src.startswith("${", j):
                    depth, k = 1, j + 2
                    while k < n and depth:
                        ch = src[k]
                        if ch in "'\"`":  # 運算式裡的字串：跳過（之後遞迴掃）
                            q = ch; k += 1
                            while k < n and src[k] != q:
                                if src[k] == "\\": k += 1
                                elif q == "`" and src.startswith("${", k):
                                    d2, k = 1, k + 2
                                    while k < n and d2:
                                        d2 += {"{": 1, "}": -1}.get(src[k], 0); k += 1
                                    continue
                                k += 1
                        elif ch == "{": depth += 1
                        elif ch == "}": depth -= 1
                        k += 1
                    expr = src[j + 2:k - 1]
                    exprs.append((expr, line0 + src.count("\n", 0, j)))
                    parts.append(unescape("".join(buf))); buf = []
                    j = k; continue
                buf.append(src[j]); j += 1
            parts.append(unescape("".join(buf)))
            text = "".join(p + ("{%d}" % k if k < len(parts) - 1 else "") for k, p in enumerate(parts))
            emit(text, line0 + src.count("\n", 0, i), src[max(0, i - 60):i], True)
            for e, ln in exprs:
                scan_js(e, emit, ln)
            i = j + 1; last = "str"; continue
        if c == "/":
            if last in ("", "op") or last in KW_BEFORE_REGEX:
                j, cls = i + 1, False
                while j < n:
                    ch = src[j]
                    if ch == "\\": j += 2; continue
                    if ch == "[": cls = True
                    elif ch == "]": cls = False
                    elif ch == "/" and not cls: break
                    elif ch == "\n": break
                    j += 1
                j += 1
                while j < n and src[j].isalpha(): j += 1
                i = j; last = "str"; continue
            i += 1; last = "op"; continue
        m = re.match(r"[A-Za-z_$][\w$]*", src[i:i + 40])
        if m:
            w = m.group(0); i += len(w); last = w if w in KW_BEFORE_REGEX else "id"; continue
        if c.isdigit():
            m = re.match(r"[\d.xXa-fA-F_eEn]+", src[i:i + 40]); i += len(m.group(0)); last = "id"; continue
        last = "id" if c in ")]}" else "op"
        i += 1


# 字串前面是這些用法＝程式用的鍵，不是給人看的字
CODE_BEFORE = re.compile(
    r"(className\s*[+]?=\s*|classList\.\w+\(\s*|querySelector(All)?\(\s*|getElementById\(\s*|addEventListener\(\s*|removeEventListener\(\s*"
    r"|createElement(NS)?\(\s*|[sg]etAttribute\(\s*|removeAttribute\(\s*|hasAttribute\(\s*|case\s+|[!=]==?\s*|dataset\.\w+\s*=\s*|\.type\s*=\s*"
    r"|closest\(\s*|matches\(\s*|fetch\(\s*|import\(\s*|require\(\s*|postMessage\(\s*|\.key\s*===?\s*|\bkind\s*:\s*|\btype\s*:\s*|\bop\s*:\s*"
    r"|localStorage\.\w+\(\s*|\.style\.\w+\s*=\s*|setProperty\(\s*|\.cursor\s*=\s*|\bmethod\s*:\s*|\bcode\s*:\s*|\bid\s*:\s*|\bcls\s*:\s*|\bclass\s*:\s*"
    r"|\bicon\s*:\s*|\.font\s*=\s*|\.fillStyle\s*=\s*|\.strokeStyle\s*=\s*|\.textAlign\s*=\s*|\.textBaseline\s*=\s*|\.mode\s*=\s*|\bmode\s*:\s*"
    r"|\bshortcut\s*:\s*|\bkeys\s*:\s*|\bhref\s*=\s*|\.src\s*=\s*|\bsrc\s*:\s*|\burl\s*:\s*|\bpath\s*:\s*|\.endsWith\(\s*|\.startsWith\(\s*|\.includes\(\s*"
    r"|\.indexOf\(\s*|\.split\(\s*|\.join\(\s*|\.replace\(\s*|in\s+\w+\s*\?\s*|typeof\s+\w+\s*===?\s*|console\.\w+\(\s*)$")
LETTER = re.compile(r"[A-Za-z]")
WORDS = re.compile(r"[A-Za-z]{2,}")


def ui_like(s):
    t = s.strip()
    if len(WORDS.findall(t)) == 0 or len(t) > 400:
        return False
    if re.search(r"https?://|^/|^\.|^#|^--|^data-|=>|rgba?\(|hsla?\(|var\(--|^M[\d\s.-]|^[\w-]+:\s*[\w#-]+;|\{\s*$|function\s*\(", t):
        return False
    if re.fullmatch(r"[a-z][a-zA-Z0-9]*", t):  # 單一小寫字／camelCase
        return False
    if re.fullmatch(r"[\w$.-]+", t) and re.search(r"[_.$-]|[a-z][A-Z]", t):  # snake、kebab、a.b、camel
        return False
    if re.fullmatch(r"[a-z0-9-]+( [a-z0-9-]+)*", t) and "-" in t:  # class 清單
        return False
    if re.fullmatch(r"[\w/+.-]+/[\w+.-]+", t):  # MIME、路徑
        return False
    if re.fullmatch(r"(Arrow\w+|Key[A-Z]|Digit\d|Shift|Control|Alt|Meta|Escape|Enter|Tab|Backspace|Space|Home|End|PageUp|PageDown)", t):
        return False
    if re.fullmatch(r"[A-Z]{2,5}", t) and t in {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "JSON", "UTF"}:
        return False
    return True


# ---------------------------------------------------------------- 掃 index.html
class Html(html.parser.HTMLParser):
    ATTRS = ("title", "placeholder", "aria-label", "data-tip", "label", "alt")

    def __init__(self, emit):
        super().__init__(convert_charrefs=True)
        self.emit, self.stack = emit, []

    def handle_starttag(self, tag, attrs):
        if tag not in ("br", "img", "input", "meta", "link", "hr", "source", "path", "rect", "circle", "line", "polyline", "polygon", "use"):
            self.stack.append(tag)
        for k, v in attrs:
            if v and (k in self.ATTRS or (k == "value" and tag == "option")):
                self.emit(v, self.getpos()[0], f"<{tag} {k}=", False)

    def handle_startendtag(self, tag, attrs):
        for k, v in attrs:
            if v and k in self.ATTRS:
                self.emit(v, self.getpos()[0], f"<{tag} {k}=", False)

    def handle_endtag(self, tag):
        while self.stack and self.stack.pop() != tag:
            pass

    def handle_data(self, data):
        if any(t in ("script", "style", "svg", "kbd", "code") for t in self.stack):
            return
        if data.strip():
            self.emit(data, self.getpos()[0], "<text>", False)


def front_scripts():
    idx = (FC / "index.html").read_text(encoding="utf-8")
    return [s for s in re.findall(r'<script src="([^"]+)"', idx) if s != "anima-i18n.js"]


def split_markup(s):
    """樣板字串裡有 HTML：拆成一段一段的文字（標籤屬性裡的 title 等也拿出來）"""
    out = []
    for m in re.finditer(r'\b(?:title|placeholder|aria-label)="([^"]*)"', s):
        out.append(html.unescape(m.group(1)))
    for seg in re.split(r"<[^>]*>", s):
        if seg.strip():
            out.append(html.unescape(seg))  # 畫面上看到的是 & 不是 &amp;
    return out


def norm(s):
    """畫面比對的鍵：去頭尾空白、壓掉連續空白"""
    return re.sub(r"\s+", " ", s).strip()


def extract():
    found = {}

    def add(text, where, before, tmpl):
        for piece in (split_markup(text) if "<" in text and re.search(r"<[a-zA-Z/][^>]*>", text) else [text]):
            k = norm(piece)
            if not ui_like(k):
                continue
            if CODE_BEFORE.search(before) and not tmpl:
                continue
            # 樣板裡只剩 {0} 和符號，不是句子
            if not WORDS.search(re.sub(r"\{\d+\}", "", k)):
                continue
            found.setdefault(k, where)

    p = Html(lambda t, ln, b, tm: add(t, f"index.html:{ln}", b, tm))
    p.feed((FC / "index.html").read_text(encoding="utf-8"))
    for name in front_scripts():
        src = (FC / name).read_text(encoding="utf-8")
        lines = src.split("\n")

        def emit(t, ln, b, tm, name=name, lines=lines):
            add(t, f"{name}:{ln}: {lines[ln - 1].strip()[:140]}", b, tm)
        scan_js(src, emit)

    have = json.loads(SRC.read_text(encoding="utf-8")) if SRC.exists() else {}
    for f in DIR.glob("done_*.json"):
        have.update(json.loads(f.read_text(encoding="utf-8")))
    have = {html.unescape(k) for k in have}
    todo = [{"en": k, "ctx": v} for k, v in found.items() if k not in have]
    for f in DIR.glob("todo_*.json"):
        f.unlink()
    DIR.mkdir(exist_ok=True)
    for b in range(0, len(todo), BATCH):
        (DIR / f"todo_{b // BATCH + 1:02d}.json").write_text(json.dumps(todo[b:b + BATCH], ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"抽到 {len(found)} 筆，還沒翻的 {len(todo)} 筆 → {(len(todo) + BATCH - 1) // BATCH} 批")


# ---------------------------------------------------------------- 產生 anima-i18n.js
def to_cn(texts):
    """用生圖站附的 OpenCC（ui\\vendor\\opencc-t2cn.js，台灣詞→大陸詞）把繁中轉簡中"""
    js = (ROOT / "ui" / "vendor" / "opencc-t2cn.js").as_uri()
    code = ("import(process.argv[1]).then(({Converter})=>{const c=Converter({from:'twp',to:'cn'});"
            "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map(c))));});")
    r = subprocess.run(["node", "-e", code, js], input=json.dumps(texts, ensure_ascii=False).encode("utf-8"), capture_output=True, check=True)
    return json.loads(r.stdout.decode("utf-8"))


def build():
    d = json.loads(SRC.read_text(encoding="utf-8")) if SRC.exists() else {}
    for f in sorted(DIR.glob("done_*.json")):
        d.update(json.loads(f.read_text(encoding="utf-8")))
    d = {html.unescape(k): v for k, v in sorted(d.items()) if k}  # 第一版抽字沒還原 &amp;，舊譯稿的鍵在這裡補還原
    SRC.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    keep = {k: v for k, v in d.items() if v}
    bad = [k for k, v in keep.items() if set(re.findall(r"\{\d+\}", v)) - set(re.findall(r"\{\d+\}", k))]
    if bad:
        sys.exit("譯文多了原文沒有的 {n}：" + "；".join(bad[:10]))
    args = json.loads((DIR / "args.json").read_text(encoding="utf-8")) if (DIR / "args.json").exists() else {}
    keys = list(keep)
    cn = to_cn([keep[k] for k in keys] + [args[k] for k in args])
    zh_cn = {k: c for k, c in zip(keys, cn) if c != keep[k]}  # 跟繁中一樣的不重複存
    args_cn = {k: c for k, c in zip(args, cn[len(keys):]) if c != args[k]}
    runtime = (DIR / "runtime.js").read_text(encoding="utf-8")
    body = ("// 由 tools\\fablecut_i18n.py build 產生，不要手改（譯文改 tools\\fablecut_i18n\\潤稿.py 或 zh_src.json 再 build）\n"
            f"window.__ANIMA_I18N__ = {{\"zh-TW\": {json.dumps(keep, ensure_ascii=False)},\n\"zh-CN\": {json.dumps(zh_cn, ensure_ascii=False)},\n"
            f"\"args\": {json.dumps(args, ensure_ascii=False)},\n\"args-CN\": {json.dumps(args_cn, ensure_ascii=False)}}};\n"
            + runtime)
    OUT.write_text(body, encoding="utf-8", newline="\n")
    idx = (FC / "index.html").read_text(encoding="utf-8")
    if "anima-i18n.js" not in idx:
        first = re.search(r'<script src="[^"]+"></script>', idx)
        if not first:
            sys.exit("index.html 找不到 <script src=…>（FableCut 改版了？）")
        idx = idx[:first.start()] + TAG + "\n" + idx[first.start():]
        (FC / "index.html").write_text(idx, encoding="utf-8", newline="\n")
    print(f"anima-i18n.js：繁中 {len(keep)} 筆（簡中另外存 {len(zh_cn)} 筆不同的），不是介面字 {len(d) - len(keep)} 筆；{OUT.stat().st_size} bytes")


if __name__ == "__main__":
    {"extract": extract, "build": build}[sys.argv[1]]()
