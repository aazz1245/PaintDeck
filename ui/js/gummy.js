// 軟糖小熊：可以抓、拉長、壓扁、丟的軟體物理（three.js）。等圖時在觀景窗裡玩（deck.js），gummy.html 是單獨的試玩頁。
//
// 物理：每隻熊 12 個質點（頭、耳、吻、胸、身體、肚子、背、手、腳），用形狀匹配（shape matching，Müller 2005）連起來：
//   整隻一組（保持體積的線性變形，所以壓頭會往兩側膨脹成煎餅）＋頭一組＋軀幹一組（局部比較硬），四肢和脖子只靠整隻那組拉著，所以拉得長。
//   position based dynamics，一格 1/60 秒切 4 小步；熊跟熊用質點球互撞；地板、牆會黏一下（拉離時先黏住再剝開）。
// 畫面：每隻熊一個 MarchingCubes（metaball 隱式曲面），四肢、脖子畫成點與點之間的鏈，拉長時變細；
//   材質是會折射、厚的地方吸光比較多的透明軟糖（厚度從 metaball 疊加量算，寫進頂點色、在 shader 裡當 thickness 用）。
import * as THREE from "three";
import { MarchingCubes } from "three/addons/MarchingCubes.js";
import { RoomEnvironment } from "three/addons/RoomEnvironment.js";

export const FLAVORS = [
  { name: "Cherry", zh: "櫻桃", deep: "#c4061c", base: "#ff6060" },
  { name: "Orange", zh: "橘子", deep: "#ff5e00", base: "#ffa04a" },
  { name: "Lemon", zh: "檸檬", deep: "#ffd400", base: "#fff27a", dist: 0.42 },
  { name: "Apple", zh: "青蘋果", deep: "#38a314", base: "#9be36a" },
  { name: "Pineapple", zh: "鳳梨（透明）", deep: "#ebc865", base: "#fff3d2", dist: 0.65 },
];

// ---------------------------------------------------------------- 熊的結構（經典坐姿：手往前、腳往前伸，面向 +z，身高約 1）
const BODY = 0, BELLY = 1, BACK = 2, CHEST = 3, HEAD = 4, SNOUT = 5, EAR_L = 6, EAR_R = 7, HAND_L = 8, HAND_R = 9, FOOT_L = 10, FOOT_R = 11;
// x, y, z, 碰撞半徑, 質量
const PTS = [
  [0, 0.32, -0.02, 0.22, 3], [0, 0.33, 0.1, 0.17, 2], [0, 0.36, -0.11, 0.17, 2], [0, 0.55, 0, 0.16, 1.5],
  [0, 0.8, 0, 0.2, 2], [0, 0.75, 0.17, 0.08, 0.5], [-0.14, 0.99, -0.03, 0.065, 0.3], [0.14, 0.99, -0.03, 0.065, 0.3],
  [-0.2, 0.5, 0.21, 0.07, 0.4], [0.2, 0.5, 0.21, 0.07, 0.4], [-0.14, 0.09, 0.21, 0.09, 0.6], [0.14, 0.09, 0.21, 0.09, 0.6],
];
const N = PTS.length;
// 畫的球：[a, b, t, 半徑, 厚度]；a≠b 是鏈（兩點之間的位置），拉長時變細
const BALLS = [
  [BODY, BODY, 0, 0.235, 1], [BELLY, BELLY, 0, 0.18, 1], [BACK, BACK, 0, 0.17, 1], [CHEST, CHEST, 0, 0.17, 0.9],
  [HEAD, HEAD, 0, 0.215, 1], [HEAD, SNOUT, 0.4, 0.16, 0.8], [SNOUT, SNOUT, 0, 0.09, 0.5],
  [EAR_L, EAR_L, 0, 0.072, 0.35], [EAR_R, EAR_R, 0, 0.072, 0.35], [HEAD, EAR_L, 0.62, 0.05, 0.3], [HEAD, EAR_R, 0.62, 0.05, 0.3],
  [CHEST, HEAD, 0.3, 0.14, 0.8], [CHEST, HEAD, 0.55, 0.14, 0.8], [CHEST, HEAD, 0.8, 0.15, 0.8],
  [CHEST, HAND_L, 0.45, 0.085, 0.5], [CHEST, HAND_L, 0.72, 0.08, 0.45], [HAND_L, HAND_L, 0, 0.078, 0.4],
  [CHEST, HAND_R, 0.45, 0.085, 0.5], [CHEST, HAND_R, 0.72, 0.08, 0.45], [HAND_R, HAND_R, 0, 0.078, 0.4],
  [BODY, FOOT_L, 0.5, 0.11, 0.65], [BODY, FOOT_L, 0.76, 0.1, 0.55], [FOOT_L, FOOT_L, 0, 0.095, 0.5],
  [BODY, FOOT_R, 0.5, 0.11, 0.65], [BODY, FOOT_R, 0.76, 0.1, 0.55], [FOOT_R, FOOT_R, 0, 0.095, 0.5],
];
// 拉長量（讀數）看這幾條鏈
const CHAINS = [[CHEST, HEAD], [CHEST, HAND_L], [CHEST, HAND_R], [BODY, FOOT_L], [BODY, FOOT_R], [HEAD, EAR_L], [HEAD, EAR_R]];
const CLUSTERS = [
  { idx: PTS.map((_, i) => i), k: 0.16, beta: 0.5, upright: true }, // 整隻：保持體積的線性變形；會慢慢坐正
  { idx: [HEAD, SNOUT, EAR_L, EAR_R], k: 0.55, beta: 0 },
  { idx: [BODY, BELLY, BACK, CHEST], k: 0.4, beta: 0.3 },
];
const UP_PARTS = [HEAD, SNOUT, EAR_L, EAR_R, CHEST];
const MAX_STRETCH = 2.0; // 鏈最多拉到幾倍（再長就把兩端拉回來，熊不會被扯斷）

const SUB = 4, DT = 1 / 60, H = DT / SUB;

// ---------------------------------------------------------------- 3×3 小工具（列優先，m[r*3+c]）
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}
const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
function quatMat(q) {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}
// 從變形矩陣抽出旋轉（Müller et al. 2016, "A Robust Method to Extract the Rotational Part of Deformations"），q 會被就地更新
function extractRotation(A, q, iters = 4) {
  for (let it = 0; it < iters; it++) {
    const R = quatMat(q);
    let ox = 0, oy = 0, oz = 0, dot = 0;
    for (let k = 0; k < 3; k++) {
      const rx = R[k], ry = R[3 + k], rz = R[6 + k], ax = A[k], ay = A[3 + k], az = A[6 + k];
      ox += ry * az - rz * ay; oy += rz * ax - rx * az; oz += rx * ay - ry * ax;
      dot += rx * ax + ry * ay + rz * az;
    }
    const s = 1 / (Math.abs(dot) + 1e-9);
    ox *= s; oy *= s; oz *= s;
    const w = Math.hypot(ox, oy, oz);
    if (w < 1e-9) break;
    const h = w / 2, sn = Math.sin(h) / w;
    const dx = ox * sn, dy = oy * sn, dz = oz * sn, dw = Math.cos(h);
    const [x, y, z, qw] = q;
    q[0] = dw * x + dx * qw + dy * z - dz * y;
    q[1] = dw * y - dx * z + dy * qw + dz * x;
    q[2] = dw * z + dx * y - dy * x + dz * qw;
    q[3] = dw * qw - dx * x - dy * y - dz * z;
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
  }
}

// 把 q 往「本地的上方（+y）朝向世界的上方」轉 k 比例的角度（就地更新）
function uprightQuat(q, k) {
  const R = quatMat(q), ux = R[1], uy = R[4], uz = R[7];
  const ang = Math.acos(Math.max(-1, Math.min(1, uy))) * k;
  const ax = -uz, az = ux, n = Math.hypot(ax, az);
  if (n < 1e-6 || ang < 1e-5) return;
  const s = Math.sin(ang / 2) / n, dx = ax * s, dz = az * s, dw = Math.cos(ang / 2);
  const [x, y, z, w] = q;
  q[0] = dw * x + dx * w - dz * y;
  q[1] = dw * y - dx * z + dz * x;
  q[2] = dw * z + dx * y + dz * w;
  q[3] = dw * w - dx * x - dz * z;
  const m = Math.hypot(q[0], q[1], q[2], q[3]);
  q[0] /= m; q[1] /= m; q[2] /= m; q[3] /= m;
}

// ---------------------------------------------------------------- 材質
let shadowTexture = null;
function shadowTex() {
  if (shadowTexture) return shadowTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.45, "rgba(255,255,255,.55)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  shadowTexture = new THREE.CanvasTexture(c);
  shadowTexture.colorSpace = THREE.SRGBColorSpace;
  return shadowTexture;
}

function gummyMaterial(fl, dark) {
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(fl.base),
    transmission: 1, thickness: 0.62, ior: 1.42, dispersion: 0.15,
    attenuationColor: new THREE.Color(fl.deep), attenuationDistance: fl.dist || (fl.name === "Pineapple" ? 1.6 : 0.2),
    roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, specularIntensity: 1,
    envMapIntensity: 1.15, vertexColors: true,
  });
  if (dark) {
    // 深色觀景窗後面沒有亮的東西可以透過來：加一點自發光，當成背光透過糖果
    m.emissive = new THREE.Color(fl.deep).multiplyScalar(fl.name === "Pineapple" ? 0.12 : 0.32);
  }
  m.onBeforeCompile = (sh) => {
    // 頂點色只拿來存厚度，不乘到顏色上
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <color_fragment>", "")
      .replace("#include <transmission_fragment>",
        THREE.ShaderChunk.transmission_fragment.replace("material.thickness = thickness;", "material.thickness = thickness * clamp( vColor.r, 0.25, 2.2 );"));
  };
  return m;
}

// ---------------------------------------------------------------- 一隻熊
class Bear {
  constructor(world, fl, pos, quat) {
    this.world = world;
    this.fl = fl;
    this.x = new Float32Array(N * 3); this.p = new Float32Array(N * 3); this.v = new Float32Array(N * 3);
    this.w = new Float32Array(N); this.r = new Float32Array(N); this.stick = new Float32Array(N);
    const R = quatMat(quat);
    for (let i = 0; i < N; i++) {
      const [px, py, pz, r, m] = PTS[i];
      const lx = px, ly = py - 0.45, lz = pz;
      this.x[i * 3] = pos.x + R[0] * lx + R[1] * ly + R[2] * lz;
      this.x[i * 3 + 1] = pos.y + R[3] * lx + R[4] * ly + R[5] * lz;
      this.x[i * 3 + 2] = pos.z + R[6] * lx + R[7] * ly + R[8] * lz;
      this.w[i] = 1 / m; this.r[i] = r;
    }
    this.p.set(this.x);
    this.clusters = CLUSTERS.map((cl) => {
      let M = 0, cx = 0, cy = 0, cz = 0;
      for (const i of cl.idx) { const m = 1 / this.w[i]; M += m; cx += PTS[i][0] * m; cy += PTS[i][1] * m; cz += PTS[i][2] * m; }
      cx /= M; cy /= M; cz /= M;
      const q = cl.idx.map((i) => [PTS[i][0] - cx, PTS[i][1] - cy, PTS[i][2] - cz]);
      const Aqq = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      cl.idx.forEach((i, j) => { const m = 1 / this.w[i]; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) Aqq[r * 3 + c] += m * q[j][r] * q[j][c]; });
      return { ...cl, q, M, AqqInv: inv3(Aqq), rot: [...quat] };
    });
    this.rest = CHAINS.map(([a, b]) => Math.hypot(PTS[a][0] - PTS[b][0], PTS[a][1] - PTS[b][1], PTS[a][2] - PTS[b][2]));
    this.ballRest = BALLS.map(([a, b]) => (a === b ? 0 : Math.hypot(PTS[a][0] - PTS[b][0], PTS[a][1] - PTS[b][1], PTS[a][2] - PTS[b][2])));
    this.nextHop = world.time + 1.5 + Math.random() * 5;
    this.hop = 0;
    this.stretch = 1;

    const mat = world.material(fl);
    this.mc = new MarchingCubes(world.res, mat, false, true, 14000);
    this.mc.isolation = 80;
    this.mc.frustumCulled = false;
    this.mc.castShadow = world.shadows;
    world.scene.add(this.mc);
    this.eyes = [0, 1, 2].map((k) => {
      const e = new THREE.Mesh(world.eyeGeo, mat);
      e.scale.setScalar(k === 2 ? 1.25 : 1);
      world.scene.add(e);
      return e;
    });
    const tint = new THREE.Color(fl.deep);
    this.shadow = new THREE.Mesh(world.shadowGeo, new THREE.MeshBasicMaterial({
      map: shadowTex(), color: world.dark ? tint : tint.clone().multiplyScalar(0.55).lerp(new THREE.Color("#6a5a50"), 0.3),
      transparent: true, depthWrite: false, opacity: 0.4,
      blending: world.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = -1;
    world.scene.add(this.shadow);
  }

  dispose() {
    const s = this.world.scene;
    s.remove(this.mc, this.shadow, ...this.eyes);
    this.mc.geometry.dispose();
    this.shadow.material.dispose();
  }

  com(arr = this.x) {
    let M = 0, x = 0, y = 0, z = 0;
    for (let i = 0; i < N; i++) { const m = 1 / this.w[i]; M += m; x += arr[i * 3] * m; y += arr[i * 3 + 1] * m; z += arr[i * 3 + 2] * m; }
    return [x / M, y / M, z / M];
  }

  shapeMatch(stiff) {
    const p = this.p;
    for (const cl of this.clusters) {
      let cx = 0, cy = 0, cz = 0;
      for (const i of cl.idx) { const m = 1 / this.w[i]; cx += p[i * 3] * m; cy += p[i * 3 + 1] * m; cz += p[i * 3 + 2] * m; }
      cx /= cl.M; cy /= cl.M; cz /= cl.M;
      const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      cl.idx.forEach((i, j) => {
        const m = 1 / this.w[i], d = [p[i * 3] - cx, p[i * 3 + 1] - cy, p[i * 3 + 2] - cz], q = cl.q[j];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) A[r * 3 + c] += m * d[r] * q[c];
      });
      extractRotation(A, cl.rot);
      if (cl.upright && this.uprightK > 0) uprightQuat(cl.rot, this.uprightK);
      let T = quatMat(cl.rot);
      if (cl.beta > 0 && cl.AqqInv) {
        const L = mul3(A, cl.AqqInv), det = det3(L);
        if (det > 0.05) {
          const s = 1 / Math.cbrt(det); // 體積不變：det 正規化成 1
          T = T.map((v, k) => (1 - cl.beta) * v + cl.beta * L[k] * s);
        }
      }
      const k = Math.min(1, cl.k * stiff);
      cl.idx.forEach((i, j) => {
        const q = cl.q[j];
        p[i * 3] += (cx + T[0] * q[0] + T[1] * q[1] + T[2] * q[2] - p[i * 3]) * k;
        p[i * 3 + 1] += (cy + T[3] * q[0] + T[4] * q[1] + T[5] * q[2] - p[i * 3 + 1]) * k;
        p[i * 3 + 2] += (cz + T[6] * q[0] + T[7] * q[1] + T[8] * q[2] - p[i * 3 + 2]) * k;
      });
    }
  }

  limitChains() {
    const p = this.p;
    CHAINS.forEach(([a, c], k) => {
      const dx = p[c * 3] - p[a * 3], dy = p[c * 3 + 1] - p[a * 3 + 1], dz = p[c * 3 + 2] - p[a * 3 + 2];
      const len = Math.hypot(dx, dy, dz), max = this.rest[k] * MAX_STRETCH;
      if (len <= max) return;
      const wa = this.w[a], wc = this.w[c], f = (len - max) / len / (wa + wc);
      p[a * 3] += dx * f * wa; p[a * 3 + 1] += dy * f * wa; p[a * 3 + 2] += dz * f * wa;
      p[c * 3] -= dx * f * wc; p[c * 3 + 1] -= dy * f * wc; p[c * 3 + 2] -= dz * f * wc;
    });
  }

  // 只減掉「變形」的速度，整隻的移動和旋轉保留（Müller PBD 論文的阻尼）
  dampDeform(kd) {
    const x = this.x, v = this.v;
    let M = 0; const c = [0, 0, 0], vc = [0, 0, 0];
    for (let i = 0; i < N; i++) { const m = 1 / this.w[i]; M += m; for (let a = 0; a < 3; a++) { c[a] += x[i * 3 + a] * m; vc[a] += v[i * 3 + a] * m; } }
    for (let a = 0; a < 3; a++) { c[a] /= M; vc[a] /= M; }
    const L = [0, 0, 0], I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      const m = 1 / this.w[i], r0 = x[i * 3] - c[0], r1 = x[i * 3 + 1] - c[1], r2 = x[i * 3 + 2] - c[2];
      const v0 = v[i * 3] * m, v1 = v[i * 3 + 1] * m, v2 = v[i * 3 + 2] * m;
      L[0] += r1 * v2 - r2 * v1; L[1] += r2 * v0 - r0 * v2; L[2] += r0 * v1 - r1 * v0;
      const rr = r0 * r0 + r1 * r1 + r2 * r2;
      I[0] += m * (rr - r0 * r0); I[4] += m * (rr - r1 * r1); I[8] += m * (rr - r2 * r2);
      I[1] -= m * r0 * r1; I[2] -= m * r0 * r2; I[5] -= m * r1 * r2;
    }
    I[3] = I[1]; I[6] = I[2]; I[7] = I[5];
    const Ii = inv3(I);
    const w = Ii ? [Ii[0] * L[0] + Ii[1] * L[1] + Ii[2] * L[2], Ii[3] * L[0] + Ii[4] * L[1] + Ii[5] * L[2], Ii[6] * L[0] + Ii[7] * L[1] + Ii[8] * L[2]] : [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const r0 = x[i * 3] - c[0], r1 = x[i * 3 + 1] - c[1], r2 = x[i * 3 + 2] - c[2];
      v[i * 3] += (vc[0] + w[1] * r2 - w[2] * r1 - v[i * 3]) * kd;
      v[i * 3 + 1] += (vc[1] + w[2] * r0 - w[0] * r2 - v[i * 3 + 1]) * kd;
      v[i * 3 + 2] += (vc[2] + w[0] * r1 - w[1] * r0 - v[i * 3 + 2]) * kd;
    }
    return vc;
  }

  // ---------------------------------------------------------------- 畫面：metaball＋眼睛鼻子＋影子
  draw() {
    const x = this.x, mc = this.mc;
    // 幾乎沒動（靜止的熊）就不重算曲面：metaball 是最花時間的部分
    if (this.meshX && !this.world.floorOpen) {
      let d = 0;
      for (let i = 0; i < N * 3; i++) d = Math.max(d, Math.abs(x[i] - this.meshX[i]));
      if (d < 0.004) return;
    }
    this.meshX = Float32Array.from(x);
    const pos = BALLS.map(([a, b, t, r, th], k) => {
      const ax = x[a * 3], ay = x[a * 3 + 1], az = x[a * 3 + 2];
      if (a === b) return [ax, ay, az, r, th];
      const bx = x[b * 3], by = x[b * 3 + 1], bz = x[b * 3 + 2];
      const len = Math.hypot(bx - ax, by - ay, bz - az), s = len / this.ballRest[k];
      return [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, r * Math.min(1.1, Math.max(0.58, 1 / Math.sqrt(s))), th];
    });
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const [bx, by, bz, r] of pos) {
      x0 = Math.min(x0, bx - r); y0 = Math.min(y0, by - r); z0 = Math.min(z0, bz - r);
      x1 = Math.max(x1, bx + r); y1 = Math.max(y1, by + r); z1 = Math.max(z1, bz + r);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const half = Math.max(0.6, (Math.max(x1 - x0, y1 - y0, z1 - z0) / 2) * 1.12 + 0.06);
    mc.position.set(cx, cy, cz);
    mc.scale.setScalar(half);
    mc.reset();
    const inv = 1 / (2 * half), sub = this.world.blend, str = 80 + sub;
    for (const [bx, by, bz, r, th] of pos) {
      const rn = r * inv;
      mc.addBall((bx - cx) * inv + 0.5, (by - cy) * inv + 0.5, (bz - cz) * inv + 0.5, rn * rn * str, sub, [th, 0, 0]);
    }
    mc.update();

    // 頭的方向：往前＝吻、往上＝胸到頭
    const h = [x[HEAD * 3], x[HEAD * 3 + 1], x[HEAD * 3 + 2]];
    const f = new THREE.Vector3(x[SNOUT * 3] - h[0], x[SNOUT * 3 + 1] - h[1], x[SNOUT * 3 + 2] - h[2]).normalize();
    const u = new THREE.Vector3(h[0] - x[CHEST * 3], h[1] - x[CHEST * 3 + 1], h[2] - x[CHEST * 3 + 2]);
    u.addScaledVector(f, -u.dot(f)).normalize();
    const rgt = new THREE.Vector3().crossVectors(u, f).normalize();
    const hv = new THREE.Vector3(...h);
    this.eyes[0].position.copy(hv).addScaledVector(f, 0.165).addScaledVector(u, 0.075).addScaledVector(rgt, 0.075);
    this.eyes[1].position.copy(hv).addScaledVector(f, 0.165).addScaledVector(u, 0.075).addScaledVector(rgt, -0.075);
    this.eyes[2].position.set(x[SNOUT * 3], x[SNOUT * 3 + 1], x[SNOUT * 3 + 2]).addScaledVector(f, 0.085).addScaledVector(u, 0.02);

    const W = this.world, fy = W.floorY;
    const height = Math.max(0, y0 - fy);
    this.shadow.position.set(cx, fy + 0.003, cz);
    this.shadow.scale.set((x1 - x0) * 1.2 + 0.15 + height * 0.6, (z1 - z0) * 1.2 + 0.3 + height * 0.6, 1);
    this.shadow.material.opacity = (W.dark ? 0.32 : 0.2) * Math.max(0, 1 - height / 2.5) * (W.floorOpen ? 0 : 1);
    this.lowest = y1;
  }
}

// ---------------------------------------------------------------- 世界
export class GummyWorld {
  /**
   * @param {HTMLElement} el 放畫布的容器（畫布填滿它）
   * @param {object} o  dark：深色背景（觀景窗）；table：畫一張白桌子；viewHeight：畫面高度約幾隻熊；res：metaball 解析度
   *                    input：收滑鼠事件的元素（預設 el）；onCursor(state)：游標狀態 "" | "hover" | "grab"
   */
  constructor(el, o = {}) {
    this.el = el;
    this.dark = !!o.dark;
    this.res = o.res || 34;
    this.viewHeight = o.viewHeight || 5.5;
    this.elevation = o.elevation || 40;
    this.floorNdc = o.floorNdc ?? -0.86; // 地板前緣放在畫面的哪個高度（-1＝最下緣，再小就是出了畫面、熊會比較靠中間）
    this.blend = o.blend || 30; // metaball 融合：越大越分明（耳朵、手腳越清楚）
    this.shadows = !!o.table; // 白桌才畫真的影子（深色觀景窗看不到，省掉）
    this.onCursor = o.onCursor || (() => {});
    this.bears = [];
    this.time = 0;
    this.wobble = 0.5; // 0 硬、1 很抖
    this.floorY = 0;
    this.floorOpen = false;
    this.depth = 1.7;
    this.mats = new Map();
    this.grab = null;
    this.stats = { stretch: 1, bounce: 0, bounces: 0 };
    this.running = false;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: !o.table, powerPreference: "low-power", preserveDrawingBuffer: !!o.preserve }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, o.pixelRatio || 1.5));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = o.exposure || 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    el.append(r.domElement);
    if ("transmissionResolutionScale" in r) r.transmissionResolutionScale = o.transmissionScale || 0.6;

    const s = (this.scene = new THREE.Scene());
    const pm = new THREE.PMREMGenerator(r);
    s.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    const key = new THREE.DirectionalLight("#fff6ea", o.table ? 3 : 2.4);
    key.position.set(-5, 6, 2.5);
    if (o.table) {
      const bg = new THREE.Color(o.background || "#f3f2f0");
      s.background = bg;
      s.fog = new THREE.Fog(bg, 14, 34); // 桌子遠處淡進背景，看不到桌緣
      const t = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: o.tableColor || "#f6f5f3", roughness: 0.9, envMapIntensity: 0.25 }));
      t.rotation.x = -Math.PI / 2;
      t.receiveShadow = true;
      s.add(t);
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.radius = 4;
      key.shadow.bias = -0.0015;
      Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 30 });
    }
    const back = new THREE.DirectionalLight("#ffffff", 2.6);
    back.position.set(2, 3, -6);
    s.add(key, back, new THREE.HemisphereLight("#ffffff", "#e8e2da", o.table ? 0.15 : 0.6));

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.eyeGeo = new THREE.SphereGeometry(0.03, 16, 12);
    this.shadowGeo = new THREE.PlaneGeometry(1, 1);
    this.ray = new THREE.Raycaster();

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.bindInput(o.input || el);
    this.loop = this.loop.bind(this);
    this.onVis = () => { if (!document.hidden && this.running) { this.last = performance.now(); requestAnimationFrame(this.loop); } };
    document.addEventListener("visibilitychange", this.onVis);
  }

  material(fl) {
    if (!this.mats.has(fl.name)) this.mats.set(fl.name, gummyMaterial(fl, this.dark));
    return this.mats.get(fl.name);
  }

  resize() {
    const w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight);
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    // 從斜上方看（elevation 度）；畫面高度約 viewHeight 隻熊；地板前緣放在畫面下緣附近
    const el = (this.elevation * Math.PI) / 180, dist = this.viewHeight / 2 / Math.tan((cam.fov * Math.PI) / 360);
    let ty = 1.4;
    for (let k = 0; k < 24; k++) {
      cam.position.set(0, ty + dist * Math.sin(el), dist * Math.cos(el));
      cam.lookAt(0, ty, 0);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      const v = new THREE.Vector3(0, this.floorY, this.depth / 2).project(cam);
      ty += (v.y - this.floorNdc) * 0.9;
    }
    // 左右牆：在 z=0 的平面上剛好貼著畫面邊緣
    const hw = Math.tan((cam.fov * Math.PI) / 360) * dist * cam.aspect;
    this.halfW = Math.max(1.2, hw * 0.94);
    this.top = ty + this.viewHeight * 0.6;
  }

  // ---------------------------------------------------------------- 加熊、結束
  // flavor：只倒這個口味（沒給就混著）
  pour(n = 6, flavor = null) {
    for (let k = 0; k < n; k++) {
      const fl = flavor || FLAVORS[Math.floor(Math.random() * FLAVORS.length)];
      const pos = { x: (Math.random() * 2 - 1) * (this.halfW - 0.5), y: this.top + 0.6 + k * 0.55, z: (Math.random() * 2 - 1) * (this.depth / 2 - 0.35) };
      // 大致坐正、臉朝鏡頭左右（掉下來會晃，落地後自己坐正）
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 2.6, (Math.random() - 0.5) * 0.9));
      const b = new Bear(this, fl, pos, [q.x, q.y, q.z, q.w]);
      for (let i = 0; i < N; i++) b.v[i * 3 + 1] = -2 - Math.random() * 2;
      this.bears.push(b);
    }
    this.floorOpen = false;
    this.start();
  }

  // 圖出來了：地板打開，熊掉下去，全部離開畫面後停下來
  leave(done) {
    this.floorOpen = true;
    this.grab = null;
    this.onLeft = done;
    for (const b of this.bears) for (let i = 0; i < N; i++) b.v[i * 3 + 1] += 1.5 + Math.random();
    this.start();
  }

  clear() {
    for (const b of this.bears) b.dispose();
    this.bears = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    requestAnimationFrame(this.loop);
  }

  stop() { this.running = false; }

  dispose() {
    this.stop();
    this.clear();
    this.ro.disconnect();
    document.removeEventListener("visibilitychange", this.onVis);
    this.unbind?.();
    for (const m of this.mats.values()) m.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  loop(now) {
    if (!this.running || document.hidden) return;
    this.acc = Math.min(this.acc + (now - this.last) / 1000, DT * 3);
    this.last = now;
    while (this.acc >= DT) { this.step(); this.acc -= DT; }
    for (const b of this.bears) b.draw();
    this.renderer.render(this.scene, this.camera);
    if (this.floorOpen && this.bears.length && this.bears.every((b) => b.lowest < this.floorY - 2.5)) {
      this.clear();
      this.renderer.render(this.scene, this.camera);
      this.running = false;
      const cb = this.onLeft; this.onLeft = null;
      cb?.();
      return;
    }
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- 物理一格
  step() {
    this.time += DT;
    const g = -26, stiff = (this.kScale || 1) * (1.5 - this.wobble), kd = 0.03 - this.wobble * 0.022;
    const bears = this.bears, hw = this.halfW, hd = this.depth / 2, fy = this.floorY;
    this.hops();
    let maxStretch = 1, bounce = this.stats.bounce * 0.97, bounces = this.stats.bounces;
    // 坐正的力：貼近地板時比較強（像不倒翁），在空中很弱（甩出去會翻滾），被抓著不轉
    for (const b of bears) {
      let low = Infinity;
      for (let i = 0; i < N; i++) low = Math.min(low, b.x[i * 3 + 1] - b.r[i]);
      b.uprightK = this.grab?.bear === b || this.floorOpen ? 0 : low < fy + 0.15 ? 0.06 : 0.004;
      b.low = low;
    }
    for (let s = 0; s < SUB; s++) {
      for (const b of bears) {
        const { x, p, v } = b;
        for (let i = 0; i < N * 3; i++) {
          if (i % 3 === 1) v[i] += g * H;
          v[i] *= 1 - 0.25 * H;
          p[i] = x[i] + v[i] * H;
        }
      }
      // 抓著的那一點往滑鼠拉
      const gr = this.grab;
      if (gr) {
        const p = gr.bear.p, i = gr.i;
        for (let a = 0; a < 3; a++) p[i * 3 + a] += (gr.target[a] - p[i * 3 + a]) * 0.55;
      }
      for (const b of bears) { b.shapeMatch(stiff); b.limitChains(); }
      this.collide();
      for (const b of bears) {
        const { p, r, stick } = b;
        const pulled = gr && gr.bear === b;
        for (let i = 0; i < N; i++) {
          const ri = r[i], ix = i * 3;
          // 地板：摩擦大，拉起來時先黏著（stick），超過一段距離才剝開
          if (!this.floorOpen) {
            if (p[ix + 1] < fy + ri) {
              p[ix + 1] = fy + ri;
              p[ix] = b.x[ix] + (p[ix] - b.x[ix]) * 0.45;
              p[ix + 2] = b.x[ix + 2] + (p[ix + 2] - b.x[ix + 2]) * 0.45;
              stick[i] = 1;
            } else if (stick[i] > 0) {
              const gap = p[ix + 1] - fy - ri;
              if (gap > (pulled ? 0.07 : 0.025)) stick[i] = 0;
              else p[ix + 1] -= gap * (pulled ? 0.6 : 0.35);
            }
          }
          // 牆：碰到會黏著慢慢滑
          if (p[ix] < -hw + ri) { p[ix] = -hw + ri; p[ix + 1] = b.x[ix + 1] + (p[ix + 1] - b.x[ix + 1]) * 0.7; }
          if (p[ix] > hw - ri) { p[ix] = hw - ri; p[ix + 1] = b.x[ix + 1] + (p[ix + 1] - b.x[ix + 1]) * 0.7; }
          if (p[ix + 2] < -hd + ri) p[ix + 2] = -hd + ri;
          if (p[ix + 2] > hd - ri) p[ix + 2] = hd - ri;
        }
      }
      for (const b of bears) {
        const { x, p, v } = b;
        for (let i = 0; i < N * 3; i++) {
          let vi = (p[i] - x[i]) / H;
          if (vi > 30) vi = 30; else if (vi < -30) vi = -30;
          v[i] = vi;
          x[i] = p[i];
        }
        const vc = b.dampDeform(kd);
        if (s === SUB - 1) {
          bounce = Math.max(bounce, Math.abs(vc[1]));
          // 落地彈起來一次＝往下掉的速度轉成往上
          if (b.vyPrev < -2.2 && vc[1] > -0.2 && b.low < fy + 0.2) bounces++;
          b.vyPrev = vc[1];
        }
      }
    }
    for (const b of bears) {
      let m = 1;
      CHAINS.forEach(([a, c], k) => {
        const len = Math.hypot(b.x[a * 3] - b.x[c * 3], b.x[a * 3 + 1] - b.x[c * 3 + 1], b.x[a * 3 + 2] - b.x[c * 3 + 2]);
        m = Math.max(m, len / b.rest[k]);
      });
      b.stretch = m;
      maxStretch = Math.max(maxStretch, m);
    }
    this.stats = { stretch: maxStretch, bounce, bounces };
  }

  // 熊跟熊：質點球互推，加一點摩擦（軟糖有點黏）
  collide() {
    const bs = this.bears;
    for (let a = 0; a < bs.length; a++) {
      const A = bs[a];
      for (let b = a + 1; b < bs.length; b++) {
        const B = bs[b];
        for (let i = 0; i < N; i++) {
          const ix = i * 3;
          for (let j = 0; j < N; j++) {
            const jx = j * 3;
            const dx = B.p[jx] - A.p[ix], dy = B.p[jx + 1] - A.p[ix + 1], dz = B.p[jx + 2] - A.p[ix + 2];
            const rr = A.r[i] + B.r[j], d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= rr * rr || d2 < 1e-10) continue;
            const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, nz = dz / d, wa = A.w[i], wb = B.w[j], ws = wa + wb;
            const pen = (rr - d) / ws;
            A.p[ix] -= nx * pen * wa; A.p[ix + 1] -= ny * pen * wa; A.p[ix + 2] -= nz * pen * wa;
            B.p[jx] += nx * pen * wb; B.p[jx + 1] += ny * pen * wb; B.p[jx + 2] += nz * pen * wb;
            // 摩擦：相對的切向位移減掉一部分
            let tx = (A.p[ix] - A.x[ix]) - (B.p[jx] - B.x[jx]), ty = (A.p[ix + 1] - A.x[ix + 1]) - (B.p[jx + 1] - B.x[jx + 1]), tz = (A.p[ix + 2] - A.x[ix + 2]) - (B.p[jx + 2] - B.x[jx + 2]);
            const dn = tx * nx + ty * ny + tz * nz;
            tx -= dn * nx; ty -= dn * ny; tz -= dn * nz;
            const f = 0.35 / ws;
            A.p[ix] -= tx * f * wa; A.p[ix + 1] -= ty * f * wa; A.p[ix + 2] -= tz * f * wa;
            B.p[jx] += tx * f * wb; B.p[jx + 1] += ty * f * wb; B.p[jx + 2] += tz * f * wb;
          }
        }
      }
    }
  }

  // 閒著的熊偶爾自己跳一下：先往下蹲（壓扁），再彈起來
  hops() {
    if (this.floorOpen) return;
    for (const b of this.bears) {
      if (this.grab?.bear === b) continue;
      if (b.hop > 0) {
        b.hop -= DT;
        if (b.hop <= 0) {
          const vx = (Math.random() * 2 - 1) * 0.9, vz = (Math.random() * 2 - 1) * 0.5, vy = 4.6 + Math.random() * 1.6;
          const spin = (Math.random() * 2 - 1) * 3, c = b.com();
          for (let i = 0; i < N; i++) {
            b.v[i * 3] += vx - spin * (b.x[i * 3 + 1] - c[1]) * 0.3;
            b.v[i * 3 + 1] += vy + spin * (b.x[i * 3] - c[0]) * 0.3;
            b.v[i * 3 + 2] += vz;
          }
        }
        continue;
      }
      if (this.time < b.nextHop) continue;
      b.nextHop = this.time + 2.5 + Math.random() * 6;
      let ke = 0, low = Infinity;
      for (let i = 0; i < N; i++) { ke += b.v[i * 3] ** 2 + b.v[i * 3 + 1] ** 2 + b.v[i * 3 + 2] ** 2; low = Math.min(low, b.x[i * 3 + 1] - b.r[i]); }
      if (ke / N > 0.3 || low > this.floorY + 0.05) continue;
      b.hop = 0.14;
      for (const i of UP_PARTS) b.v[i * 3 + 1] -= 2.2;
    }
  }

  // ---------------------------------------------------------------- 滑鼠：抓最近的質點，拖曳平面面向鏡頭
  pick(e) {
    const rc = this.renderer.domElement.getBoundingClientRect();
    if (!rc.width) return null;
    const ndc = new THREE.Vector2(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    let best = null;
    for (const b of this.bears) {
      for (let i = 0; i < N; i++) {
        const px = b.x[i * 3] - o.x, py = b.x[i * 3 + 1] - o.y, pz = b.x[i * 3 + 2] - o.z;
        const t = px * d.x + py * d.y + pz * d.z;
        if (t < 0) continue;
        const dist = Math.hypot(px - d.x * t, py - d.y * t, pz - d.z * t), reach = b.r[i] * 1.35 + 0.05;
        if (dist > reach) continue;
        const score = t - (reach - dist) * 0.5;
        if (!best || score < best.score) best = { bear: b, i, t, score };
      }
    }
    return best;
  }

  rayPoint(e, out) {
    const rc = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.grab.plane, hit)) return out;
    // 不讓它被拖出盒子太遠（拖到地板下面＝往下壓）
    hit.x = Math.max(-this.halfW - 0.3, Math.min(this.halfW + 0.3, hit.x));
    hit.y = Math.max(this.floorY - 0.4, Math.min(this.top + 1, hit.y));
    hit.z = Math.max(-this.depth, Math.min(this.depth, hit.z));
    out[0] = hit.x; out[1] = hit.y; out[2] = hit.z;
    return out;
  }

  bindInput(el) {
    const down = (e) => {
      if (e.button !== 0 || this.floorOpen) return;
      const hit = this.pick(e);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      const b = hit.bear, i = hit.i, pt = new THREE.Vector3(b.x[i * 3], b.x[i * 3 + 1], b.x[i * 3 + 2]);
      const n = new THREE.Vector3();
      this.camera.getWorldDirection(n);
      this.grab = { bear: b, i, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n.negate(), pt), target: [pt.x, pt.y, pt.z] };
      b.hop = 0;
      b.nextHop = this.time + 3 + Math.random() * 4;
      try { el.setPointerCapture(e.pointerId); } catch { /* 沒關係 */ }
      this.onCursor("grab");
      this.start();
    };
    const move = (e) => {
      if (this.grab) { this.rayPoint(e, this.grab.target); return; }
      if (this.bears.length && !this.floorOpen) this.onCursor(this.pick(e) ? "hover" : "");
    };
    const eatClick = (e) => { e.stopPropagation(); e.preventDefault(); };
    const up = (e) => {
      if (!this.grab) return;
      this.grab = null;
      try { el.releasePointerCapture(e.pointerId); } catch { /* 沒關係 */ }
      // 放開後緊接著的 click 吃掉（不然觀景窗會以為點了圖、打開大圖）
      el.addEventListener("click", eatClick, { capture: true, once: true });
      setTimeout(() => el.removeEventListener("click", eatClick, true), 0);
      this.onCursor(this.pick(e) ? "hover" : "");
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    const leaveEl = () => { if (!this.grab) this.onCursor(""); };
    el.addEventListener("pointerleave", leaveEl);
    this.unbind = () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leaveEl);
    };
  }
}
