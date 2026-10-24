# 精靈 API 小工具（第五十一筆）：
#   python -I -X utf8 wiz51.py scan <port> [out.json]
#   python -I -X utf8 wiz51.py check <port> <data_root> <comfy_dir> [gpu] [amd_gfx] [out.json]
#   python -I -X utf8 wiz51.py runitems <port> <data_root> <comfy_dir> [gpu] [amd_gfx]   （開始安裝、讀項目清單、馬上取消）
#   python -I -X utf8 wiz51.py run <port> <data_root> <comfy_dir> [gpu] [amd_gfx]        （開始安裝、一直看到結束）
#   python -I -X utf8 wiz51.py diff <old.json> <new.json>                                （舊版有的欄位逐一比對）
import json, sys, time, urllib.request

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(port, path, body=None, timeout=600):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method="GET" if body is None else "POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Anima-Setup", "1")
    try:
        with OPENER.open(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "_body": e.read().decode("utf-8", "replace")}


def body(args):
    b = {"data_root": args[0], "comfy_dir": args[1], "packs": []}
    if len(args) > 2 and args[2]:
        b["gpu"] = args[2]
    if len(args) > 3 and args[3]:
        b["amd_gfx"] = args[3]
    return b


def dump(v, out):
    s = json.dumps(v, ensure_ascii=False, indent=1)
    if out:
        open(out, "w", encoding="utf-8").write(s)
    return s


def diff(a, b, path=""):
    """a（舊版）有的欄位，b 要一樣；b 多出來的新欄位不算"""
    out = []
    if isinstance(a, dict):
        if not isinstance(b, dict):
            return [f"{path}: 舊 {type(a).__name__} 新 {type(b).__name__}"]
        for k in a:
            if k not in b:
                out.append(f"{path}.{k}: 新版沒有")
            else:
                out += diff(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        if not isinstance(b, list) or len(a) != len(b):
            return [f"{path}: 長度 {len(a)} → {len(b) if isinstance(b, list) else b}"]
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f"{path}[{i}]")
    elif a != b:
        out.append(f"{path}: {a!r} → {b!r}")
    return out


cmd = sys.argv[1]
if cmd == "scan":
    print(dump(call(sys.argv[2], "/api/setup/scan"), sys.argv[3] if len(sys.argv) > 3 else None))
elif cmd == "check":
    a = sys.argv[3:]
    out = a[4] if len(a) > 4 else None
    print(dump(call(sys.argv[2], "/api/setup/check", body(a)), out))
elif cmd in ("runitems", "run"):
    port = sys.argv[2]
    r = call(port, "/api/setup/run", body(sys.argv[3:]))
    print("run →", json.dumps(r, ensure_ascii=False))
    if r.get("ok"):
        if cmd == "runitems":
            time.sleep(1.5)
            st = call(port, "/api/setup/status")
            call(port, "/api/setup/cancel", {})
            for it in st.get("items", []):
                print(f"  {it.get('key')}  ｜{it.get('label')}｜  total={it.get('total')}")
            print("phase:", st.get("phase"))
            for _ in range(60):
                st = call(port, "/api/setup/status")
                if not st.get("running"):
                    break
                time.sleep(1)
            print("problems:", json.dumps(st.get("problems"), ensure_ascii=False))
        else:
            last = None
            t0 = time.time()
            while True:
                st = call(port, "/api/setup/status")
                cur = (st.get("phase"), [(i.get("key"), i.get("status"), i.get("done")) for i in st.get("items", []) if i.get("key", "").startswith("rocm10")])
                if cur != last:
                    print(f"[{time.time() - t0:6.1f}s]", json.dumps(cur, ensure_ascii=False))
                    last = cur
                if not st.get("running"):
                    break
                time.sleep(2)
            for it in st.get("items", []):
                print(f"  {it.get('key')}  {it.get('status')}  {it.get('error') or ''}")
            print("log:", json.dumps(st.get("log"), ensure_ascii=False)[:3000])
            print("problems:", json.dumps(st.get("problems"), ensure_ascii=False))
elif cmd == "diff":
    a = json.load(open(sys.argv[2], encoding="utf-8"))
    b = json.load(open(sys.argv[3], encoding="utf-8"))
    d = diff(a, b)
    print("\n".join(d) if d else "舊版有的欄位全部一樣")
