// 提示詞庫：整套設定（生成頁的表單）和片段放在一起管理。
// 分資料夾、標籤、適用模型（沒指定＝通用；舊的預設組照當初用的模型自動分）、置頂收藏、縮圖（存的時候自動抓目前預覽的圖）。
// 取代舊的「預設組」（伺服器第一次開新版時抄進來）和存在瀏覽器裡的「我的片段」（這裡第一次載入時搬進來，瀏覽器裡那份不刪）。
import { $, $$, el, api, toast, store, openModal, closeModal, debounce } from "./util.js";
import { app } from "./state.js";
import { pickFromGallery } from "./gallery.js";
// 排序跟著介面語言：簡中照拼音、繁中照筆畫（模組載入時 i18n 還沒設好 <html lang>，所以每次用時再看）
const sortLang = () => (document.documentElement.lang.startsWith("zh-Hans") ? "zh-Hans" : "zh-Hant");

const F = (id) => $("#" + id);
const KIND = { set: "整套設定", snippet: "片段" };
const UNFILED = "未分類";

let items = [];  // 伺服器上的全部（不含縮圖本體）
// 生成頁給的：collect() apply(data)→警告 insert(text) replace(text) family() famOf(model) current() promptEl() onChange()
let ctx = null;
// 篩選：分頁、資料夾（null＝全部，""＝未分類）、標籤（全部都要有）、搜尋字、模型、排序
const V = { tab: "all", folder: null, tags: new Set(), q: "", fam: "auto", sort: "pos" };
const saved = store.get("libView", {});
for (const k of ["tab", "fam", "sort"]) if (typeof saved[k] === "string") V[k] = saved[k];
const keepView = () => store.set("libView", { tab: V.tab, fam: V.fam, sort: V.sort });
let drag = null;  // 拖拉中的那一筆 id

// ---------------------------------------------------------------- 小工具
const famNames = () => app.state?.models?.family_names || { anima: "Anima", qwen21: "Qwen 2.1", moss: "MOSS-Image" };
const famLabel = (f) => (f ? famNames()[f] || f : "通用");
/** 適用模型：any＝使用者指定通用；有指定家族就用；沒指定的整套設定（舊的預設組）看當初用的模型；都沒有＝通用（""） */
const famOf = (it) => (it.family === "any" ? "" : it.family || (it.kind === "set" && ctx?.famOf(it.data?.model)) || "");
const fits = (it) => { const f = famOf(it); return !f || f === ctx?.family(); };
const textOf = (it) => (it.kind === "snippet" ? it.data?.text : it.data?.prompt) || "";
const thumbUrl = (it) => `/api/lib/${it.id}/thumb?v=${it.updated || 0}`;
const short = (name) => (name || "").replace(/\.safetensors$|\.gguf$/i, "").split(/[\\/]/).pop();
const folders = () => [...new Set(items.map((x) => x.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, sortLang()));
const allTags = () => [...new Set(items.flatMap((x) => x.tags || []))].sort((a, b) => a.localeCompare(b, sortLang()));

function when(t) {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(document.documentElement.lang, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(document.documentElement.lang);
}

// ---------------------------------------------------------------- 初始化、載入
export function init(c) {
  ctx = c;
  F("libTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    V.tab = b.dataset.tab;
    keepView();
    render();
  });
  F("libQ").addEventListener("input", debounce(() => { V.q = F("libQ").value.trim(); render(); }, 150));
  F("libFam").onchange = () => { V.fam = F("libFam").value; keepView(); render(); };
  F("libSort").onchange = () => { V.sort = F("libSort").value; keepView(); render(); };
  F("libNewSet").onclick = () => saveDialog({ kind: "set" });
  F("libNewSnip").onclick = () => saveDialog({ kind: "snippet", data: { text: selectedText() } });

  // 編輯視窗
  F("leKind").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]");
    if (!b || !E || E.id != null) return;
    E.kind = b.dataset.k;
    F("leFam").value = E.kind === "set" ? ctx.famOf(E.setData?.model) || ctx.family() : "any";
    if (E.kind === "set" && !E.setData) E.setData = ctx.collect();
    if (E.kind === "snippet" && !F("leText").value.trim()) F("leText").value = E.setData?.prompt || "";
    editKindUi();
  });
  F("leTagIn").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "," || e.key === "，") { e.preventDefault(); addTag(); }
    else if (e.key === "Backspace" && !F("leTagIn").value && E.tags.length) { E.tags.pop(); renderTags(); }
  });
  F("leTagIn").addEventListener("change", addTag);  // 從建議清單點選
  F("leThumbCur").onclick = () => { const r = ctx.current(); if (r) { E.imageId = r.id; E.clear = false; thumbUi(); } };
  F("leThumbPick").onclick = () => pickFromGallery((rec) => { E.imageId = rec.id; E.clear = false; thumbUi(); });
  F("leThumbDel").onclick = () => { E.imageId = null; E.clear = true; thumbUi(); };
  F("leUseCur").onclick = () => { E.setData = ctx.collect(); editKindUi(); toast("已換成生成頁目前的設定（按「儲存」才會存進去）", "ok"); };
  F("leSave").onclick = saveEdit;
  F("leDel").onclick = deleteEdit;
  F("leName").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(); } });
  document.addEventListener("lib-changed", load);
  load();
}

// 同一張表也放資產庫的資產（角色、場景…），這裡只管整套設定和片段
const ownKinds = (all) => all.filter((x) => x.kind === "set" || x.kind === "snippet");

export async function load() {
  try {
    items = ownKinds(await api("/api/lib"));
    if (await migrateSnippets()) items = ownKinds(await api("/api/lib"));
  } catch (e) {
    return toast("讀不到提示詞庫：" + e.message, "err");
  }
  changed();
}

/** 舊版存在瀏覽器裡的「我的片段」搬進提示詞庫的「我的片段」資料夾（只搬一次；瀏覽器裡那份留著） */
async function migrateSnippets() {
  const old = store.get("snippets", []);
  if (!Array.isArray(old) || !old.length || store.get("snippetsMoved", false)) return false;
  let n = 0;
  // 新的會排到最前面：倒著存，順序才會跟原本一樣
  for (const s of [...old].reverse()) {
    const text = (s?.text || "").trim(), name = ((s?.name || "").trim() || text.slice(0, 24)).slice(0, 100);
    if (!text || items.some((x) => x.kind === "snippet" && x.folder === "我的片段" && x.name === name)) continue;
    await api("/api/lib", { json: { kind: "snippet", name, folder: "我的片段", data: { text } } });
    n++;
  }
  store.set("snippetsMoved", true);
  if (n) toast(`已把 ${n} 個「我的片段」搬進提示詞庫（資料夾「我的片段」）`, "ok");
  return n > 0;
}

function changed() {
  fillPickers();
  if (!F("libModal").hidden) render();
  // 資產庫頁也列整套設定和片段（assets.js）。不能用 lib-changed：那是「叫提示詞庫重讀」，自己會聽到再重讀、無限迴圈
  document.dispatchEvent(new Event("lib-updated"));
}

function put(r) {
  const i = items.findIndex((x) => x.id === r.id);
  if (i >= 0) items[i] = r; else items.unshift(r);
  changed();
}

// ---------------------------------------------------------------- 生成頁的選單
/** 「套用整套設定」選單（只列目前模型能用的）＋「插入片段」裡的我的片段；模型換了、庫改了都要重填 */
export function fillPickers() {
  if (!ctx) return;
  fillQuick();
  ctx.onChange?.();
}

// 依置頂／資料夾分組：置頂、未分類在前，其他照名稱
function grouped(list) {
  const g = new Map();
  for (const it of list) {
    const k = it.fav ? "★ 置頂" : it.folder || UNFILED;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(it);
  }
  const rank = (k) => (k === "★ 置頂" ? 0 : k === UNFILED ? 1 : 2);
  return [...g.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, sortLang()));
}

function fillQuick() {
  const s = F("presetSel");
  const sets = sortItems(items.filter((x) => x.kind === "set" && fits(x)), "pos");
  const others = items.filter((x) => x.kind === "set" && !fits(x)).length;
  s.innerHTML = "";
  s.append(el("option", { value: "" }, sets.length ? `套用整套設定…（${sets.length}）` : "套用整套設定（還沒有）"));
  for (const [g, list] of grouped(sets)) {
    const og = el("optgroup", { label: g });
    for (const it of list) og.append(el("option", { value: it.id, title: textOf(it) }, it.name));
    s.append(og);
  }
  if (others) s.append(el("option", { value: "__other" }, `（另外 ${others} 組是別的模型用的…）`));
}

/** 「插入片段」選單裡「我的片段」那幾組（值是 lib:編號） */
export function snippetGroups() {
  const sn = sortItems(items.filter((x) => x.kind === "snippet" && fits(x)), "pos");
  const out = grouped(sn).map(([g, list]) => {
    const og = el("optgroup", { label: g === UNFILED || g === "我的片段" ? "我的片段" : `我的片段・${g}` });
    for (const it of list) og.append(el("option", { value: `lib:${it.id}`, title: it.data?.text || "" }, it.name));
    return og;
  });
  const act = el("optgroup", { label: out.length ? "片段管理" : "我的片段（還沒有，可以先存一個）" });
  act.append(el("option", { value: "__save" }, "★ 把選取的文字存成片段…"));
  act.append(el("option", { value: "__manage" }, "✎ 打開提示詞庫管理片段…"));
  out.push(act);
  return out;
}

/** 生成頁選單選到的那一筆 */
export function useById(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return toast("找不到這一筆（可能已經刪掉了）", "err");
  if (it.kind === "set") applySet(it); else useSnippet(it);
}

const selectedText = () => {
  const ta = ctx.promptEl();
  return ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
};

/** 提示詞框選取的文字（沒選就整段）存成片段 */
export function saveSnippetFromSelection() {
  saveDialog({ kind: "snippet", data: { text: selectedText() || ctx.promptEl().value.trim() } });
}

// ---------------------------------------------------------------- 套用
function markUsed(it) {
  it.used = Date.now() / 1000;
  it.uses = (it.uses || 0) + 1;
  api("/api/lib/used", { json: { id: it.id } }).catch(() => {});
}

export function applySet(it) {
  const warn = ctx.apply(it.data || {});
  markUsed(it);
  if (warn.length) toast(`已套用「${it.name}」，但是：\n${warn.join("\n")}`, "err");
  else toast(`已套用整套設定「${it.name}」（種子沒存在裡面，照目前的）`, "ok");
}

function useSnippet(it, replace = false) {
  const t = it.data?.text || "";
  if (replace) ctx.replace(t); else ctx.insert(t);
  markUsed(it);
  toast(replace ? `提示詞換成片段「${it.name}」` : `已插入片段「${it.name}」`, "ok");
}

// ---------------------------------------------------------------- 提示詞庫視窗
/** 打開提示詞庫；tab：all／set／snippet／recent／fav；fam：auto／all */
export function open(tab, fam) {
  if (tab) V.tab = tab;
  if (fam) V.fam = fam;
  V.folder = null;
  V.tags.clear();
  V.q = "";
  F("libQ").value = "";
  keepView();
  openModal("#libModal");
  render();
  F("libQ").focus();
}

function inTab(it) {
  return V.tab === "set" ? it.kind === "set" : V.tab === "snippet" ? it.kind === "snippet" : V.tab === "recent" ? !!it.used : V.tab === "fav" ? !!it.fav : true;
}
function inFam(it) {
  if (V.fam === "all") return true;
  if (V.fam === "auto") return fits(it);
  return famOf(it) === V.fam.slice(2);  // "f:anima"、"f:"＝只看通用
}
function hay(it) {
  return [it.name, it.folder, ...(it.tags || []), it.note, textOf(it), it.data?.negative, it.kind === "set" ? it.data?.model : ""].join("\n").toLowerCase();
}
const words = () => V.q.toLowerCase().split(/\s+/).filter(Boolean);
const inQuery = (it, w = words()) => !w.length || w.every((x) => hay(it).includes(x));
const inFolder = (it) => V.folder === null || it.folder === V.folder;
const inTags = (it) => [...V.tags].every((t) => (it.tags || []).includes(t));

function sortItems(list, sort = V.sort, pinFav = true) {
  const by = {
    pos: (a, b) => a.pos - b.pos || a.id - b.id,
    used: (a, b) => (b.used || 0) - (a.used || 0),
    uses: (a, b) => (b.uses || 0) - (a.uses || 0) || (b.used || 0) - (a.used || 0),
    name: (a, b) => a.name.localeCompare(b.name, sortLang()),
    new: (a, b) => (b.created || 0) - (a.created || 0),
  }[sort] || ((a, b) => a.pos - b.pos);
  // 置頂收藏排最前面（「最近用過」分頁只照時間排）
  return list.slice().sort((a, b) => (pinFav ? (b.fav || 0) - (a.fav || 0) : 0) || by(a, b));
}

function render() {
  $$("#libTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === V.tab));
  fillFamSel();
  F("libSort").value = V.sort;
  F("libSort").disabled = V.tab === "recent";
  const w = words();
  const base = items.filter((it) => inTab(it) && inFam(it) && inQuery(it, w));
  renderSide(base);
  const shown = base.filter(inFolder).filter(inTags);
  const list = V.tab === "recent" ? sortItems(shown, "used", false) : sortItems(shown);
  renderCards(list);
  F("libRecent").hidden = V.tab !== "recent";
  if (V.tab === "recent") renderRecent(w);
  F("libCount").textContent = `共 ${items.length} 筆・符合 ${list.length} 筆`;
  F("libDragHint").hidden = V.sort === "pos" || V.tab === "recent" || !list.length;
}

function fillFamSel() {
  const s = F("libFam");
  s.innerHTML = "";
  s.append(el("option", { value: "auto" }, `目前模型（${famLabel(ctx.family())}）＋通用`));
  s.append(el("option", { value: "all" }, "全部模型"));
  for (const [k, n] of Object.entries(famNames())) s.append(el("option", { value: "f:" + k }, `只看 ${n}`));
  s.append(el("option", { value: "f:" }, "只看通用"));
  s.value = [...s.options].some((o) => o.value === V.fam) ? V.fam : "auto";
}

function renderSide(base) {
  const side = F("libSide");
  side.innerHTML = "";
  const n = new Map();
  for (const it of base) n.set(it.folder, (n.get(it.folder) || 0) + 1);
  side.append(el("div", { class: "lib-h" }, "資料夾"));
  side.append(folderBtn(null, "全部", base.length));
  side.append(folderBtn("", UNFILED, n.get("") || 0));
  for (const f of folders()) side.append(folderBtn(f, f, n.get(f) || 0));
  side.append(el("div", { class: "muted sm lib-tip" }, "把卡片拖到資料夾上就能搬過去"));

  const tagN = new Map();
  for (const it of base.filter(inFolder)) for (const t of it.tags || []) tagN.set(t, (tagN.get(t) || 0) + 1);
  for (const t of V.tags) if (!tagN.has(t)) tagN.set(t, 0);
  side.append(el("div", { class: "lib-h" }, "標籤"));
  const chips = el("div", { class: "chips" });
  const tags = [...tagN.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], sortLang()));
  for (const [t, c] of tags) {
    chips.append(el("button", { class: "chip" + (V.tags.has(t) ? " on" : ""), type: "button", title: V.tags.has(t) ? "取消這個標籤" : "只看有這個標籤的",
      onclick: () => { V.tags.has(t) ? V.tags.delete(t) : V.tags.add(t); render(); } }, `#${t} ${c}`));
  }
  if (!tags.length) chips.append(el("span", { class: "muted sm" }, "還沒有標籤（編輯時可以加）"));
  side.append(chips);
}

function folderBtn(f, label, count) {
  const on = V.folder === f;
  const b = el("div", { class: "lib-f" + (on ? " on" : "") + (count ? "" : " empty"), role: "button", tabindex: 0,
    onclick: () => { V.folder = f; render(); },
    onkeydown: (e) => { if (e.key === "Enter") { V.folder = f; render(); } } },
  el("span", { class: "nm" }, f === "" ? `（${label}）` : label), el("span", { class: "n" }, count));
  if (f) b.append(el("button", { class: "icon", type: "button", title: "資料夾改名（清空＝拿掉資料夾）", onclick: (e) => { e.stopPropagation(); renameFolder(f); } }, "✎"));
  if (f !== null) {
    b.addEventListener("dragover", (e) => { if (drag != null) { e.preventDefault(); b.classList.add("drop"); } });
    b.addEventListener("dragleave", () => b.classList.remove("drop"));
    b.addEventListener("drop", (e) => { e.preventDefault(); b.classList.remove("drop"); if (drag != null) moveTo(drag, f); });
  }
  return b;
}

async function renameFolder(f) {
  const to = prompt(`資料夾「${f}」改名成（清空＝拿掉這個資料夾，裡面的變回未分類）：`, f);
  if (to === null || to.trim() === f) return;
  try {
    await api("/api/lib/folder", { json: { from: f, to: to.trim() } });
    if (V.folder === f) V.folder = to.trim() || null;
    await load();
    toast(to.trim() ? `資料夾改名成「${to.trim()}」` : `資料夾「${f}」拿掉了，裡面的變回未分類`, "ok");
  } catch (e) { toast(e.message, "err"); }
}

async function moveTo(id, folder) {
  const it = items.find((x) => x.id === id);
  if (!it || it.folder === folder) return;
  try {
    put(await api("/api/lib", { json: { id, folder } }));
    toast(`「${it.name}」搬到「${folder || UNFILED}」`, "ok");
  } catch (e) { toast(e.message, "err"); }
}

function emptyText() {
  if (!items.length) return "提示詞庫還是空的。生成頁按「存成整套」可以把目前的設定（提示詞、模型、LoRA、尺寸、步數…）存起來；在提示詞框選取文字，再從「插入片段」選「把選取的文字存成片段」。";
  return "沒有符合的。換個分頁、模型篩選或資料夾試試，或清掉搜尋字和標籤。";
}

function renderCards(list) {
  const box = F("libCards");
  box.innerHTML = "";
  if (!list.length) box.append(el("div", { class: "empty-state" }, emptyText()));
  for (const it of list) box.append(card(it));
}

function setLine(d) {
  const ls = (d.loras || []).filter((l) => l.enabled !== false).length;
  return [short(d.model) || "沒記模型", d.width && d.height ? `${d.width}×${d.height}` : "", ls ? `LoRA ${ls} 個` : "沒用 LoRA"].filter(Boolean).join("・");
}

function card(it) {
  const isSet = it.kind === "set", f = famOf(it);
  const ph = el("div", { class: "ph" + (it.has_thumb ? "" : " txt"), title: "編輯", onclick: () => edit(it) },
    it.has_thumb ? null : el("span", { class: "pv" }, textOf(it).slice(0, 260)),
    el("span", { class: "badge kind " + it.kind }, KIND[it.kind]),
    el("span", { class: "badge famb" }, famLabel(f)));
  if (it.has_thumb) ph.style.backgroundImage = `url("${thumbUrl(it)}")`;
  const acts = isSet
    ? [el("button", { class: "akey sm go", type: "button", title: "提示詞、模型、LoRA、尺寸、步數…整套換成這一組", onclick: () => { applySet(it); closeModal("#libModal"); } }, "套用整套")]
    : [el("button", { class: "akey sm go", type: "button", title: "加到提示詞後面（已經有的 tag 不會重複加）", onclick: () => useSnippet(it) }, "插入"),
      el("button", { class: "akey sm", type: "button", title: "整段提示詞換成這個片段", onclick: () => useSnippet(it, true) }, "取代")];
  const c = el("div", { class: "card lcard" + (it.fav ? " fav" : ""), draggable: "true", "data-id": it.id },
    ph,
    el("div", { class: "bd" },
      el("div", { class: "t" },
        el("button", { class: "icon pin" + (it.fav ? " on" : ""), type: "button", title: it.fav ? "取消置頂" : "置頂收藏（排最前面）", onclick: () => toggleFav(it) }, it.fav ? "★" : "☆"),
        el("span", { class: "nm", title: it.name }, it.name)),
      el("div", { class: "st" }, [it.folder || UNFILED, ...(it.tags || []).map((t) => "#" + t)].join("　")),
      isSet ? el("div", { class: "st" }, setLine(it.data || {})) : null,
      it.note ? el("div", { class: "st note", title: it.note }, it.note) : null,
      el("div", { class: "ft" }, ...acts, el("span", { class: "grow" }),
        el("span", { class: "st" }, it.uses ? `用過 ${it.uses} 次` : "還沒用過"),
        el("button", { class: "icon", type: "button", title: "編輯（名稱、資料夾、標籤、縮圖…）", onclick: () => edit(it) }, "✎"))));
  c.addEventListener("dragstart", (e) => { drag = it.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(it.id)); c.classList.add("dragging"); });
  c.addEventListener("dragend", () => { drag = null; $$(".lcard.dragging, .lcard.before, .lcard.after").forEach((x) => x.classList.remove("dragging", "before", "after")); });
  c.addEventListener("dragover", (e) => {
    if (drag == null || drag === it.id || V.sort !== "pos" || V.tab === "recent") return;
    // 置頂的永遠排前面：置頂和沒置頂的之間換位置沒有意義
    if (!!items.find((x) => x.id === drag)?.fav !== !!it.fav) return;
    e.preventDefault();
    const r = c.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    c.classList.toggle("after", after);
    c.classList.toggle("before", !after);
  });
  c.addEventListener("dragleave", () => c.classList.remove("before", "after"));
  c.addEventListener("drop", (e) => {
    if (drag == null || V.sort !== "pos") return;
    e.preventDefault();
    const after = c.classList.contains("after");
    c.classList.remove("before", "after");
    reorder(drag, it.id, after);
  });
  return c;
}

async function reorder(id, target, after) {
  if (id === target) return;
  const ord = sortItems(items, "pos");
  const from = ord.findIndex((x) => x.id === id);
  if (from < 0) return;
  const [m] = ord.splice(from, 1);
  ord.splice(ord.findIndex((x) => x.id === target) + (after ? 1 : 0), 0, m);
  ord.forEach((x, i) => (x.pos = i));
  changed();
  try { await api("/api/lib/order", { json: { ids: ord.map((x) => x.id) } }); }
  catch (e) { toast("排序沒存到：" + e.message, "err"); load(); }
}

async function toggleFav(it) {
  try { put(await api("/api/lib", { json: { id: it.id, fav: !it.fav } })); }
  catch (e) { toast(e.message, "err"); }
}

function renderRecent(w) {
  const box = F("libRecentList");
  box.innerHTML = "";
  const list = store.get("recent", []).filter((r) => !w.length || w.every((x) => r.prompt.toLowerCase().includes(x)));
  if (!list.length) box.append(el("div", { class: "muted sm" }, "還沒有。按「生成」之後，用過的提示詞會自動記在這裡（最多 40 筆，存在這台電腦的瀏覽器裡）。"));
  for (const r of list) {
    box.append(el("div", { class: "lib-rec" },
      el("span", { class: "when" }, when(r.at)),
      el("span", { class: "txt", title: r.prompt }, r.prompt.replace(/\s+/g, " ")),
      el("button", { class: "akey sm", type: "button", title: "整段換掉生成頁的提示詞", onclick: () => { ctx.replace(r.prompt); toast("已換成這段提示詞", "ok"); } }, "放進提示詞框"),
      el("button", { class: "akey sm", type: "button", onclick: () => saveDialog({ kind: "snippet", data: { text: r.prompt } }) }, "存成片段")));
  }
}

// ---------------------------------------------------------------- 存檔／編輯視窗
// 編輯中的那一筆：id（新的是 null）、kind、setData（整套設定的表單）、imageId（要換成這張圖當縮圖）、clear（拿掉縮圖）、tags
let E = null;

export function edit(it) { openEdit({ it }); }

/** 存新的一筆：kind＝set（沒給 data 就拿生成頁目前的設定）或 snippet（data.text）；imageId＝縮圖用哪張（整套設定預設抓目前預覽的圖） */
export function saveDialog({ kind = "set", data, imageId, name } = {}) {
  if (kind === "set" && !data) data = ctx.collect();
  if (kind === "set" && imageId === undefined) imageId = ctx.current()?.id ?? null;
  openEdit({ kind, data, imageId, name });
}

function suggestName(kind, data) {
  const t = (kind === "set" ? data?.prompt : data?.text) || "";
  // 跳過品質詞、評級、人數這類每組都有的
  const skip = /^(masterpiece|best quality|score_\d|safe|sensitive|nsfw|explicit|questionable|\d+(girl|boy)s?|solo|highres|absurdres|very aesthetic|newest|year \d+)$/i;
  const parts = t.split(/[,\n]/).map((s) => s.trim()).filter((s) => s && !skip.test(s) && !s.startsWith("@"));
  return (parts.slice(0, 3).join(", ") || (kind === "set" ? "我的設定" : "我的片段")).slice(0, 40);
}

function openEdit({ it, kind, data, imageId, name }) {
  E = { id: it?.id ?? null, kind: it?.kind || kind, it, imageId: imageId ?? null, clear: false, tags: [...(it?.tags || [])],
    setData: (it?.kind || kind) === "set" ? structuredClone(it ? it.data : data) : null };
  const text = it ? (it.kind === "snippet" ? it.data?.text : "") : kind === "snippet" ? data?.text : "";
  F("leTitle").textContent = it ? `編輯「${it.name}」` : E.kind === "set" ? "把設定存進提示詞庫" : "存成片段";
  F("leName").value = it?.name || name || suggestName(E.kind, E.kind === "set" ? E.setData : data);
  F("leKind").hidden = !!it;
  F("leFolder").value = it ? it.folder : V.folder || "";
  F("leFolders").replaceChildren(...folders().map((f) => el("option", { value: f })));
  F("leTagList").replaceChildren(...allTags().map((t) => el("option", { value: t })));
  const fs = F("leFam");
  fs.innerHTML = "";
  fs.append(el("option", { value: "any" }, "通用（每個模型都列出來）"));
  for (const [k, n] of Object.entries(famNames())) fs.append(el("option", { value: k }, `只給 ${n}`));
  // 從圖片存的整套設定照那張圖的模型分（生成頁現在可能是別的模型）
  fs.value = it ? famOf(it) || "any" : E.kind === "set" ? ctx.famOf(E.setData?.model) || ctx.family() : "any";
  F("leFav").checked = !!it?.fav;
  F("leNote").value = it?.note || "";
  F("leText").value = text || "";
  F("leTagIn").value = "";
  F("leDel").hidden = !it;
  renderTags();
  editKindUi();
  openModal("#libEdit");
  F("leName").focus();
  F("leName").select();
}

function editKindUi() {
  const isSet = E.kind === "set";
  $$("#leKind button").forEach((b) => b.classList.toggle("on", b.dataset.k === E.kind));
  F("leTextRow").hidden = isSet;
  F("leSetRow").hidden = !isSet;
  F("leUseCur").hidden = !isSet || E.id == null;
  if (isSet) {
    const d = E.setData || {};
    const ls = (d.loras || []).filter((l) => l.enabled !== false).map((l) => `${short(l.name)} ${l.strength}`);
    F("leSum").replaceChildren(
      el("div", {}, el("span", { class: "k" }, "模型　"), short(d.model) || "（沒記）", el("span", { class: "k" }, `　${d.width || "?"}×${d.height || "?"}・${d.steps || "?"} 步・CFG ${d.cfg ?? "?"}・${d.sampler || ""}`)),
      el("div", {}, el("span", { class: "k" }, "LoRA　"), ls.length ? ls.join("、") : "沒有"),
      el("div", { class: "v" }, (d.prompt || "（提示詞是空的）").slice(0, 600)));
  }
  thumbUi();
}

function thumbUi() {
  const url = E.imageId ? `/thumb/${E.imageId}` : !E.clear && E.it?.has_thumb ? thumbUrl(E.it) : "";
  const ph = F("leThumb");
  ph.style.backgroundImage = url ? `url("${url}")` : "";
  ph.textContent = url ? "" : "沒有縮圖";
  F("leThumbDel").hidden = !url;
  F("leThumbCur").disabled = !ctx.current();
}

function addTag() {
  const raw = F("leTagIn").value;
  F("leTagIn").value = "";
  for (let t of raw.split(/[,，、]/)) {
    t = t.trim().replace(/^#/, "").trim().slice(0, 30);
    if (t && !E.tags.includes(t)) E.tags.push(t);
  }
  renderTags();
}

function renderTags() {
  F("leTagChips").replaceChildren(...E.tags.map((t, i) => el("span", { class: "chip on" }, "#" + t,
    el("button", { class: "x", type: "button", title: "拿掉", "aria-label": `拿掉標籤 ${t}`, onclick: () => { E.tags.splice(i, 1); renderTags(); } }, "✕"))));
}

async function saveEdit() {
  const name = F("leName").value.trim();
  if (!name) { F("leName").focus(); return toast("請輸入名稱", "err"); }
  addTag();
  const kind = E.kind;
  const data = kind === "set" ? E.setData || ctx.collect() : { text: F("leText").value.trim() };
  if (kind === "snippet" && !data.text) { F("leText").focus(); return toast("片段的內容是空的", "err"); }
  const body = { kind, name, folder: F("leFolder").value.trim(), tags: E.tags, family: F("leFam").value, fav: F("leFav").checked, note: F("leNote").value.trim(), data };
  let id = E.id;
  if (id == null) {
    const dup = items.find((x) => x.kind === kind && x.folder === body.folder && x.name === name);
    if (dup) {
      if (!confirm(`「${body.folder || UNFILED}」裡已經有叫「${name}」的${KIND[kind]}，要覆蓋它嗎？\n（取消＝回去改名字）`)) return F("leName").focus();
      id = dup.id;
    }
  }
  if (id != null) body.id = id;
  if (E.imageId) body.image_id = E.imageId;
  else if (E.clear) body.thumb = null;
  const b = F("leSave");
  b.disabled = true;
  try {
    const r = await api("/api/lib", { json: body });
    put(r);
    closeModal("#libEdit");
    if (r.thumb_error) toast(r.thumb_error, "err");
    toast(`已存進提示詞庫：${KIND[kind]}「${name}」`, "ok");
  } catch (e) {
    toast("存不進去：" + e.message, "err");
    if (/找不到這一筆/.test(e.message)) { closeModal("#libEdit"); load(); }
  } finally {
    b.disabled = false;
  }
}

async function deleteEdit() {
  const it = E?.it;
  if (!it || !confirm(`刪除${KIND[it.kind]}「${it.name}」？\n刪掉就救不回來（想留底可以先到設定頁按「匯出設定」）`)) return;
  try {
    await api(`/api/lib/${it.id}`, { method: "DELETE" });
    items = items.filter((x) => x.id !== it.id);
    closeModal("#libEdit");
    changed();
    toast(`已刪除「${it.name}」`, "ok");
  } catch (e) { toast(e.message, "err"); }
}
