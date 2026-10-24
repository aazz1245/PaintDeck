# 假顯示卡測試站一次看完：每一站的 scan（偵測、自動判斷）、check（全新安裝要下載什麼）、run 的項目清單（開始後馬上取消）
#   python -I -X utf8 sum51.py <名字:port> ... [--gpu amd --gfx gfx1031]
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wiz51 import call  # noqa: E402

args = sys.argv[1:]
gpu = gfx = ""
packs = []
if "--packs" in args:
    i = args.index("--packs"); packs = args[i + 1].split(","); del args[i:i + 2]
if "--gpu" in args:
    i = args.index("--gpu"); gpu = args[i + 1]; del args[i:i + 2]
if "--gfx" in args:
    i = args.index("--gfx"); gfx = args[i + 1]; del args[i:i + 2]
tmp = os.environ["TEMP"]
for st in args:
    name, port = st.split(":")
    print(f"========== {name}（{port}）" + (f" 手動選 gpu={gpu} amd_gfx={gfx}" if gpu else ""))
    s = call(port, "/api/setup/scan")
    print("偵測：", json.dumps([{k: g.get(k) for k in ("vendor", "name", "vram_mb", "driver", "gfx", "route", "arc", "driver_missing") if k in g} for g in s["gpus"]], ensure_ascii=False))
    print("detected=", s["detected"], " auto=", json.dumps(s["auto"], ensure_ascii=False))
    print("scan.variant=", s["variant"], " comfy_download=", s["comfy_download"])
    base = os.path.join(tmp, "anima_apitest", "a51", f"fresh_{name}{'_' + gpu if gpu else ''}")
    b = {"data_root": os.path.join(base, "anima_data"), "comfy_dir": os.path.join(base, "ComfyUI_windows_portable"), "packs": packs}
    if gpu:
        b["gpu"] = gpu
    if gfx:
        b["amd_gfx"] = gfx
    c = call(port, "/api/setup/check", b)
    print("check：variant=", c["variant"], " gpu=", json.dumps(c["gpu"], ensure_ascii=False))
    print("       download_size=", c["comfy"]["download_size"], " rocm10=", c["rocm10"], " llama=", c["llama"])
    print("       packs 的 pe 工具大小=", [p["total"] for p in c["packs"] if p["id"] == "pe"])
    r = call(port, "/api/setup/run", b)
    if not r.get("ok"):
        print("run 被擋：", json.dumps(r, ensure_ascii=False))
        continue
    time.sleep(1.5)
    stt = call(port, "/api/setup/status")
    call(port, "/api/setup/cancel", {})
    print("run 項目：")
    for it in stt.get("items", []):
        if it["key"] in ("data", "node", "workflows", "loras", "comfy_moss", "lora_meta") or it["key"].startswith("tagger/"):
            continue
        print(f"   {it['key']}｜{it['label']}｜{it['total']}")
    for _ in range(60):
        stt = call(port, "/api/setup/status")
        if not stt.get("running"):
            break
        time.sleep(1)
    print("problems：", json.dumps(stt.get("problems"), ensure_ascii=False)[:600])
    cfg = os.path.join(tmp, "anima_apitest", "a51", f"f_{name}", "cfg", "comfy.json")
    print("comfy.json：", open(cfg, encoding="utf-8").read().replace("\n", "") if os.path.exists(cfg) else "（沒有）")
