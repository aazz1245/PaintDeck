// 漫畫台的排版工作台（2026-10-27 使用者：「他的[自訂]功能，能夠更加智能，可以自由堆疊，也更直覺，不要單純按鈕點一點」；
// 設計 docs\superpowers\specs\2026-10-27-comic-free-layout-design.md）。
// 版面＝一刀一刀切出來的樹＋疊在上面的小格，跟後端 src-tauri\src\comic.rs 的 free_cells 同一套規則：
//   custom = {v: 2, tree: Node, insets: [{id, x0, y0, x1, y1, brk}]}
//   Node = {split: "row"|"col", at, slant, a, b} | {id, brk}；row＝橫刀（a 上 b 下），col＝直刀（a 左 b 右）
//   閱讀順序：橫刀先讀上面、直刀先讀右邊；疊的小格接在它底下那格後面。格子內容（panels 陣列）照這個順序。
// 上半是純函式（tests/comic_layout.test.cjs），下半是畫圖和工作台視窗。
import { el, toast } from "./util.js";

export const MAX_PANELS = 8;
export const MAX_INSETS = 2;
const AT_MIN = 0.15, AT_MAX = 0.85, SLANT_MAX = 0.2;
const SNAPS = [1 / 3, 0.5, 2 / 3];

const clone = (v) => JSON.parse(JSON.stringify(v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r3 = (v) => Math.round(v * 1000) / 1000;
const leaf = (id) => ({ id, brk: false });
const cut = (split, at, a, b, slant = 0) => ({ split, at, slant, a, b });
const isSplit = (n) => !!n && (n.split === "row" || n.split === "col");

// ---------------------------------------------------------------- 純函式
/** 是不是排版工作台的格式（不是就是舊的 rows） */
export function isFree(custom) {
  return !!custom && typeof custom === "object" && (custom.v === 2 || (!!custom.tree && typeof custom.tree === "object"));
}

/** 新開的自訂版面：上面兩格、下面一格（跟以前的預設一樣） */
export function blank() {
  return { v: 2, tree: cut("row", 0.6, cut("col", 0.5, leaf("p2"), leaf("p1")), leaf("p3")), insets: [] };
}

/** 舊的 rows（列／格，權重是比例）→ 樹。閱讀順序跟以前一樣（上面先、同一列右邊先），已經寫好的格子內容不用搬 */
export function rowsToTree(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r?.cells) && r.cells.length);
  if (!list.length) return blank();
  let no = 0;
  const ids = list.map((r) => { const k = r.cells.length, first = no; no += k; return r.cells.map((_, i) => `p${first + k - i}`); });
  const w = (v) => (+v > 0 ? +v : 1);
  const row = (cells, rid) => {
    if (cells.length === 1) return leaf(rid[0]);
    const total = cells.reduce((a, v) => a + w(v), 0);
    return cut("col", r3(clamp(w(cells[0]) / total, AT_MIN, AT_MAX)), leaf(rid[0]), row(cells.slice(1), rid.slice(1)));
  };
  const stack = (rs, rid) => {
    if (rs.length === 1) return row(rs[0].cells, rid[0]);
    const total = rs.reduce((a, r) => a + w(r.h), 0);
    return cut("row", r3(clamp(w(rs[0].h) / total, AT_MIN, AT_MAX)), row(rs[0].cells, rid[0]), stack(rs.slice(1), rid.slice(1)));
  };
  return { v: 2, tree: stack(list, ids), insets: [] };
}

/** 預設版型 → 樹（形狀照漫畫台的版型縮圖；格子編號照閱讀順序 p1、p2…，所以格子內容照順序就對得上） */
export function presetCustom(id) {
  const L = leaf;
  const t = {
    L3: cut("col", 0.5, cut("row", 0.5, L("p2"), L("p3")), L("p1")),
    L4: cut("row", 0.3, cut("col", 0.5, L("p2"), L("p1")), L("p3")),
    L4w: cut("row", 0.25, L("p1"), cut("row", 0.4, cut("col", 0.5, L("p3"), L("p2")), L("p4"))),
    L5: cut("row", 0.3, L("p1"), cut("row", 0.5, cut("col", 0.5, L("p3"), L("p2")), cut("col", 0.5, L("p5"), L("p4")))),
    L6: cut("row", 0.333, cut("col", 0.5, L("p2"), L("p1")), cut("row", 0.5, cut("col", 0.5, L("p4"), L("p3")), cut("col", 0.5, L("p6"), L("p5")))),
    K4: cut("row", 0.25, L("p1"), cut("row", 0.333, L("p2"), cut("row", 0.5, L("p3"), L("p4")))),
    ONE: L("p1"),
  }[id];
  if (!t) return null;
  const insets = id === "L4" ? [{ id: "p4", x0: 0.6, y0: 0.68, x1: 0.97, y1: 0.97, brk: false }] : [];
  return { v: 2, tree: t, insets };
}

const cross = (a, b) => a[0] * b[1] - a[1] * b[0];

/** 凸多邊形沿直線 p→q 切成兩半：[算式上 cross<0 那半, 另一半] */
function clipPoly(poly, p, q) {
  const side = (v) => (q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0]);
  const neg = [], pos = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], sa = side(a), sb = side(b);
    if (sa <= 0) neg.push(a);
    if (sa >= 0) pos.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb), x = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      neg.push(x);
      pos.push(x);
    }
  }
  return [neg, pos];
}

/** 直線 p→q 落在凸多邊形裡的那一段（畫格線、拖格線用） */
function segIn(poly, p, q) {
  const d = [q[0] - p[0], q[1] - p[1]], ts = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], e = [b[0] - a[0], b[1] - a[1]], den = cross(d, e);
    if (Math.abs(den) < 1e-12) continue;
    const ap = [a[0] - p[0], a[1] - p[1]], t = cross(ap, e) / den, u = cross(ap, d) / den;
    if (u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
  }
  if (ts.length < 2) return [p, q];
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  return [[p[0] + d[0] * t0, p[1] + d[1] * t0], [p[0] + d[0] * t1, p[1] + d[1] * t1]];
}

/** 一刀在畫面上的線：row 從左到右、col 從上到下（座標 0～1，斜度照那一塊的方框算） */
function cutLine(n, r) {
  const [x0, y0, x1, y1] = r, s = n.slant || 0;
  if (n.split === "row") return [[x0, y0 + (y1 - y0) * (n.at - s)], [x1, y0 + (y1 - y0) * (n.at + s)]];
  return [[x0 + (x1 - x0) * (n.at - s), y0], [x0 + (x1 - x0) * (n.at + s), y1]];
}

/** 點在不在多邊形裡 */
export function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 版面 → 每一格（閱讀順序）＋每一刀。格：{id, rect, poly, brk, inset}；刀：{path, split, at, slant, rect, seg} */
export function geometry(custom) {
  const c = isFree(custom) ? custom : blank();
  const cells = [], cuts = [];
  const walk = (n, rect, poly, path) => {
    if (isSplit(n)) {
      const [x0, y0, x1, y1] = rect, at = clamp(Number.isFinite(+n.at) ? +n.at : 0.5, AT_MIN, AT_MAX);
      const slant = clamp(+n.slant || 0, -SLANT_MAX, SLANT_MAX);
      const line = cutLine({ split: n.split, at, slant }, rect);
      cuts.push({ path, split: n.split, at, slant, rect, seg: segIn(poly, line[0], line[1]) });
      const [neg, pos] = clipPoly(poly, line[0], line[1]);
      if (n.split === "row") {   // 線左→右：cross<0 那半在上面
        const y = y0 + (y1 - y0) * at;
        walk(n.a, [x0, y0, x1, y], neg, [...path, "a"]);
        walk(n.b, [x0, y, x1, y1], pos, [...path, "b"]);
      } else {                   // 線上→下：cross<0 那半在右邊，右邊先讀
        const x = x0 + (x1 - x0) * at;
        walk(n.b, [x, y0, x1, y1], neg, [...path, "b"]);
        walk(n.a, [x0, y0, x, y1], pos, [...path, "a"]);
      }
      return;
    }
    cells.push({ id: String(n?.id ?? ""), rect, poly, brk: !!n?.brk, inset: false, path });
  };
  walk(c.tree, [0, 0, 1, 1], [[0, 0], [1, 0], [1, 1], [0, 1]], []);
  for (const s of (Array.isArray(c.insets) ? c.insets : []).slice(0, MAX_INSETS)) {
    const r = [Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.max(s.x0, s.x1), Math.max(s.y0, s.y1)];
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    // 跟後端一樣看方框（斜切的格子也是），閱讀順序才會一致
    const host = cells.findIndex((k) => !k.inset && cx >= k.rect[0] && cx <= k.rect[2] && cy >= k.rect[1] && cy <= k.rect[3]);
    let at = host < 0 ? cells.length : host + 1;
    while (at < cells.length && cells[at].inset) at++;
    cells.splice(at, 0, { id: String(s.id), rect: r, poly: [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], brk: !!s.brk, inset: true, path: null });
  }
  return { cells, cuts };
}

export const readingIds = (custom) => geometry(custom).cells.map((c) => c.id);
export const count = (custom) => geometry(custom).cells.length;

/** 下一個沒用過的格子 id */
export function nextId(custom) {
  const used = readingIds(custom).map((id) => +(/^p(\d+)$/.exec(id)?.[1] || 0));
  return `p${Math.max(0, ...used) + 1}`;
}

function nodeAt(tree, path) {
  let n = tree;
  for (const k of path) n = n?.[k];
  return n;
}
function setAt(custom, path, node) {
  if (!path.length) { custom.tree = node; return; }
  nodeAt(custom.tree, path.slice(0, -1))[path[path.length - 1]] = node;
}
function leafPath(tree, id, path = []) {
  if (isSplit(tree)) return leafPath(tree.a, id, [...path, "a"]) || leafPath(tree.b, id, [...path, "b"]);
  return String(tree?.id ?? "") === id ? path : null;
}

/** 刀的位置吸到 1/3、1/2、2/3（差 2.5% 以內），而且夾在 0.15～0.85 */
export function snapAt(v) {
  const s = SNAPS.find((k) => Math.abs(k - v) <= 0.025);
  return r3(clamp(s ?? v, AT_MIN, AT_MAX));
}
const slantOf = (s) => (Math.abs(s) < 0.01 ? 0 : r3(clamp(s, -SLANT_MAX, SLANT_MAX)));

/** 把一格切成兩格：row＝橫切（原本的留上面）、col＝直切（原本的留右邊＝先讀的那邊）。格數滿了或找不到那格回 null */
export function splitCell(custom, id, split, at, slant = 0) {
  if (count(custom) >= MAX_PANELS) return null;
  const c = clone(custom), path = leafPath(c.tree, id);
  if (!path) return null;
  const old = nodeAt(c.tree, path), add = leaf(nextId(custom)), a = r3(clamp(at, AT_MIN, AT_MAX)), s = slantOf(slant);
  setAt(c, path, split === "row" ? cut("row", a, old, add, s) : cut("col", a, add, old, s));
  return c;
}

/** 拿掉一格：疊的小格直接刪；一般格把空間讓給同一刀另一邊。整頁只剩一格時回 null */
export function removeCell(custom, id) {
  const c = clone(custom);
  const k = (c.insets || []).findIndex((s) => String(s.id) === id);
  if (k >= 0) { c.insets.splice(k, 1); return c; }
  const path = leafPath(c.tree, id);
  if (!path || !path.length) return null;
  const sib = nodeAt(c.tree, [...path.slice(0, -1), path[path.length - 1] === "a" ? "b" : "a"]);
  setAt(c, path.slice(0, -1), sib);
  return c;
}

/** 改一刀的位置或斜度 */
export function setCut(custom, path, { at, slant } = {}) {
  const c = clone(custom), n = nodeAt(c.tree, path);
  if (!isSplit(n)) return c;
  if (at !== undefined) n.at = r3(clamp(at, AT_MIN, AT_MAX));
  if (slant !== undefined) n.slant = slantOf(slant);
  return c;
}

/** 一格旁邊那一刀的路徑（斜切按鈕改它）；整頁只有一格就 null */
export function parentCut(custom, id) {
  const p = leafPath(custom.tree, id);
  return p && p.length ? p.slice(0, -1) : null;
}

/** 斜切輪流：不斜 → ／ → ＼ → 不斜 */
export const nextSlant = (s) => (Math.abs(s) < 0.01 ? 0.08 : s > 0 ? -0.08 : 0);

/** 人物破格開關 */
export function toggleBrk(custom, id) {
  const c = clone(custom);
  const s = (c.insets || []).find((x) => String(x.id) === id);
  if (s) s.brk = !s.brk;
  else { const p = leafPath(c.tree, id); if (p) { const n = nodeAt(c.tree, p); n.brk = !n.brk; } }
  return c;
}

/** 小格的框：0～1、至少 10%×8%、最多 70% */
export function insetBox([a, b, c, d]) {
  const fit = (lo, hi, min, max) => {
    lo = clamp(lo, 0, 1);
    const w = clamp(hi - lo, min, max);
    if (lo + w > 1) lo = 1 - w;
    return [r3(lo), r3(lo + w)];
  };
  const [x0, x1] = fit(Math.min(a, c), Math.max(a, c), 0.1, 0.7);
  const [y0, y1] = fit(Math.min(b, d), Math.max(b, d), 0.08, 0.7);
  return { x0, y0, x1, y1 };
}

/** 疊一個小格（rect＝[x0,y0,x1,y1]）；滿了回 null */
export function addInset(custom, rect) {
  if (count(custom) >= MAX_PANELS || (custom.insets || []).length >= MAX_INSETS) return null;
  const c = clone(custom);
  c.insets = Array.isArray(c.insets) ? c.insets : [];
  c.insets.push({ id: nextId(custom), ...insetBox(rect), brk: false });
  return c;
}

export function moveInset(custom, id, rect) {
  const c = clone(custom), s = (c.insets || []).find((x) => String(x.id) === id);
  if (s) Object.assign(s, insetBox(rect));
  return c;
}

/** 格子內容跟著 id 走：舊的閱讀順序 → 新的；新格補空白，舊陣列多出來的（換過版型藏起來的）接在後面 */
export function remap(oldIds, newIds, panels, blankPanel) {
  const list = Array.isArray(panels) ? panels : [];
  const by = new Map(oldIds.map((id, i) => [id, list[i]]));
  return [...newIds.map((id) => by.get(id) || blankPanel()), ...list.slice(oldIds.length)];
}

/** 拖一條線切格子：偏水平＝橫切、偏垂直＝直切；斜超過 8 度＝斜切。r＝那一格的方框，p0→p1＝拖的線。
 *  long＝線夠不夠長（至少橫跨那格的 30%），太短當成點一下 */
export function knife(r, p0, p1) {
  const [x0, y0, x1, y1] = r, w = x1 - x0, h = y1 - y0;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  // 頁面是直的 2:3，角度照畫面上看到的算
  const deg = Math.atan2(Math.abs(dy) * 1.5, Math.abs(dx)) * 180 / Math.PI;
  if (deg <= 45) {
    const m = dy / dx, yl = p0[1] + m * (x0 - p0[0]), yr = p0[1] + m * (x1 - p0[0]);
    return { split: "row", at: ((yl + yr) / 2 - y0) / h, slant: deg < 8 ? 0 : slantOf((yr - yl) / 2 / h), long: Math.abs(dx) >= w * 0.3 };
  }
  const m = dx / dy, xt = p0[0] + m * (y0 - p0[1]), xb = p0[0] + m * (y1 - p0[1]);
  return { split: "col", at: ((xt + xb) / 2 - x0) / w, slant: 90 - deg < 8 ? 0 : slantOf((xb - xt) / 2 / w), long: Math.abs(dy) >= h * 0.3 };
}

// ---------------------------------------------------------------- 畫
const VW = 1000, VH = 1500;   // 頁面是直的 2:3（832×1248）
const SVGNS = "http://www.w3.org/2000/svg";
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]);
const pts = (poly) => poly.map(([x, y]) => `${(x * VW).toFixed(1)},${(y * VH).toFixed(1)}`).join(" ");
const center = (poly) => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];

/** 凸多邊形每一邊往內縮 k（畫面單位），當格子之間的白縫 */
export function insetPoly(poly, k) {
  let P = poly.map(([x, y]) => [x * VW, y * VH]);
  P = P.filter((p, i) => { const q = P[(i + P.length - 1) % P.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5; });
  if (P.length < 3 || !k) return poly;
  let area = 0;
  P.forEach((a, i) => { area += cross(a, P[(i + 1) % P.length]); });
  const sg = area > 0 ? 1 : -1;
  const lines = P.map((a, i) => {
    const b = P[(i + 1) % P.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]), d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    return { p: [a[0] - d[1] * sg * k, a[1] + d[0] * sg * k], d };
  });
  return lines.map((L, i) => {
    const M = lines[(i + lines.length - 1) % lines.length], den = cross(M.d, L.d);
    if (Math.abs(den) < 1e-6) return [L.p[0] / VW, L.p[1] / VH];
    const t = cross([L.p[0] - M.p[0], L.p[1] - M.p[1]], L.d) / den;
    return [(M.p[0] + M.d[0] * t) / VW, (M.p[1] + M.d[1] * t) / VH];
  });
}

/** 畫一頁版面到 svg（左欄小示意圖和工作台共用）。sel＝選起來的格 id；edit＝畫可以拖的格線和小格把手 */
export function draw(svg, custom, { sel = null, edit = false } = {}) {
  const g = geometry(custom);
  svg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
  const out = [`<rect class="cl-page" x="0" y="0" width="${VW}" height="${VH}"/>`];
  // 疊的小格最後畫（蓋在別格上面），編號照閱讀順序
  const order = g.cells.map((c, i) => [c, i]).sort((a, b) => a[0].inset - b[0].inset);
  order.forEach(([c, i]) => {
    const id = esc(c.id), [cx, cy] = c.inset ? [(c.rect[0] + c.rect[2]) / 2, (c.rect[1] + c.rect[3]) / 2] : center(c.poly);
    if (c.inset) out.push(`<polygon class="cl-halo" points="${pts(insetPoly(c.poly, -14))}"/>`);   // 疊的小格外面一圈白邊
    out.push(`<polygon class="cl-cell${c.inset ? " inset" : ""}${c.id === sel ? " sel" : ""}${c.brk ? " brk" : ""}" data-id="${id}" points="${pts(insetPoly(c.poly, c.inset ? 0 : 10))}"/>`);
    out.push(`<text class="cl-no" x="${(cx * VW).toFixed(1)}" y="${(cy * VH).toFixed(1)}">${i + 1}</text>`);
    if (c.brk) out.push(`<text class="cl-brk" x="${(c.rect[2] * VW - 44).toFixed(1)}" y="${(c.rect[1] * VH + 60).toFixed(1)}">破</text>`);
  });
  if (edit) {
    g.cuts.forEach((k, i) => {
      const [[ax, ay], [bx, by]] = k.seg;
      out.push(`<line class="cl-gut ${k.split}" data-cut="${i}" x1="${(ax * VW).toFixed(1)}" y1="${(ay * VH).toFixed(1)}" x2="${(bx * VW).toFixed(1)}" y2="${(by * VH).toFixed(1)}"/>`);
    });
    g.cells.filter((c) => c.inset).forEach((c) => {
      out.push(`<rect class="cl-ih" data-id="${esc(c.id)}" x="${(c.rect[2] * VW - 30).toFixed(1)}" y="${(c.rect[3] * VH - 30).toFixed(1)}" width="40" height="40" rx="6"/>`);
    });
  }
  svg.innerHTML = out.join("");
  return g;
}

// ---------------------------------------------------------------- 工作台視窗
/**
 * 打開排版工作台。host（comic.js 給的）：
 *   get()                 → 目前的 {custom, panels}
 *   commit(custom, how)   套上新的版面（how.byOrder＝格子內容照順序、不照 id：換預設版型、AI 排的用）
 *   restore(snapshot)     復原／重做：整份 {custom, panels} 放回去
 *   names()               每一格的中文名（後端算的，跟組提示詞同一份；可能慢一拍，拿到新的再叫 refresh()）
 *   ai(ask, brain)        用說的排 → 新的 custom（失敗丟錯）
 *   locked()              true＝畫圖中，不能改
 *   layouts               預設版型 [{id, name}]
 *   onClose()             關掉時
 * 回傳 {close, refresh}
 */
export function openWorkbench(host) {
  document.querySelector(".cl-modal")?.remove();
  let sel = null, drag = null, geo = null, insetMode = false;
  const undo = [], redo = [];
  const snap = () => clone(host.get());
  const pushUndo = (s) => { undo.push(s); if (undo.length > 60) undo.shift(); redo.length = 0; };
  const before = () => pushUndo(snap());
  const cur = () => host.get().custom;

  const svg = document.createElementNS(SVGNS, "svg");
  svg.classList.add("cl-canvas");
  svg.setAttribute("role", "application");
  svg.setAttribute("aria-label", "排版畫布：在格子上拖一條線切開，拖格線改大小，按住 Shift 拖框疊小格");
  svg.setAttribute("tabindex", "0");
  const knifeLine = document.createElementNS(SVGNS, "line");
  knifeLine.classList.add("cl-knife");
  const ghost = document.createElementNS(SVGNS, "rect");
  ghost.classList.add("cl-ghost");
  const tip = el("div", { class: "cl-tip", hidden: true });
  const tools = el("div", { class: "cl-tools", hidden: true });
  const stage = el("div", { class: "lay-stage cl-stage" }, svg, tools, tip);
  const list = el("div", { class: "cl-list" });
  const countEl = el("span", { class: "vfd sm cl-count" });
  const undoBtn = el("button", { type: "button", class: "akey sm", title: "復原（Ctrl＋Z）", onclick: () => doUndo() }, "↶ 復原");
  const redoBtn = el("button", { type: "button", class: "akey sm", title: "重做（Ctrl＋Y）", onclick: () => doRedo() }, "↷ 重做");
  // 疊小格：按下去之後在頁面上拖一個框（按住 Shift 拖也一樣）
  const insetBtn = el("button", { type: "button", class: "akey sm", "aria-pressed": "false", title: "按下去，再到頁面上拖一個框＝疊一個小格（按住 Shift 拖也可以）",
    onclick: () => setInsetMode(!insetMode) }, "＋疊小格");
  const setInsetMode = (on) => {
    insetMode = on;
    insetBtn.classList.toggle("on", on);
    insetBtn.setAttribute("aria-pressed", String(on));
    svg.classList.toggle("adding", on);
  };
  const presets = el("div", { class: "cl-presets" },
    ...[...host.layouts.filter((l) => presetCustom(l.id)), { id: "ONE", name: "一整格，自己從頭切" }].map((l) => {
      const mini = document.createElementNS(SVGNS, "svg");
      mini.setAttribute("aria-hidden", "true");
      draw(mini, presetCustom(l.id));
      return el("button", { type: "button", class: "cl-preset", title: `從「${l.name}」開始改`, "aria-label": `從「${l.name}」開始改`, onclick: () => usePreset(l.id) }, mini);
    }));
  const aiRow = aiBox(host, (custom) => { before(); host.commit(custom, { byOrder: true }); sel = null; render(); });
  const win = el("div", { class: "modal cl-modal", role: "dialog", "aria-modal": "true", "aria-label": "排版工作台" },
    el("div", { class: "lay-win cl-win" },
      el("div", { class: "row wrap lay-head" },
        el("b", {}, "排版工作台"), countEl,
        el("span", { class: "muted sm grow" }, "在格子上拖一條線＝切開（斜著拖＝斜切）・拖格線＝改大小・按「＋疊小格」或按住 Shift 拖框＝疊小格・點一格＝合併、斜切、破格"),
        insetBtn, undoBtn, redoBtn,
        el("button", { type: "button", class: "akey sm go", onclick: () => close() }, "完成")),
      el("div", { class: "lay-body cl-body" },
        stage,
        el("div", { class: "lay-side cl-side" },
          el("span", { class: "sub" }, "從版型開始"), presets,
          el("span", { class: "sub" }, "用說的排（AI 幫你拉格子）"), aiRow,
          el("span", { class: "sub" }, "格子（閱讀順序：上面先、右邊先）"), list))));
  // 點背景關掉（按下和放開都在背景上才算，拖格線拖出去不會誤關）
  let downOnBack = false;
  win.addEventListener("pointerdown", (e) => { downOnBack = e.target === win; });
  win.addEventListener("click", (e) => { if (e.target === win && downOnBack) close(); });
  document.body.append(win);
  svg.focus({ preventScroll: true });

  function close() {
    if (!win.isConnected) return;
    ro.disconnect();
    document.removeEventListener("keydown", onKey, true);
    win.remove();
    host.onClose?.();
  }

  // ---- 畫
  function render(live) {
    geo = draw(svg, live || cur(), { sel, edit: true });
    svg.append(knifeLine, ghost);
    countEl.textContent = `${geo.cells.length}／${MAX_PANELS} 格`;
    insetBtn.disabled = host.locked() || geo.cells.length >= MAX_PANELS || geo.cells.filter((c) => c.inset).length >= MAX_INSETS;
    if (insetBtn.disabled && insetMode) setInsetMode(false);
    undoBtn.disabled = !undo.length;
    redoBtn.disabled = !redo.length;
    svg.classList.toggle("off", host.locked());
    if (live) return;
    const names = host.names(), panels = host.get().panels || [];
    list.replaceChildren(...geo.cells.map((c, i) => el("button", { type: "button", class: `cl-item${c.id === sel ? " on" : ""}`, onclick: () => select(c.id) },
      el("span", { class: "vfd sm" }, String(i + 1).padStart(2, "0")),
      el("span", { class: "cl-item-name" }, names[i] || (c.inset ? "疊的小格" : "一格"), c.brk ? el("span", { class: "cl-badge" }, "破格") : null),
      el("span", { class: "muted sm cl-item-what" }, (panels[i]?.what || "").trim() || "（還沒寫內容）"))));
    renderTools();
  }

  function select(id) {
    sel = id;
    render();
  }

  // 頁面座標（0～1）↔ 螢幕座標：照 svg 實際的縮放算，視窗大小怎麼變都準
  const toPage = (x, y) => {
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(x, y).matrixTransform(m.inverse());
    return [clamp(p.x / VW, 0, 1), clamp(p.y / VH, 0, 1)];
  };
  const toScreen = (x, y) => {
    const m = svg.getScreenCTM();
    return m ? new DOMPoint(x * VW, y * VH).matrixTransform(m) : new DOMPoint(0, 0);
  };

  // 選起來那格右上角的小工具列
  function renderTools() {
    const c = geo.cells.find((k) => k.id === sel);
    tools.hidden = !c;
    if (!c) return;
    const off = host.locked();
    const pc = c.inset ? null : parentCut(cur(), c.id);
    const k = pc && geo.cuts.find((x) => x.path.join() === pc.join());
    const btn = (label, title, fn, on) => el("button", { type: "button", class: `akey sm${on ? " on" : ""}`, title, disabled: off, onclick: fn }, label);
    tools.replaceChildren(...[
      btn(c.inset ? "刪掉小格" : "併到旁邊", c.inset ? "拿掉這個疊上去的小格（Delete）" : "拿掉這格，空間讓給同一刀另一邊（Delete）", () => remove(c.id)),
      k && btn(Math.abs(k.slant) > 0.01 ? (k.slant > 0 ? "斜切 ／" : "斜切 ＼") : "斜切", "旁邊那一刀改成斜的（再按一下換方向，第三下回到直的）", () => slant(pc), Math.abs(k.slant) > 0.01),
      btn("破格", "人物衝出格框（適合高潮那格）", () => { before(); host.commit(toggleBrk(cur(), c.id)); render(); }, c.brk),
    ].filter(Boolean));
    // 靠那格的右上角，寬過那格就往右推，不跑出畫面
    const s = stage.getBoundingClientRect(), p = toScreen(c.rect[2], c.rect[1]);
    tools.style.left = `${Math.max(4, p.x - s.left - 6 - tools.offsetWidth)}px`;
    tools.style.top = `${Math.max(4, p.y - s.top + 6)}px`;
  }

  function remove(id) {
    if (host.locked()) return;
    const next = removeCell(cur(), id);
    if (!next) return toast("整頁只剩這一格了", "err");
    before();
    host.commit(next);
    sel = null;
    render();
  }
  function slant(path) {
    if (host.locked()) return;
    const k = geo.cuts.find((x) => x.path.join() === path.join());
    before();
    host.commit(setCut(cur(), path, { slant: nextSlant(k?.slant || 0) }));
    render();
  }
  function usePreset(id) {
    if (host.locked()) return;
    before();
    host.commit(presetCustom(id), { byOrder: true });
    sel = null;
    render();
  }
  function doUndo() {
    if (!undo.length || host.locked()) return;
    redo.push(snap());
    host.restore(undo.pop());
    sel = null;
    render();
  }
  function doRedo() {
    if (!redo.length || host.locked()) return;
    undo.push(snap());
    host.restore(redo.pop());
    sel = null;
    render();
  }

  // ---- 滑鼠：切、拉格線、疊小格、搬小格
  const pt = (e) => toPage(e.clientX, e.clientY);
  const cellAt = ([x, y]) => [...geo.cells].reverse().find((c) => inPoly(c.poly, x, y));
  const showTip = (e, text) => {
    tip.hidden = !text;
    if (!text) return;
    const s = stage.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = `${e.clientX - s.left + 14}px`;
    tip.style.top = `${e.clientY - s.top + 14}px`;
  };
  const far = (a, b) => Math.hypot((a[0] - b[0]) * VW, (a[1] - b[1]) * VH) > 24;

  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (host.locked()) return toast("畫圖中，畫完才能改版面", "err");
    e.preventDefault();
    svg.focus({ preventScroll: true });
    try { svg.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真的指標 */ }
    const p = pt(e), t = e.target, start = snap();
    if (t.classList?.contains("cl-gut")) { drag = { mode: "gut", k: geo.cuts[+t.dataset.cut], p, start }; return; }
    if (t.classList?.contains("cl-ih")) {
      const c = geo.cells.find((x) => x.id === t.dataset.id);
      if (c) drag = { mode: "resize", id: c.id, r0: [...c.rect], p, start };
      return;
    }
    const c = cellAt(p), adding = e.shiftKey || insetMode;
    if (!c) return;
    if (c.inset && !adding) { drag = { mode: "move", id: c.id, r0: [...c.rect], p, start }; return; }
    drag = { mode: adding ? "inset" : "knife", c, p, q: p, start };
  });

  svg.addEventListener("pointermove", (e) => {
    const p = pt(e);
    if (!drag) {
      const t = e.target.classList;
      showTip(e, t?.contains("cl-gut") ? "拖動改大小" : t?.contains("cl-ih") ? "拖動改小格大小" : "");
      return;
    }
    drag.moved ||= far(p, drag.p);
    drag.q = p;
    if (drag.mode === "gut") {
      const { k } = drag, [x0, y0, x1, y1] = k.rect;
      drag.at = snapAt(k.split === "row" ? (p[1] - y0) / (y1 - y0) : (p[0] - x0) / (x1 - x0));
      render(setCut(cur(), k.path, { at: drag.at }));
      showTip(e, `${Math.round(drag.at * 100)}%`);
    } else if (drag.mode === "knife") {
      if (!drag.moved) return;
      [["x1", drag.p[0] * VW], ["y1", drag.p[1] * VH], ["x2", p[0] * VW], ["y2", p[1] * VH]].forEach(([a, v]) => knifeLine.setAttribute(a, v));
      knifeLine.classList.add("on");
      const kf = knife(drag.c.rect, drag.p, p);
      showTip(e, kf.long ? `放開＝${kf.split === "row" ? "橫切" : "直切"}${kf.slant ? "（斜）" : ""}` : "再拖長一點");
    } else if (drag.mode === "inset") {
      const [a, b] = drag.p;
      [["x", Math.min(a, p[0]) * VW], ["y", Math.min(b, p[1]) * VH], ["width", Math.abs(p[0] - a) * VW], ["height", Math.abs(p[1] - b) * VH]]
        .forEach(([k, v]) => ghost.setAttribute(k, v));
      ghost.classList.toggle("on", !!drag.moved);
      showTip(e, drag.moved ? "放開＝疊一個小格" : "");
    } else {
      const dx = p[0] - drag.p[0], dy = p[1] - drag.p[1], [x0, y0, x1, y1] = drag.r0;
      if (drag.mode === "move") {   // 整塊搬：大小不變、不出頁面
        const w = x1 - x0, h = y1 - y0, nx = clamp(x0 + dx, 0, 1 - w), ny = clamp(y0 + dy, 0, 1 - h);
        drag.rect = [nx, ny, nx + w, ny + h];
      } else drag.rect = [x0, y0, x1 + dx, y1 + dy];
      if (drag.moved) render(moveInset(cur(), drag.id, drag.rect));
    }
  });

  const finish = (e, cancel) => {
    const d = drag;
    drag = null;
    knifeLine.classList.remove("on");
    ghost.classList.remove("on");
    showTip(e, "");
    if (!d) return;
    if (cancel) return render();
    const keep = (next) => { pushUndo(d.start); host.commit(next); };
    if (d.mode === "gut") {
      if (d.at !== undefined && d.at !== d.k.at) keep(setCut(cur(), d.k.path, { at: d.at }));
      return render();
    }
    if (d.mode === "move" || d.mode === "resize") {
      if (!d.moved) return select(d.id);
      keep(moveInset(cur(), d.id, d.rect));
      return render();
    }
    if (!d.moved) return select(d.c.id);   // 點一下＝選起來
    if (d.mode === "inset") {
      setInsetMode(false);
      const id = nextId(cur()), next = addInset(cur(), [d.p[0], d.p[1], d.q[0], d.q[1]]);
      if (!next) { toast((cur().insets || []).length >= MAX_INSETS ? `最多疊 ${MAX_INSETS} 個小格` : `一頁最多 ${MAX_PANELS} 格（疊的小格也算）`, "err"); return render(); }
      keep(next);
      return select(id);
    }
    const kf = knife(d.c.rect, d.p, d.q);
    if (!kf.long) return select(d.c.id);
    const next = splitCell(cur(), d.c.id, kf.split, kf.at, kf.slant);
    if (!next) { toast(`一頁最多 ${MAX_PANELS} 格（疊的小格也算）`, "err"); return render(); }
    keep(next);
    sel = null;
    render();
  };
  svg.addEventListener("pointerup", (e) => finish(e));
  svg.addEventListener("pointercancel", (e) => finish(e, true));
  svg.addEventListener("pointerleave", (e) => { if (!drag) showTip(e, ""); });

  function onKey(e) {
    if (!win.isConnected || win.hidden) return;
    const typing = e.target.closest?.("input, textarea, select");
    const mod = e.ctrlKey || e.metaKey, key = (e.key || "").toLowerCase();
    const eat = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && key === "z" && !typing) { eat(); (e.shiftKey ? doRedo : doUndo)(); }
    else if (mod && key === "y" && !typing) { eat(); doRedo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && sel && !typing) { eat(); remove(sel); }
    else if (e.key === "Escape") {
      eat();
      if (drag) { drag = null; knifeLine.classList.remove("on"); ghost.classList.remove("on"); render(); }
      else if (insetMode) setInsetMode(false);
      else if (sel) select(null);
      else close();
    }
  }
  document.addEventListener("keydown", onKey, true);
  const ro = new ResizeObserver(() => { if (win.isConnected && !drag && geo) renderTools(); });
  ro.observe(stage);
  render();
  return { close, refresh: () => { if (win.isConnected && !drag) render(); } };
}

/** 「用說的排」一行：輸入框＋用哪顆＋排。onDone(custom) 套上 */
export function aiBox(host, onDone) {
  const ask = el("input", { type: "text", class: "grow", maxlength: 300, "aria-label": "用說的排版",
    placeholder: "例：左邊一格大特寫貫穿整頁，右邊切三格，右下疊一個小格（空白＝照劇情排）" });
  const brain = el("select", { class: "cl-brain", "aria-label": "用哪顆語言模型", title: "35B 排得準（第一次要載入約 1 分鐘，之後幾秒）；9B 省記憶體但常排錯" },
    el("option", { value: "35b" }, "35B"), el("option", { value: "9b" }, "9B"));
  const go = el("button", { type: "button", class: "akey sm go", onclick: () => run() }, "排");
  ask.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); run(); } });
  async function run() {
    if (go.disabled) return;
    if (host.locked()) return toast("畫圖中，畫完才能改版面", "err");
    go.disabled = true;
    const was = go.textContent;
    go.textContent = "排版中…";
    try {
      onDone(await host.ai(ask.value.trim(), brain.value));
      toast("排好了（不喜歡可以按復原）", "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      go.disabled = false;
      go.textContent = was;
    }
  }
  return el("div", { class: "row gap cl-ai" }, ask, brain, go);
}
