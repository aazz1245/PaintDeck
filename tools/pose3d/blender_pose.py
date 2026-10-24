"""在 Blender 裡用「方向＋標準骨長」擺出人偶（metaball 膠囊組成的身體），從指定鏡頭渲染深度圖，並輸出 18 個 OpenPose 關節的 2D 座標。
用法：blender -b --factory-startup --python blender_pose.py -- <場景.json> <輸出資料夾>
場景 JSON：{"name":..., "width":..., "height":..., "camera":{"loc":[x,y,z],"look":[x,y,z],"lens":35},
           "people":[{"sex":"f"|"m", "pelvis":[x,y,z], "up":[...軀幹方向 骨盆→脖子], "front":[...胸口朝向],
                      "head":[...脖子→頭頂方向，可省略＝跟軀幹同向], "face":[...臉朝向，可省略＝front],
                      "r_thigh":[...], "r_shin":[...], "l_thigh":[...], "l_shin":[...],
                      "r_upper":[...], "r_fore":[...], "l_upper":[...], "l_fore":[...]}]}
座標：x 往右、y 往畫面深處、z 往上，單位公尺。左右是人物自己的左右。"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

args = sys.argv[sys.argv.index("--") + 1:]
scene_path, out_dir = args[0], args[1]
S = json.load(open(scene_path, encoding="utf-8"))
os.makedirs(out_dir, exist_ok=True)

# 標準骨長（公尺）：女／男
L = {
    "f": dict(spine=0.50, neck=0.10, head=0.22, shoulder=0.17, hip=0.16, thigh=0.44, shin=0.42, upper=0.29, fore=0.25, r_torso=0.13, r_limb=0.065, r_arm=0.042),
    "m": dict(spine=0.54, neck=0.11, head=0.24, shoulder=0.21, hip=0.15, thigh=0.47, shin=0.45, upper=0.32, fore=0.28, r_torso=0.15, r_limb=0.075, r_arm=0.05),
}


def V(a):
    return Vector(a).normalized()


def joints(p):
    """FK：由骨盆位置和各段方向算出關節 3D 位置"""
    s = L[p["sex"]]
    pel = Vector(p["pelvis"])
    up, front = V(p["up"]), V(p["front"])
    side = up.cross(front).normalized()  # 人物的左手方向
    neck = pel + up * s["spine"]
    hd = V(p.get("head", p["up"]))
    head_c = neck + hd * (s["neck"] + s["head"] * 0.45)
    face = V(p.get("face", p["front"]))
    j = {"pelvis": pel, "neck": neck, "head": head_c, "nose": head_c + face * s["head"] * 0.42}
    j["r_sho"], j["l_sho"] = neck - side * s["shoulder"], neck + side * s["shoulder"]
    j["r_hip"], j["l_hip"] = pel - side * s["hip"], pel + side * s["hip"]
    for k in ("r", "l"):
        j[f"{k}_elb"] = j[f"{k}_sho"] + V(p[f"{k}_upper"]) * s["upper"]
        j[f"{k}_wri"] = j[f"{k}_elb"] + V(p[f"{k}_fore"]) * s["fore"]
        j[f"{k}_knee"] = j[f"{k}_hip"] + V(p[f"{k}_thigh"]) * s["thigh"]
        j[f"{k}_ank"] = j[f"{k}_knee"] + V(p[f"{k}_shin"]) * s["shin"]
    # 眼睛、耳朵：臉的左右
    fside = hd.cross(face).normalized()
    j["r_eye"] = j["nose"] - face * 0.03 + hd * 0.04 - fside * 0.035
    j["l_eye"] = j["nose"] - face * 0.03 + hd * 0.04 + fside * 0.035
    j["r_ear"] = head_c - fside * s["head"] * 0.42
    j["l_ear"] = head_c + fside * s["head"] * 0.42
    j["_side"], j["_front"], j["_up"] = side, front, up
    return j


def capsule(mb, a, b, r):
    """圓柱＋兩端圓球（深度圖只看表面，不需要真的融合）"""
    a, b = Vector(a), Vector(b)
    d = b - a
    if d.length > 1e-4:
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d.length, location=(a + b) / 2, vertices=24)
        o = bpy.context.object
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    for c in (a, b):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=c, segments=24, ring_count=12)


def ball(mb, c, r):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=Vector(c), segments=32, ring_count=16)


bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.resolution_x, sc.render.resolution_y = S["width"], S["height"]
sc.render.engine = "CYCLES"
sc.cycles.samples = 1
sc.cycles.device = "CPU"

all2d = []
for n, p in enumerate(S["people"]):
    j = joints(p)
    s = L[p["sex"]]
    mbd = None
    chest = j["neck"] - j["_up"] * 0.12
    capsule(mbd, j["pelvis"] + j["_up"] * 0.05, chest, s["r_torso"])
    capsule(mbd, j["r_sho"], j["l_sho"], s["r_arm"] * 1.2)
    capsule(mbd, j["r_hip"], j["l_hip"], s["r_limb"] * 1.4)
    capsule(mbd, j["neck"], j["head"], 0.05)
    ball(mbd, j["head"], s["head"] * 0.5)
    if p["sex"] == "f":
        for sd in (-1, 1):
            ball(mbd, chest - j["_up"] * 0.05 + j["_front"] * 0.09 + j["_side"] * sd * 0.07, 0.075)
    for k in ("r", "l"):
        capsule(mbd, j[f"{k}_sho"], j[f"{k}_elb"], s["r_arm"])
        capsule(mbd, j[f"{k}_elb"], j[f"{k}_wri"], s["r_arm"] * 0.8)
        capsule(mbd, j[f"{k}_hip"], j[f"{k}_knee"], s["r_limb"])
        capsule(mbd, j[f"{k}_knee"], j[f"{k}_ank"], s["r_limb"] * 0.75)
    p["_j"] = j

# 床（深度圖裡要看得到身體壓在床上）
bed = S.get("bed")
if bed:
    bpy.ops.mesh.primitive_cube_add(size=1, location=bed["center"])
    bpy.context.object.scale = bed["size"]

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = S["camera"].get("lens", 35)
cam = bpy.data.objects.new("cam", cam_data)
sc.collection.objects.link(cam)
cam.location = Vector(S["camera"]["loc"])
cam.rotation_mode = "QUATERNION"
cam.rotation_quaternion = (Vector(S["camera"]["look"]) - cam.location).to_track_quat("-Z", "Y")
sc.camera = cam
bpy.context.view_layer.update()

ORDER = ["nose", "neck", "r_sho", "r_elb", "r_wri", "l_sho", "l_elb", "l_wri", "r_hip", "r_knee", "r_ank", "l_hip", "l_knee", "l_ank", "r_eye", "l_eye", "r_ear", "l_ear"]
for p in S["people"]:
    kp = []
    for name in ORDER:
        c = world_to_camera_view(sc, cam, p["_j"][name])
        kp.append([round(c.x, 4), round(1 - c.y, 4), round(c.z, 3)])  # 比例座標，y 由上往下；z＝離鏡頭距離（負的＝在鏡頭後面）
    all2d.append(kp)
json.dump(all2d, open(os.path.join(out_dir, S["name"] + "_kp.json"), "w"), indent=0)

# 深度圖：Z pass → 正規化 → 反轉（近白遠黑）
sc.view_layers[0].use_pass_z = True
sc.use_nodes = True
nt = sc.node_tree
nt.nodes.clear()
rl = nt.nodes.new("CompositorNodeRLayers")
mr = nt.nodes.new("CompositorNodeMapRange")  # 近（depth[0]）→ 白，遠（depth[1]）→ 黑，背景夾成黑
near, far = S["camera"].get("depth", [0.5, 5.0])
mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = near, far
mr.inputs["To Min"].default_value, mr.inputs["To Max"].default_value = 1.0, 0.0
mr.use_clamp = True
comp = nt.nodes.new("CompositorNodeComposite")
nt.links.new(rl.outputs["Depth"], mr.inputs["Value"])
nt.links.new(mr.outputs[0], comp.inputs["Image"])
world = bpy.data.worlds.new("w")
sc.world = world
sc.render.filepath = os.path.join(out_dir, S["name"] + "_depth.png")
sc.render.image_settings.color_mode = "BW"
bpy.ops.render.render(write_still=True)
print("完成", S["name"])
