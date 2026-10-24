"""把 scenes.json 每個場景丟給 Blender 渲染深度圖＋算關節，再畫成 OpenPose 骨架圖。
用法：python run_all.py <輸出資料夾> [場景名,場景名]
Blender 位置：環境變數 BLENDER（沒設就用開發機的 4.5.14 免安裝版路徑）"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from skeleton import draw  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
BLENDER = os.environ.get("BLENDER") or r"D:\AI\tools\blender-4.5.14-windows-x64\blender.exe"
out = sys.argv[1]
only = sys.argv[2].split(",") if len(sys.argv) > 2 else None
os.makedirs(out, exist_ok=True)
for sc in json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf-8")):
    if only and sc["name"] not in only:
        continue
    tmp = os.path.join(out, sc["name"] + "_scene.json")
    json.dump(sc, open(tmp, "w", encoding="utf-8"))
    r = subprocess.run([BLENDER, "-b", "--factory-startup", "--python", os.path.join(HERE, "blender_pose.py"), "--", tmp, out],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or "完成" not in r.stdout:
        print(sc["name"], "Blender 失敗\n", (r.stdout + r.stderr)[-2000:])
        continue
    kps = json.load(open(os.path.join(out, sc["name"] + "_kp.json")))
    if sc.get("mirror"):  # 左右鏡像：深度圖翻轉，骨架 x 翻轉並把左右關節對調（OpenPose 顏色分左右）
        from PIL import Image, ImageOps
        dp = os.path.join(out, sc["name"] + "_depth.png")
        ImageOps.mirror(Image.open(dp)).save(dp)
        swap = {2: 5, 3: 6, 4: 7, 8: 11, 9: 12, 10: 13, 14: 15, 16: 17}
        swap.update({v: k for k, v in swap.items()})
        kps = [[[1 - kp[swap.get(i, i)][0], kp[swap.get(i, i)][1], kp[swap.get(i, i)][2]] for i in range(18)] for kp in kps]
    people = []
    for kp in kps:
        people.append({i: (x, y) for i, (x, y, z) in enumerate(kp) if z > 0.05 and -0.3 < x < 1.3 and -0.3 < y < 1.3})
    draw(people, sc["width"], sc["height"], os.path.join(out, sc["name"] + "_pose.png"))
    print(sc["name"], "ok")
