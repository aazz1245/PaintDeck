// 自由版面（2026-10-26 使用者：「整個PAINTDECK的所有版面都可以自由收起／打開、自由分配位置與拉伸調整視窗大小」；
// 試拉停靠區後改要：「貼邊隱藏/吸附，自動會貼著看圖區的四周邊緣。，自由拖拽，縮放大小，然後把那個看圖區釘選/置頂」，
// 面板貼到看圖區旁邊時「自動縮小讓位」）。
// 每個版面有一塊固定的看圖區（主區），其他標了的區塊都是面板，標題列可以拖。面板有三種狀態：
//   吸附：放在看圖區四邊附近 → 貼在上／左／右／下停靠區（同一邊可疊好幾塊、可切成分頁、可收成直條），看圖區縮小讓位；縫可以拖來改大小
//   浮動：放在其他地方 → 浮在那裡，四邊四角都能拉大小，靠近別塊或容器邊緣會吸過去對齊
//   貼邊隱藏：放在容器最外緣 → 縮成一條細邊，滑鼠移過去滑出來、移開縮回去
// 看圖區右上角的圖釘：釘選時看圖區在浮動面板上面（蓋不到），拔掉時浮動面板在上面。
// 版面存在 localStorage（store 的 dock_<名稱>），有版本號；讀到看不懂的就用預設。右鍵選單、設定頁都能恢復預設。
// 上半是純函式（tests/dock_layout.test.cjs 測），下半是 DOM。
import { el, store, $$ } from "./util.js";

export const DOCK_V = 2;
export const ZONES = ["top", "left", "right", "bottom"];
const EDGES = ["top", "left", "right", "bottom"];
const RAIL = 28;          // 收起後剩的直條（橫條）寬
const GAP = 10;           // 區跟看圖區之間的縫（也是拖拉改尺寸的把手）
const MAIN_MIN_W = 420, MAIN_MIN_H = 320;   // 看圖區至少留這麼大
const MIN = { top: 100, left: 260, right: 100, bottom: 100 };
const MAX_RATIO = { top: 0.5, left: 0.5, right: 0.5, bottom: 0.5 };
const FLOAT_MIN_W = 200, FLOAT_MIN_H = 80;
const NARROW = 1180;      // 視窗比這窄：左右區當作收起（點開只算這次）
const HIDE_EDGE = 14;     // 放在容器最外緣這麼近 → 貼邊隱藏
const SNAP_EDGE = 56;     // 放在看圖區邊緣這麼近 → 吸附
const MAGNET = 10;        // 浮動面板離別塊的邊這麼近就對齊
const ZONE_NAME = { top: "上面", left: "左邊", right: "右邊", bottom: "下面" };

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const copy = (L) => JSON.parse(JSON.stringify(L));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 照每塊面板的預設區排好的版面 */
export function defaultLayout(spec) {
  const zones = {};
  for (const z of ZONES) {
    const ids = spec.panels.filter((p) => p.zone === z).map((p) => p.id);
    zones[z] = { ids, size: spec.sizes[z] ?? MIN[z] * 2, collapsed: false, tabs: false, active: ids[0] ?? null };
  }
  return { v: DOCK_V, zones, float: {}, hide: {}, folded: [], pinned: true };
}

/** 讀回來的存檔 → 一定能用的版面：版本不對或壞掉用預設；未知面板丟掉；同一塊出現好幾次只留第一個（區＞浮動＞隱藏）；少的補回預設區 */
export function normalizeLayout(saved, spec) {
  const D = defaultLayout(spec);
  if (!saved || typeof saved !== "object" || saved.v !== DOCK_V || !saved.zones || typeof saved.zones !== "object") return D;
  const known = new Set(spec.panels.map((p) => p.id)), seen = new Set();
  const take = (id) => known.has(id) && !seen.has(id) && !!seen.add(id);
  const zones = {};
  for (const z of ZONES) {
    const s = saved.zones[z] && typeof saved.zones[z] === "object" ? saved.zones[z] : {};
    zones[z] = { ids: (Array.isArray(s.ids) ? s.ids : []).filter(take), size: num(s.size, D.zones[z].size), collapsed: s.collapsed === true, tabs: s.tabs === true, active: null };
  }
  const float = {}, hide = {};
  for (const [id, r] of Object.entries(saved.float && typeof saved.float === "object" ? saved.float : {}))
    if (r && fin(r.x) && fin(r.y) && num(r.w, 0) && num(r.h, 0) && take(id)) float[id] = { x: r.x, y: r.y, w: r.w, h: r.h };
  for (const [id, h] of Object.entries(saved.hide && typeof saved.hide === "object" ? saved.hide : {}))
    if (h && EDGES.includes(h.edge) && fin(h.at) && num(h.w, 0) && num(h.h, 0) && take(id)) hide[id] = { edge: h.edge, at: clamp(h.at, 0, 1), w: h.w, h: h.h };
  for (const p of spec.panels) if (!seen.has(p.id)) zones[p.zone].ids.push(p.id);
  for (const z of ZONES) zones[z].active = zones[z].ids.includes(saved.zones[z]?.active) ? saved.zones[z].active : zones[z].ids[0] ?? null;
  const folded = (Array.isArray(saved.folded) ? saved.folded : []).filter((id) => known.has(id));
  return { v: DOCK_V, zones, float, hide, folded: [...new Set(folded)], pinned: saved.pinned !== false };
}

/** 面板在哪：{kind:"zone", zone}｜{kind:"float"}｜{kind:"hide", edge}｜null */
export function whereIs(layout, id) {
  const z = ZONES.find((k) => layout.zones[k].ids.includes(id));
  if (z) return { kind: "zone", zone: z };
  if (layout.float[id]) return { kind: "float" };
  if (layout.hide[id]) return { kind: "hide", edge: layout.hide[id].edge };
  return null;
}

/** 從原本的位置拿掉（回傳拷貝；拿不到就是 null） */
function lift(layout, id) {
  if (!whereIs(layout, id)) return null;
  const L = copy(layout);
  for (const z of ZONES) {
    const S = L.zones[z];
    if (!S.ids.includes(id)) continue;
    S.ids = S.ids.filter((x) => x !== id);
    if (S.active === id) S.active = S.ids[0] ?? null;
  }
  delete L.float[id];
  delete L.hide[id];
  return L;
}

/** 吸附到 zone 的第 index 個（index 是拿掉它之後的位置；超出範圍放最後）。回傳新的版面，不改原本的 */
export function movePanel(layout, id, zone, index) {
  const L = lift(layout, id);
  if (!L || !L.zones[zone]) return copy(layout);
  const dst = L.zones[zone];
  dst.ids.splice(clamp(Number.isInteger(index) ? index : dst.ids.length, 0, dst.ids.length), 0, id);
  dst.active = id;
  return L;
}

/** 浮起來：rect 是相對容器左上角的 {x, y, w, h}（px） */
export function floatPanel(layout, id, rect) {
  const L = lift(layout, id);
  if (!L) return copy(layout);
  L.float[id] = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
  return L;
}

/** 貼邊隱藏：edge 是容器的哪一邊，at 是沿著那一邊的位置（0～1），size 是滑出來時多大 */
export function hidePanel(layout, id, edge, at, size) {
  const L = lift(layout, id);
  if (!L || !EDGES.includes(edge)) return copy(layout);
  L.hide[id] = { edge, at: Math.round(clamp(at, 0, 1) * 1000) / 1000, w: Math.round(size.w), h: Math.round(size.h) };
  return L;
}

/** 拖縫改尺寸時的範圍：每區有最小值，最大是可用空間的一半 */
export function clampSize(zone, px, avail) {
  const max = Math.max(MIN[zone], Math.floor(avail * MAX_RATIO[zone]));
  return Math.round(Math.max(MIN[zone], Math.min(max, px)));
}

/** 實際要套用的像素：沒面板的區 0、收起的區剩直條；太大就按比例縮，看圖區至少留 MAIN_MIN_W×MAIN_MIN_H */
export function fitSizes(layout, viewW, viewH) {
  const out = {};
  for (const z of ZONES) {
    const s = layout.zones[z];
    out[z] = !s.ids.length ? 0 : s.collapsed ? RAIL : Math.max(MIN[z], s.size);
  }
  const open = (z) => layout.zones[z].ids.length && !layout.zones[z].collapsed;
  const squeeze = (pair, view, mainMin) => {
    const gaps = pair.filter((z) => out[z]).length * GAP;
    const flex = pair.filter(open);
    const fixed = pair.filter((z) => !open(z)).reduce((a, z) => a + out[z], 0);
    const room = Math.max(0, view - mainMin - gaps - fixed);
    const want = flex.reduce((a, z) => a + out[z], 0);
    if (want > room && want > 0) for (const z of flex) out[z] = Math.max(RAIL, Math.floor(out[z] * room / want));
    for (const z of flex) out[z] = Math.min(out[z], Math.max(MIN[z], Math.floor(view * MAX_RATIO[z])));
  };
  squeeze(["left", "right"], viewW, MAIN_MIN_W);
  squeeze(["top", "bottom"], viewH, MAIN_MIN_H);
  return out;
}

/** 浮動面板一定整塊在容器裡，也不會小到抓不到 */
export function clampFloat(r, W, H) {
  const w = clamp(r.w, Math.min(FLOAT_MIN_W, W), W), h = clamp(r.h, Math.min(FLOAT_MIN_H, H), H);
  return { x: clamp(r.x, 0, W - w), y: clamp(r.y, 0, H - h), w, h };
}

/** 磁吸：四個邊離別塊面板的邊或容器邊緣 MAGNET 以內就對齊過去（只移動，不改大小） */
export function snapRect(r, others, W, H) {
  const pick = (a, size, lines) => {
    let best = null;
    for (const t of lines) for (const [edge, off] of [[a, 0], [a + size, size]]) {
      const d = Math.abs(edge - t);
      if (d <= MAGNET && (!best || d < best.d)) best = { d, v: t - off };
    }
    return best ? best.v : a;
  };
  const xs = [0, W, ...others.flatMap((o) => [o.x, o.x + o.w])];
  const ys = [0, H, ...others.flatMap((o) => [o.y, o.y + o.h])];
  return { x: pick(r.x, r.w, xs), y: pick(r.y, r.h, ys), w: r.w, h: r.h };
}

/** 看圖區釘選時浮動面板蓋不到它：疊到看圖區（m）上就推到旁邊最近、放得下的地方；四邊都放不下就不動 */
export function avoidRect(r, m, W, H) {
  const hit = r.x < m.x + m.w && r.x + r.w > m.x && r.y < m.y + m.h && r.y + r.h > m.y;
  if (!hit) return r;
  const opts = [{ ...r, x: m.x - r.w }, { ...r, x: m.x + m.w }, { ...r, y: m.y - r.h }, { ...r, y: m.y + m.h }]
    .filter((o) => o.x >= 0 && o.y >= 0 && o.x + o.w <= W && o.y + o.h <= H)
    .sort((a, b) => Math.hypot(a.x - r.x, a.y - r.y) - Math.hypot(b.x - r.x, b.y - r.y));
  return opts[0] || r;
}

/** 放開的位置算出要去哪：容器最外緣＝貼邊隱藏；看圖區四邊附近＝吸附到那一邊；其他＝浮動。host、main 是畫面上的方框 */
export function dropTarget(x, y, host, main) {
  const W = host.right - host.left, H = host.bottom - host.top;
  const toEdge = { left: x - host.left, right: host.right - x, top: y - host.top, bottom: host.bottom - y };
  const edge = EDGES.filter((e) => toEdge[e] < HIDE_EDGE).sort((a, b) => toEdge[a] - toEdge[b])[0];
  if (edge) return { kind: "hide", edge, at: edge === "left" || edge === "right" ? (y - host.top) / H : (x - host.left) / W };
  const inX = x > main.left - SNAP_EDGE && x < main.right + SNAP_EDGE, inY = y > main.top - SNAP_EDGE && y < main.bottom + SNAP_EDGE;
  const near = [
    ["left", Math.abs(x - main.left), inY], ["right", Math.abs(main.right - x), inY],
    ["top", Math.abs(y - main.top), inX], ["bottom", Math.abs(main.bottom - y), inX],
  ].filter(([, d, ok]) => ok && d < SNAP_EDGE).sort((a, b) => a[1] - b[1])[0];
  return near ? { kind: "zone", zone: near[0] } : { kind: "float" };
}

// ================================================================ DOM
const docks = new Map();   // 名稱 → { reset }

/** 恢復預設版面：給名稱只恢復那個，不給就全部 */
export function resetDock(name) {
  for (const [n, d] of docks) if (!name || n === name) d.reset();
}

/**
 * 把 page（整頁，或頁裡面一個放欄位的容器）的面板變成自由版面；page 原本的子元素會被換成四區＋看圖區＋浮動層。spec：
 *   name     版面名稱（存檔用，每個容器一個）
 *   main     看圖區要放的元素（固定，不能搬；可以是陣列）
 *   panels   [{ id, title, zone, min, el }]：zone 是預設吸在哪一邊；min 是吸到左右區時至少要多寬（預設 260，窄的區會自動拉寬）；
 *            el 是面板內容，不給就找 page 裡 data-dock="<id>" 的元素
 *   sizes    { top, left, right, bottom }：各區預設尺寸
 *   inset    true＝容器本身已經在一塊機殼面板裡（導演台、漫畫台…），區不再畫成一塊塊機殼
 */
export function mountDock(page, spec) {
  const key = "dock_" + spec.name;
  const title = Object.fromEntries(spec.panels.map((p) => [p.id, p.title]));
  const minW = Object.fromEntries(spec.panels.map((p) => [p.id, p.min ?? MIN.left]));
  let L = normalizeLayout(store.get(key, null), spec);
  const peek = new Set();      // 窄視窗時點開的區（不存）
  let drag = null, zTop = 20;

  // ---- 骨架
  page.classList.add("dock-host");
  const wrap = {}, zone = {}, body = {}, bar = {}, rail = {}, split = {}, tag = {};
  for (const p of spec.panels) {
    const content = p.el || page.querySelector(`[data-dock="${p.id}"]`);
    if (!content) continue;
    const fold = el("button", { type: "button", class: "dock-fold", title: "收起／展開這塊", "aria-label": `收起／展開「${p.title}」`, onclick: () => toggleFold(p.id) }, "▾");
    const back = el("button", { type: "button", class: "dock-back", title: "吸回原本的位置", "aria-label": `「${p.title}」吸回原本的位置`, onclick: () => home(p.id) }, "⇲");
    const head = el("div", { class: "dock-head", title: "拖這裡：放到看圖區旁邊＝吸附、放到最邊緣＝貼邊隱藏、其他地方＝浮動；右鍵有更多選項" },
      el("span", { class: "dock-grip", "aria-hidden": "true" }, "⠿"), el("span", { class: "dock-title" }, p.title), el("span", { class: "grow" }), back, fold);
    head.addEventListener("pointerdown", (e) => startDrag(e, p.id));
    head.addEventListener("contextmenu", (e) => { e.preventDefault(); menu(e, p.id); });
    const b = el("div", { class: "dock-body" });
    const w = wrap[p.id] = el("section", { class: "dock-panel", "data-id": p.id, "aria-label": p.title }, head, b,
      ...["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => el("div", { class: "dock-rz", "data-d": d, "aria-hidden": "true" })));
    w.addEventListener("pointerdown", (e) => {
      if (L.float[p.id]) w.style.zIndex = ++zTop;            // 點到哪塊浮動面板就拿到最上面
      const d = e.target.dataset?.d;
      if (d && e.target.classList.contains("dock-rz")) startFloatResize(e, p.id, d);
    });
    // 貼邊隱藏：滑過去滑出來、移開一下再縮回去
    let leave;
    w.addEventListener("pointerenter", () => { clearTimeout(leave); if (L.hide[p.id]) w.classList.add("peek"); });
    w.addEventListener("pointerleave", () => { leave = setTimeout(() => { if (!drag && !w.contains(document.activeElement)) w.classList.remove("peek"); }, 350); });
    w.addEventListener("focusout", () => { leave = setTimeout(() => { if (!w.matches(":hover") && !w.contains(document.activeElement)) w.classList.remove("peek"); }, 350); });
    tag[p.id] = el("button", { type: "button", class: "dock-tag", title: `「${p.title}」（藏在邊上，滑過去打開）`,
      onpointerenter: () => { clearTimeout(leave); w.classList.add("peek"); }, onclick: () => w.classList.toggle("peek") }, p.title);
    b.append(content);
  }
  for (const z of ZONES) {
    bar[z] = el("div", { class: "dock-zbar" });
    body[z] = el("div", { class: "dock-zbody" });
    rail[z] = el("button", { type: "button", class: "dock-rail", title: "打開這一區", onclick: () => openZone(z) });
    zone[z] = el("div", { class: spec.inset ? "dock-zone dock-inset" : "dock-zone panel screws", "data-zone": z, "aria-label": `${ZONE_NAME[z]}的停靠區` }, bar[z], body[z], rail[z]);
    split[z] = el("div", { class: "dock-split", "data-split": z, role: "separator", tabindex: "0",
      "aria-orientation": z === "top" || z === "bottom" ? "horizontal" : "vertical", title: "拖這條改大小（方向鍵也可以）" });
    split[z].addEventListener("pointerdown", (e) => startResize(e, z));
    split[z].addEventListener("keydown", (e) => keyResize(e, z));
  }
  const pin = el("button", { type: "button", class: "dock-pin", onclick: () => {
    L.pinned = !L.pinned;
    if (L.pinned) for (const id of Object.keys(L.float)) L.float[id] = placeFloat(id, L.float[id]);   // 釘回去：疊在看圖區上的推到旁邊
    commit();
  } }, "📌");
  const main = el("div", { class: "dock-main" }, spec.main, pin);
  const preview = el("div", { class: "dock-preview", hidden: true });
  page.replaceChildren(zone.top, split.top, zone.left, split.left, main, split.right, zone.right, split.bottom, zone.bottom, preview);

  // ---- 畫
  const narrow = () => window.innerWidth <= NARROW;
  const side = (z) => z === "left" || z === "right";
  const collapsedNow = (z) => side(z) && narrow() ? !peek.has(z) : L.zones[z].collapsed;
  function effective() {
    const E = copy(L);
    for (const z of ZONES) E.zones[z].collapsed = collapsedNow(z);
    return E;
  }
  const box = () => ({ W: page.clientWidth, H: page.clientHeight });

  function apply() {
    const { W, H } = box();
    if (!W || !H) return;      // 頁面藏著，等顯示時 ResizeObserver 會再叫
    const s = fitSizes(effective(), W, H);
    const v = { t: s.top, l: s.left, r: s.right, b: s.bottom };
    for (const [k, px] of Object.entries(v)) {
      page.style.setProperty(`--dock-${k}`, px + "px");
      page.style.setProperty(`--gap-${k}`, (px ? GAP : 0) + "px");
    }
    // 浮動、隱藏的面板：視窗變小時拉回容器裡（只影響畫面，不改存檔）
    for (const [id, r0] of Object.entries(L.float)) {
      if (!wrap[id]) continue;
      const r = clampFloat(r0, W, H);
      Object.assign(wrap[id].style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
    }
    for (const [id, h] of Object.entries(L.hide)) {
      if (!wrap[id]) continue;
      const w = Math.min(h.w, W), hh = Math.min(h.h, H), lr = h.edge === "left" || h.edge === "right";
      const pos = lr ? { top: Math.round(h.at * (H - hh)) + "px", left: h.edge === "left" ? "0px" : W - w + "px" }
        : { left: Math.round(h.at * (W - w)) + "px", top: h.edge === "top" ? "0px" : H - hh + "px" };
      Object.assign(wrap[id].style, { width: w + "px", height: hh + "px", ...pos });
      const t = tag[id];
      t.style.left = t.style.top = "";
      if (lr) t.style.top = Math.round(h.at * (H - t.offsetHeight)) + "px"; else t.style.left = Math.round(h.at * (W - t.offsetWidth)) + "px";
    }
  }

  function render() {
    for (const z of ZONES) {
      const S = L.zones[z], col = collapsedNow(z);
      zone[z].classList.toggle("empty", !S.ids.length);
      zone[z].classList.toggle("collapsed", col);
      zone[z].classList.toggle("tabs", S.tabs);
      split[z].classList.toggle("off", !S.ids.length || col);
      body[z].replaceChildren(...S.ids.map((id) => wrap[id]).filter(Boolean));
      for (const id of S.ids) if (wrap[id]) wrap[id].classList.toggle("solo", S.tabs || S.ids.length === 1);
      rail[z].textContent = S.ids.map((id) => title[id]).join("・");
      const tabs = S.tabs ? S.ids.map((id) => el("button", { type: "button", class: "dock-tab" + (id === S.active ? " on" : ""), "data-id": id,
        onclick: () => { L.zones[z].active = id; commit(); } }, title[id])) : [];
      bar[z].replaceChildren(...tabs, el("span", { class: "grow" }),
        el("button", { type: "button", class: "dock-btn", title: S.tabs ? "改成直排：每塊都看得到" : "改成分頁：一次看一塊", onclick: () => { L.zones[z].tabs = !S.tabs; commit(); } }, S.tabs ? "直排" : "分頁"),
        el("button", { type: "button", class: "dock-btn", title: "收起這一區", "aria-label": `收起${ZONE_NAME[z]}的停靠區`, onclick: () => closeZone(z) },
          { top: "▴", left: "«", right: "»", bottom: "▾" }[z]));
    }
    for (const p of spec.panels) {
      const w = wrap[p.id];
      if (!w) continue;
      const at = whereIs(L, p.id), S = at.kind === "zone" ? L.zones[at.zone] : null;
      w.hidden = !!S && S.tabs && p.id !== S.active;
      w.classList.toggle("folded", !(S && S.tabs) && at.kind !== "hide" && L.folded.includes(p.id));
      w.classList.toggle("floating", at.kind === "float");
      w.classList.toggle("dock-hidden", at.kind === "hide");
      w.dataset.edge = at.kind === "hide" ? at.edge : "";
      if (at.kind === "zone") { w.removeAttribute("style"); w.classList.remove("peek"); }
      else if (w.parentElement !== page) { page.append(w); if (at.kind === "float") w.style.zIndex = ++zTop; }
      if (at.kind === "hide") { tag[p.id].dataset.edge = at.edge; if (tag[p.id].parentElement !== page) page.append(tag[p.id]); }
      else tag[p.id].remove();
    }
    page.classList.toggle("pinned", L.pinned);
    pin.classList.toggle("on", L.pinned);
    pin.title = L.pinned ? "看圖區釘選中：浮動面板蓋不到它（按一下拔掉圖釘）" : "看圖區沒釘選：浮動面板可以蓋在上面（按一下釘選）";
    pin.setAttribute("aria-pressed", String(L.pinned));
    pin.hidden = !Object.keys(L.float).length;    // 沒有浮動面板時圖釘沒有作用，不擺出來
    apply();
  }

  function commit() {
    store.set(key, L);
    render();
  }

  /** 吸附到某一邊並打開；吸到太窄的左右區（例如 118px 的幻燈片匣那區）就拉寬到放得下 */
  function place(id, z, i) {
    L = movePanel(L, id, z, i);
    const S = L.zones[z];
    S.collapsed = false;
    if (side(z)) { S.size = Math.max(S.size, ...S.ids.map((x) => minW[x])); peek.add(z); }
    commit();
  }
  /** 吸回預設的那一邊 */
  function home(id) {
    const z = spec.panels.find((p) => p.id === id).zone;
    place(id, z, L.zones[z].ids.length);
  }
  /** 浮動面板最後落在哪：拉回容器裡 → 磁吸對齊 → 釘選時避開看圖區 */
  function placeFloat(id, rect) {
    const { W, H } = box();
    const others = Object.entries(L.float).filter(([k]) => k !== id).map(([, r]) => r);
    let r = clampFloat(snapRect(clampFloat(rect, W, H), others, W, H), W, H);
    if (L.pinned) {
      const mr = main.getBoundingClientRect(), hr = page.getBoundingClientRect();
      r = avoidRect(r, { x: mr.left - hr.left, y: mr.top - hr.top, w: mr.width, h: mr.height }, W, H);
    }
    return r;
  }
  /** 浮起來：沒給位置就從它現在在畫面上的地方浮起來 */
  function floatAt(id, rect) {
    const { W, H } = box();
    if (!rect) {
      const r = wrap[id].getBoundingClientRect(), h = page.getBoundingClientRect();
      rect = { x: r.left - h.left + 24, y: r.top - h.top + 24, w: Math.max(r.width, 300), h: Math.min(Math.max(r.height, 200), H * 0.7) };
    }
    L = floatPanel(L, id, placeFloat(id, rect));
    commit();
    wrap[id].style.zIndex = ++zTop;
  }
  function hideAt(id, edge, at) {
    const { W, H } = box(), r = L.float[id] || wrap[id].getBoundingClientRect();
    const w = Math.round(Math.min(Math.max(r.w ?? r.width, 300), W * 0.5)), h = Math.round(Math.min(Math.max(r.h ?? r.height, 240), H * 0.8));
    const lr = edge === "left" || edge === "right";
    L = hidePanel(L, id, edge, at, lr ? { w, h } : { w: Math.max(w, Math.min(W * 0.6, 640)), h: Math.min(h, H * 0.45) });
    commit();
  }

  function toggleFold(id) {
    L.folded = L.folded.includes(id) ? L.folded.filter((x) => x !== id) : [...L.folded, id];
    commit();
  }
  function openZone(z) {
    if (side(z) && narrow()) { peek.add(z); render(); return; }
    L.zones[z].collapsed = false;
    commit();
  }
  function closeZone(z) {
    if (side(z) && narrow()) { peek.delete(z); render(); return; }
    L.zones[z].collapsed = true;
    commit();
  }
  function reset() {
    store.set(key, null);
    L = defaultLayout(spec);
    peek.clear();
    render();
  }

  // ---- 右鍵選單：收起、吸到哪一邊、浮起來、藏到邊上（不用拖也能搬）、恢復預設
  function menu(e, id) {
    $$(".dock-menu").forEach((m) => m.remove());
    const at = whereIs(L, id);
    const item = (label, fn) => el("button", { type: "button", role: "menuitem", onclick: () => { m.remove(); fn(); } }, label);
    const m = el("div", { class: "dock-menu", role: "menu", style: `left:${e.clientX}px;top:${e.clientY}px` },
      at.kind !== "hide" && item(L.folded.includes(id) ? "展開這塊" : "收起這塊", () => toggleFold(id)),
      ...ZONES.filter((z) => !(at.kind === "zone" && at.zone === z)).map((z) => item(`吸到看圖區${ZONE_NAME[z]}`, () => place(id, z, L.zones[z].ids.length))),
      at.kind !== "float" && item("浮起來（自由擺放）", () => floatAt(id)),
      ...["left", "right"].filter((ed) => !(at.kind === "hide" && at.edge === ed)).map((ed) => item(`藏到${ed === "left" ? "左" : "右"}邊緣`, () => hideAt(id, ed, 0.3))),
      item("恢復預設版面", () => { if (confirm("把這一頁的面板位置、大小都恢復成預設？")) reset(); }));
    document.body.append(m);
    const r = m.getBoundingClientRect();
    if (r.right > innerWidth) m.style.left = Math.max(0, innerWidth - r.width - 4) + "px";
    if (r.bottom > innerHeight) m.style.top = Math.max(0, innerHeight - r.height - 4) + "px";
    setTimeout(() => document.addEventListener("pointerdown", (ev) => { if (!m.contains(ev.target)) m.remove(); }, { once: true }));
  }

  // ---- 拖面板
  function startDrag(e, id) {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    const r = wrap[id].getBoundingClientRect();
    drag = { id, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height, moving: false, target: null };
    addEventListener("pointermove", onDrag);
    addEventListener("pointerup", endDrag);
    addEventListener("pointercancel", cancelDrag);
    addEventListener("keydown", escDrag, true);
  }
  function showPreview(r) {
    if (!r) { preview.hidden = true; return; }
    preview.hidden = false;
    Object.assign(preview.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
  }
  function onDrag(e) {
    if (!drag) return;
    if (!drag.moving) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) return;   // 移 3px 就算開始拖
      drag.moving = true;
      drag.ghost = el("div", { class: "dock-ghost" }, title[drag.id]);
      drag.mark = el("div", { class: "dock-ins" });
      document.body.append(drag.ghost);
      document.body.classList.add("docking");
      wrap[drag.id].classList.add("dragging");
    }
    const hr = page.getBoundingClientRect(), mr = main.getBoundingClientRect(), { W, H } = box();
    drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
    drag.mark.remove();
    for (const k of ZONES) zone[k].classList.remove("dock-drop");
    preview.className = "dock-preview";
    // 先看是不是在最外緣（貼邊隱藏），再看是不是在某個有面板的停靠區上面，最後才用看圖區的邊判斷
    let t = dropTarget(e.clientX, e.clientY, hr, mr);
    const zEl = t.kind === "hide" ? null : document.elementFromPoint(e.clientX, e.clientY)?.closest(".dock-zone");
    if (zEl && zEl.parentElement === page) t = { kind: "zone", zone: zEl.dataset.zone };
    if (t.kind === "zone") {
      const z = t.zone, S = L.zones[z];
      const others = S.ids.filter((x) => x !== drag.id);
      let i = others.length;
      if (S.ids.length && !S.tabs && !collapsedNow(z)) {
        const row = z === "top" || z === "bottom";
        i = others.findIndex((id) => { const r = wrap[id].getBoundingClientRect(); return row ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2; });
        if (i < 0) i = others.length;
        drag.mark.classList.toggle("v", row);
        body[z].insertBefore(drag.mark, others[i] ? wrap[others[i]] : null);
      }
      if (S.ids.length && !collapsedNow(z)) { zone[z].classList.add("dock-drop"); showPreview(null); }
      else {   // 空的那一邊：預覽一條會出現的區
        const m = { x: mr.left - hr.left, y: mr.top - hr.top, w: mr.width, h: mr.height }, d = Math.min(side(z) ? 300 : 200, (side(z) ? m.w : m.h) / 2);
        preview.classList.add("snap");
        showPreview({ left: { ...m, w: d }, right: { ...m, x: m.x + m.w - d, w: d }, top: { ...m, h: d }, bottom: { ...m, y: m.y + m.h - d, h: d } }[z]);
      }
      t.i = i;
    } else if (t.kind === "hide") {
      const s = 10;
      preview.classList.add("edge");
      showPreview({ left: { x: 0, y: 0, w: s, h: H }, right: { x: W - s, y: 0, w: s, h: H }, top: { x: 0, y: 0, w: W, h: s }, bottom: { x: 0, y: H - s, w: W, h: s } }[t.edge]);
    } else {
      const f = L.float[drag.id];
      const w = f ? f.w : Math.max(drag.w, 300), h = f ? f.h : Math.min(Math.max(drag.h, 200), H * 0.7);
      t.rect = placeFloat(drag.id, { x: e.clientX - hr.left - Math.min(drag.dx, w - 40), y: e.clientY - hr.top - drag.dy, w, h });
      preview.classList.add("float");
      showPreview(t.rect);
    }
    drag.target = t;
  }
  function stopDrag() {
    removeEventListener("pointermove", onDrag);
    removeEventListener("pointerup", endDrag);
    removeEventListener("pointercancel", cancelDrag);
    removeEventListener("keydown", escDrag, true);
    const d = drag;
    drag = null;
    if (d?.moving) {
      d.ghost.remove();
      d.mark.remove();
      showPreview(null);
      document.body.classList.remove("docking");
      wrap[d.id].classList.remove("dragging");
      for (const k of ZONES) zone[k].classList.remove("dock-drop");
    }
    return d;
  }
  function endDrag() {
    const d = stopDrag();
    if (!d?.moving || !d.target) return;
    const t = d.target, at = whereIs(L, d.id);
    if (t.kind === "zone") {
      if (at.kind === "zone" && at.zone === t.zone && L.zones[at.zone].ids.indexOf(d.id) === t.i) render();   // 放回原位：不存
      else place(d.id, t.zone, t.i);
    } else if (t.kind === "hide") hideAt(d.id, t.edge, t.at);
    else floatAt(d.id, t.rect);
  }
  function cancelDrag() { if (stopDrag()?.moving) render(); }
  function escDrag(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelDrag(); } }

  // ---- 拉浮動面板的邊和角改大小
  function startFloatResize(e, id, dir) {
    if (e.button !== 0 || !L.float[id]) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.target.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真的指標 */ }
    const { W, H } = box(), r0 = clampFloat(L.float[id], W, H), x0 = e.clientX, y0 = e.clientY;
    wrap[id].classList.add("resizing");
    document.body.style.cursor = getComputedStyle(e.target).cursor;   // 拉的時候游標滑出把手也維持雙箭頭
    const move = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0, r = { ...r0 };
      if (dir.includes("e")) r.w = clamp(r0.w + dx, FLOAT_MIN_W, W - r0.x);
      if (dir.includes("s")) r.h = clamp(r0.h + dy, FLOAT_MIN_H, H - r0.y);
      if (dir.includes("w")) { const nx = clamp(r0.x + dx, 0, r0.x + r0.w - FLOAT_MIN_W); r.w = r0.w + r0.x - nx; r.x = nx; }
      if (dir.includes("n")) { const ny = clamp(r0.y + dy, 0, r0.y + r0.h - FLOAT_MIN_H); r.h = r0.h + r0.y - ny; r.y = ny; }
      L.float[id] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
      apply();
    };
    const up = () => {
      wrap[id].classList.remove("resizing");
      document.body.style.cursor = "";
      e.target.removeEventListener("pointermove", move);
      e.target.removeEventListener("pointerup", up);
      e.target.removeEventListener("pointercancel", up);
      store.set(key, L);
    };
    e.target.addEventListener("pointermove", move);
    e.target.addEventListener("pointerup", up);
    e.target.addEventListener("pointercancel", up);
  }

  // ---- 拖縫改停靠區大小
  const vertical = (z) => z === "top" || z === "bottom";
  const avail = (z) => (vertical(z) ? page.clientHeight : page.clientWidth);
  const shown = (z) => parseFloat(page.style.getPropertyValue(`--dock-${z[0]}`)) || L.zones[z].size;
  function startResize(e, z) {
    if (e.button !== 0 || split[z].classList.contains("off")) return;
    e.preventDefault();
    try { split[z].setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真的指標 */ }
    const x0 = e.clientX, y0 = e.clientY, s0 = shown(z);
    split[z].classList.add("on");
    const move = (ev) => {
      const d = { left: ev.clientX - x0, right: x0 - ev.clientX, top: ev.clientY - y0, bottom: y0 - ev.clientY }[z];
      L.zones[z].size = clampSize(z, s0 + d, avail(z));
      apply();
    };
    const up = () => {
      split[z].classList.remove("on");
      split[z].removeEventListener("pointermove", move);
      split[z].removeEventListener("pointerup", up);
      split[z].removeEventListener("pointercancel", up);
      store.set(key, L);
    };
    split[z].addEventListener("pointermove", move);
    split[z].addEventListener("pointerup", up);
    split[z].addEventListener("pointercancel", up);
  }
  function keyResize(e, z) {
    const grow = { left: "ArrowRight", right: "ArrowLeft", top: "ArrowDown", bottom: "ArrowUp" }[z];
    const shrink = { left: "ArrowLeft", right: "ArrowRight", top: "ArrowUp", bottom: "ArrowDown" }[z];
    const sign = e.key === grow ? 1 : e.key === shrink ? -1 : 0;
    if (!sign) return;
    e.preventDefault();
    L.zones[z].size = clampSize(z, shown(z) + sign * (e.shiftKey ? 60 : 20), avail(z));
    commit();
  }

  new ResizeObserver(() => { if (!drag) apply(); }).observe(page);
  let wasNarrow = narrow();
  addEventListener("resize", () => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); peek.clear(); render(); } });
  render();
  const api = { reset, layout: () => copy(L) };
  docks.set(spec.name, api);
  return api;
}
