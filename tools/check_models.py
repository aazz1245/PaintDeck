"""對一遍安裝精靈的模型清單（resources/share/models_basic.json、models_full.json）跟來源上的檔案。

用法（在 D:\\AI\\anima_app）：
  C:\\Users\\User\\AppData\\Local\\Python\\bin\\python -I -X utf8 tools\\check_models.py         只檢查、列出不對的
  C:\\Users\\User\\AppData\\Local\\Python\\bin\\python -I -X utf8 tools\\check_models.py --fix   另外把 Civitai 網址固定到 fileId、補上 sha256

怎麼對：
- Hugging Face：HEAD 固定 commit 的 resolve 網址，讀 X-Linked-Size（大小）和 X-Linked-ETag（LFS 的 sha256）。
- Civitai：GET /api/v1/model-versions/<版本>，在那個版本的檔案裡找大小一樣的（同一個版本可能有好幾個檔，
  例如作者後來加了 fp16 版還把它設成預設；網址不帶 fileId 會拿到「預設」那個，大小就對不上）。
- 其他（GitHub）：HEAD 跟著轉址，讀 Content-Length。
大小對不上的只列出來，不會自動改大小（要人看過是不是真的換了檔）。發新版前跑一次。
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [("basic", 1), ("full", 2)]  # 原本的縮排
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnimaStudio-check/1.0"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def head(url, follow):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        r = opener.open(req, timeout=30)
        return r.status, r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers


def hf(url):
    code, h = head(url, follow=False)
    size = h.get("X-Linked-Size") or (h.get("Content-Length") if code == 200 else None)
    etag = (h.get("X-Linked-ETag") or h.get("ETag") or "").strip('"').removeprefix("W/").strip('"')
    sha = etag if len(etag) == 64 else None
    return code, int(size) if size else None, sha


_versions = {}


def civitai_version(vid):
    if vid not in _versions:
        req = urllib.request.Request(f"https://civitai.com/api/v1/model-versions/{vid}", headers={"User-Agent": UA})
        for i in range(3):
            try:
                _versions[vid] = json.load(urllib.request.urlopen(req, timeout=30))
                break
            except Exception as e:  # 429 之類：等一下再試
                err = e
                time.sleep(3 * (i + 1))
        else:
            raise err
        time.sleep(0.4)
    return _versions[vid]


def check(entry):
    """回傳 (狀態, 說明, 修正後的 entry 或 None)"""
    url, want, name = entry.get("url"), entry["size"], entry["path"].rsplit("/", 1)[-1]
    if not url:
        return "skip", "沒有網址", None
    u = urllib.parse.urlparse(url)
    new = dict(entry)
    if u.hostname == "huggingface.co":
        code, size, sha = hf(url)
        if size is None:
            return "bad", f"HF HTTP {code}，讀不到大小", None
        if size != want:
            return "bad", f"HF 上是 {size}，清單記 {want}", None
        if sha:
            new["sha256"] = sha
        return "ok", "", new
    if u.hostname == "civitai.com":
        vid = u.path.rstrip("/").rsplit("/", 1)[-1]
        q = urllib.parse.parse_qs(u.query)
        d = civitai_version(vid)
        files = d.get("files") or []
        fid = q.get("fileId", [None])[0]
        same = [f for f in files if round(f.get("sizeKB", 0) * 1024) == want]
        if fid:
            same = [f for f in same if str(f["id"]) == fid] or same
        # 大小一樣的不只一個：挑檔名一樣的
        same.sort(key=lambda f: f["name"] != name)
        if not same:
            got = ", ".join(f"{f['name']}={round(f.get('sizeKB', 0) * 1024)}{'（預設）' if f.get('primary') else ''}" for f in files)
            return "bad", f"Civitai 版本 {vid} 裡沒有 {want} 位元組的檔：{got}", None
        f = same[0]
        prim = next((x for x in files if x.get("primary")), None)
        note = ""
        if prim and prim["id"] != f["id"] and not fid:
            note = f"網址沒帶 fileId，會拿到預設的 {prim['name']}（{round(prim.get('sizeKB', 0) * 1024)}）"
        new["url"] = f"https://civitai.com/api/download/models/{vid}?fileId={f['id']}"
        sha = (f.get("hashes") or {}).get("SHA256")
        if sha:
            new["sha256"] = sha.lower()
        return ("bad" if note else "ok"), note, new
    code, h = head(url, follow=True)
    size = int(h.get("Content-Length") or 0)
    if code >= 400 or size != want:
        return "bad", f"HTTP {code}，大小 {size}，清單記 {want}", None
    return "ok", "", None


def order(e):
    # 欄位順序：path, size, sha256, url, note（其他照原樣接在後面）
    keys = ["path", "size", "sha256", "url", "note"]
    out = {k: e[k] for k in keys if k in e}
    out.update({k: v for k, v in e.items() if k not in out})
    return out


def main():
    fix = "--fix" in sys.argv
    bad = 0
    for which, indent in FILES:
        p = ROOT / "resources" / "share" / f"models_{which}.json"
        raw = p.read_bytes()
        data = json.loads(raw)
        crlf = b"\r\n" in raw
        changed = False
        for i, e in enumerate(data):
            st, msg, new = check(e)
            if st == "bad":
                bad += 1
                print(f"[{which}] ✗ {e['path']}：{msg}")
            if fix and new and new != e:
                data[i] = order(new)
                changed = True
        print(f"[{which}] 對完 {len(data)} 筆")
        if fix and changed:
            text = json.dumps(data, ensure_ascii=False, indent=indent)
            if crlf:
                text = text.replace("\n", "\r\n")
            p.write_bytes((text + ("\r\n" if raw.endswith(b"\r\n") else "\n" if raw.endswith(b"\n") else "")).encode("utf-8"))
            print(f"[{which}] 已寫回 {p}")
    print("全部正確" if not bad else f"有 {bad} 筆要看")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
