// 資產庫頁：角色、場景、道具…全站共用（後端 server\api_assets.rs；資料跟提示詞庫同一張 prompt_lib 表）。
// 整套設定、提示詞片段也列在這裡，點下去沿用提示詞庫原本的編輯窗（library.js）
import { $, $$, api, el, toast, store, pickFile, uploadFile, openModal, closeModal } from "./util.js";
import { pickFromGallery } from "./gallery.js";
import * as library from "./library.js";

const F = (id) => document.getElementById(id);

/** 分類：鍵、中文名（照設計文件 4.2） */
export const KINDS = [
  ["char", "角色"], ["scene", "場景"], ["frame", "首幀／姿勢"], ["outfit", "服裝"], ["prop", "道具"],
  ["fx", "特效"], ["sound", "聲音"], ["snippet", "提示詞片段"], ["set", "整套設定"], ["shot", "拍攝單範本"],
];
export const SNIPPET_FOLDERS = [
  ["少女", "少女"], ["萝莉", "萝莉"], ["假小子", "假小子"], ["肉感", "肉感"],
  ["厚涂", "厚涂"], ["强烈质感设计", "强烈质感"], ["后缀", "后缀"], ["anima", "Anima"],
];
export const KIND_NAME = Object.fromEntries([...KINDS, ...SNIPPET_FOLDERS]);
export const VALID_BACKEND_KINDS = new Set(["char", "scene", "frame", "outfit", "prop", "fx", "sound", "snippet", "set", "shot"]);
export const VALID_MEDIA_KINDS = new Set(["char", "scene", "frame", "outfit", "prop", "fx", "sound", "shot"]);
const MEDIA = new Set(["char", "scene", "frame", "outfit", "prop", "fx", "sound", "shot"]);
/** 圖片用途：鍵、中文名（順序就是拿去用時的排序） */
export const ROLES = [
  ["src", "原圖"], ["portrait", "正面特寫"], ["sheet", "多視圖（穿衣）"], ["face", "臉部特寫表"], ["sheet_nude", "多視圖（裸體）"], ["detail", "細節"],
  ["pose", "姿勢"], ["outfit", "服裝"], ["other", "其他"],
];
const LAYOUT = [["top", "上方"], ["bottom", "下方"], ["left", "左邊"], ["right", "右邊"], ["fg", "前景"], ["mid", "中景"], ["bg", "遠景"], ["light", "光線"]];
const TEXT_KINDS = new Set(["frame", "outfit", "prop", "fx", "sound", "snippet", "set"]);

let items = [];        // /api/lib 的全部（含整套設定、片段）
let kind = "all";      // 目前的分類晶片
let snippetFolder = null; // null＝全部片段，空字串＝未分類
let categories = KINDS.map(([id, name]) => ({ id, name, kind: id }));
let savedFolders = [];
let managing = false;
let cur = null;        // 編輯中的那一筆（新的還沒存：id 是 null）
let loaded = false;
let busy = false;

// 檔案操作也會先存表單；同一段操作完成前固定編輯對象和欄位。
async function editAction(action) {
  if (busy || !cur) return null;
  const initial = cur;
  busy = true;
  const controls = [...F("asForm").querySelectorAll("input, select, textarea, button"), F("asNew")];
  const disabled = controls.map((e) => e.disabled);
  controls.forEach((e) => { e.disabled = true; });
  try { return await action(); }
  catch (e) { toast(e.message, "err"); return null; }
  finally {
    // 存表單成功、後續上傳失敗時，也要保留已取得的 id 與伺服器清理後的內容。
    if (cur !== initial) {
      fill();
      if (cur) showUnverified(cur.unverified || []);
    }
    controls.forEach((e, i) => { e.disabled = disabled[i]; });
    busy = false;
  }
}

export const fileUrl = (f) => `/api/assets/file/${encodeURIComponent(f)}`;
const thumbUrl = (it) => (it.has_thumb ? `/api/lib/${it.id}/thumb?v=${Math.round(it.updated || 0)}` : "");
const splitList = (s) => s.split(/[,，、\n]/).map((t) => t.trim()).filter(Boolean);

export async function load() {
  try { items = await api("/api/lib"); loaded = true; } catch (e) { return toast("讀不到資產庫：" + e.message, "err"); }
  paint();
}

/** 給其他頁用（抽屜）：只要資產，不要整套設定 */
export async function list() {
  if (!loaded) await load();
  return items;
}

export function show() { load(); }

const categoryOf = (id) => categories.find((c) => c.id === id);
const backendKind = (id) => categoryOf(id)?.kind || id;
const inCategory = (it, id) => id === "all" || (it.kind === backendKind(id) && (!categoryOf(id)?.tag || it.tags?.includes(categoryOf(id).tag)));
const folderNames = () => [...new Set([...savedFolders, ...items.filter((x) => x.kind === "snippet").map((x) => x.folder)].filter(Boolean))];
const folderLabel = (f) => SNIPPET_FOLDERS.find(([key]) => key === f)?.[1] || f;

function keepCategories() {
  store.set("assetCategories", categories);
  store.set("assetSnippetFolders", savedFolders);
  for (const [id, name] of KINDS) KIND_NAME[id] = categoryOf(id)?.name || name;
}

function categoryOptions() {
  return [...KINDS.map(([id, name]) => ({ id, name: categoryOf(id)?.name || name })), ...categories.filter((c) => c.tag)]
    .map((c) => el("option", { value: c.id }, c.name));
}

function updateCategoryOptions() {
  const selected = F("asKind").value;
  F("asKind").replaceChildren(...categoryOptions());
  F("asKind").value = (categoryOf(selected) || VALID_BACKEND_KINDS.has(selected)) ? selected : cur?.kind || "char";
}

function categoryName(value, max) {
  const name = value.trim();
  if (!name || [...name].length > max || /^[#]/.test(name) || /[,，、\n]/.test(name)) throw new Error(`名稱請填 1～${max} 個字，不含逗號、換行或開頭的 #`);
  return name;
}

function addCategory(name, type) {
  name = categoryName(name, 30);
  if (!VALID_BACKEND_KINDS.has(type)) throw new Error("請選擇資產類型");
  if (categories.some((c) => c.name === name || c.tag === name)) throw new Error("已有同名分類");
  const id = "category_" + crypto.randomUUID();
  categories.push({ id, name, kind: type, tag: name });
  kind = id;
  snippetFolder = null;
  keepCategories();
  updateCategoryOptions();
  paint();
}

// 只更新歸類欄位，保留其他頁剛存的內容；失敗時保留兩邊分類，方便重試剩餘項目。
async function changeCategory(scope, key, name) {
  if (managing || busy) return;
  const cat = scope === "main" ? categoryOf(key) : null;
  if (scope === "main" && !cat) return;
  let merge = null;
  if (name !== null) {
    name = categoryName(name, scope === "main" ? 30 : 50);
    if (name === (cat?.name || key)) return;
    merge = scope === "main" ? categories.find((c) => c.id !== key && (c.name === name || c.tag === name)) : null;
    if (merge && (!cat.tag || !merge.tag || cat.kind !== merge.kind)) throw new Error("已有同名分類");
    if ((merge || (scope === "folder" && folderNames().includes(name))) && !confirm(`已有「${name}」，要將兩個分類合併嗎？`)) return;
  }
  managing = true;
  let moved = 0;
  try {
    // 重讀後再挑選，避免漏掉其他頁剛新增的資產。
    items = await api("/api/lib");
    const affected = scope === "folder" ? items.filter((x) => x.kind === "snippet" && x.folder === key)
      : cat.tag ? items.filter((x) => inCategory(x, key)) : [];
    if (scope === "folder" && name && !savedFolders.includes(name)) savedFolders.push(name);
    if (scope === "folder") keepCategories();
    for (const it of affected) {
      const patch = scope === "folder" ? { folder: name || "" }
        : { tags: [...new Set((it.tags || []).filter((t) => t !== cat.tag).concat(name ? [name] : []))] };
      const updated = await api("/api/lib", { json: { id: it.id, ...patch } });
      items[items.findIndex((x) => x.id === it.id)] = updated;
      if (cur?.id === it.id) {
        Object.assign(cur, patch);
        if (scope === "folder") {
          if (F("asFolder").value.trim() === key) F("asFolder").value = name || "";
        } else {
          F("asLabels").value = [...new Set(splitList(F("asLabels").value).flatMap((t) => t === cat.tag ? (name ? [name] : []) : [t]))].join(", ");
        }
      }
      moved++;
    }
    if (scope === "folder") {
      savedFolders = savedFolders.filter((f) => f !== key);
      if (snippetFolder === key) snippetFolder = name ?? "";
    } else if (name === null || merge) {
      categories = categories.filter((c) => c.id !== key);
      if (kind === key) kind = merge?.id || "all";
    } else {
      cat.name = name;
      if (cat.tag) cat.tag = name;
    }
    keepCategories();
    toast(name === null ? "已移除分類，資產內容保留" : "分類已改名", "ok");
  } catch (e) {
    if (moved && cat?.tag && name && !categories.some((c) => c.tag === name && c.kind === cat.kind)) {
      categories.push({ id: "category_" + crypto.randomUUID(), name, kind: cat.kind, tag: name });
      keepCategories();
    }
    throw new Error(`${e.message}${moved ? `（已更新 ${moved} 筆，可重試剩餘項目）` : ""}`);
  } finally {
    managing = false;
    updateCategoryOptions();
    paint();
    document.dispatchEvent(new Event("lib-changed"));
  }
}

function manageCategories(scope) {
  if (busy || managing) return;
  const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "管理分類" });
  const rows = el("div", { style: "display: grid; gap: 8px;" });
  const name = el("input", { type: "text", maxlength: scope === "main" ? 30 : 50, placeholder: "新分類名稱", "aria-label": "新分類名稱" });
  const type = el("select", { "aria-label": "資產類型", hidden: scope !== "main" }, ...KINDS.map(([k, n]) => el("option", { value: k }, KIND_NAME[k] || n)));
  const close = el("button", { class: "akey sm", type: "button", onclick: () => { if (!managing) modal.remove(); } }, "關閉");
  const run = async (action) => {
    if (managing) return;
    const controls = [...modal.querySelectorAll("button, input, select")];
    controls.forEach((e) => { e.disabled = true; });
    try { await action(); render(); }
    catch (e) { toast(e.message, "err"); }
    finally { controls.forEach((e) => { e.disabled = false; }); }
  };
  const render = () => {
    const entries = scope === "main" ? categories.map((c) => [c.id, c.name]) : folderNames().map((f) => [f, folderLabel(f)]);
    rows.replaceChildren(...entries.map(([key, label]) => el("div", { class: "row gap" },
      el("span", { class: "grow" }, label),
      el("button", { class: "akey sm", type: "button", onclick: () => {
        const value = prompt(`「${label}」改名為：`, key && scope === "folder" ? key : label);
        if (value !== null) run(() => changeCategory(scope, key, value));
      } }, "改名"),
      el("button", { class: "akey sm red", type: "button", onclick: () => {
        const detail = scope === "folder" ? "裡面的片段會移到未分類，內容保留。" : "只移除分類，裡面的資產仍可在「全部」找到。";
        if (confirm(`移除「${label}」？\n${detail}`)) run(() => changeCategory(scope, key, null));
      } }, "刪除"))));
    if (!entries.length) rows.append(el("span", { class: "muted sm" }, "尚無分類"));
  };
  const add = () => run(() => {
    if (scope === "main") addCategory(name.value, type.value);
    else {
      const value = categoryName(name.value, 50);
      if (folderNames().includes(value)) throw new Error("已有同名分類");
      savedFolders.push(value);
      snippetFolder = value;
      keepCategories();
      paint();
    }
    name.value = "";
  });
  modal.append(el("div", { class: "dialog" },
    el("div", { class: "row between" }, el("b", {}, scope === "main" ? "管理資產分類" : "管理片段子分類"), close),
    el("p", { class: "muted sm" }, scope === "main" ? "新增分類時選擇資產類型；已有資產可在編輯區更改分類，片段可加入同名標籤。分類欄設定保存在目前瀏覽器。" : "新增、改名或移除子分類；移除時保留片段內容。空分類也會記住。"),
    rows, el("div", { class: "row gap wrap" }, name, type, el("button", { class: "akey sm go", type: "button", onclick: add }, "＋ 新增分類")),
    scope === "main" ? el("button", { class: "akey sm", type: "button", onclick: () => run(() => {
      for (const [id, label] of KINDS) if (!categoryOf(id)) categories.push({ id, name: label, kind: id });
      keepCategories(); updateCategoryOptions(); paint();
    }) }, "補回已移除的內建分類") : null));
  document.body.append(modal);
  render();
  name.focus();
}

// ---------------------------------------------------------------- 左邊：分類、搜尋、卡片
function paintKinds() {
  const box = F("asKinds");
  const count = (k) => items.filter((x) => inCategory(x, k)).length;
  
  const mainChips = [["all", "全部"], ...categories.map((c) => [c.id, c.name])].map(([k, name]) =>
    el("button", {
      class: "chip" + (kind === k ? " on" : ""),
      type: "button",
      role: "tab",
      "aria-selected": String(kind === k),
      onclick: () => {
        kind = k;
        if (backendKind(k) !== "snippet") snippetFolder = null;
        paint();
      }
    }, name, ` ${count(k)}`)
  );

  const elements = [el("div", { class: "row wrap gap as-main-kinds" }, ...mainChips,
    el("button", { class: "akey sm", type: "button", onclick: () => manageCategories("main") }, "管理分類"))];

  if (backendKind(kind) === "snippet") {
    const snippetItems = items.filter((x) => inCategory(x, kind));
    const countFolder = (f) => f === null ? snippetItems.length : snippetItems.filter((x) => (x.folder || "") === f).length;
    const knownFolders = SNIPPET_FOLDERS.map(([k]) => k);
    const allFoundFolders = new Set(folderNames());
    const folderList = [
      null, "",
      ...knownFolders.filter((f) => allFoundFolders.has(f) || countFolder(f) > 0),
      ...[...allFoundFolders].filter((f) => !knownFolders.includes(f))
    ];

    const subChips = folderList.map((f) =>
      el("button", {
        class: "chip sm as-sub-chip" + (snippetFolder === f ? " on" : ""),
        type: "button",
        role: "tab",
        "aria-selected": String(snippetFolder === f),
        onclick: () => {
          snippetFolder = f;
          paint();
        }
      }, (f === null ? "全部片段" : f === "" ? "未分類" : folderLabel(f)), ` ${countFolder(f)}`)
    );

    elements.push(el("div", {
      class: "row wrap gap as-sub-kinds",
      style: "width: 100%; padding: 4px 6px; margin-top: 4px; background: rgba(0,0,0,0.06); border-radius: 6px; align-items: center;"
    }, el("span", { class: "muted sm", style: "margin-right: 4px; font-weight: bold;" }, "片段子选项："), ...subChips,
    el("button", { class: "akey sm", type: "button", onclick: () => manageCategories("folder") }, "管理子分類")));
  }

  box.replaceChildren(...elements);
}

const hay = (it) => [it.name, it.folder, ...(it.tags || []), it.note, it.data?.look_zh, it.data?.look_en, it.data?.text, it.data?.prompt,
  ...(it.data?.tags_anima || [])].join("\n").toLowerCase();

function paint() {
  paintKinds();
  const q = F("asQ").value.trim().toLowerCase();
  const shown = items.filter((x) => {
    return inCategory(x, kind) && (backendKind(kind) !== "snippet" || snippetFolder === null || (x.folder || "") === snippetFolder);
  }).filter((x) => !q || hay(x).includes(q));

  F("asTotal").textContent = shown.length ? String(shown.length) : "";
  const g = F("asGrid");
  g.replaceChildren(...shown.map((it) => el("div", { class: "card pick as-card" + (cur?.id === it.id ? " on" : ""), onclick: () => open(it) },
    el("div", { class: "ph", style: thumbUrl(it) ? `background-image:url("${thumbUrl(it)}")` : undefined }, thumbUrl(it) ? "" : KIND_NAME[it.kind] || it.kind),
    el("div", { class: "bd" },
      el("div", { class: "t" }, (it.fav ? "★ " : "") + it.name),
      el("div", { class: "row wrap as-tags" }, el("span", { class: "badge-s" }, KIND_NAME[it.kind] || it.kind),
        it.folder ? el("span", { class: "badge-s muted" }, it.folder) : "",
        ...(it.tags || []).slice(0, 3).map((t) => el("span", { class: "muted sm" }, "#" + t)))))));
  if (!shown.length) g.append(el("div", { class: "muted sm pad" }, items.length ? "沒有符合的資產" : "還沒有資產：按右上「＋ 新增」"));
}

// ---------------------------------------------------------------- 右邊：編輯區
function open(it) {
  if (busy) return;
  if (!MEDIA.has(it.kind)) return library.edit(it);  // 整套設定、片段：沿用提示詞庫的編輯窗
  cur = structuredClone(it);
  fill();
}

function newOne() {
  if (busy || managing) return;
  const k = backendKind(kind), tags = categoryOf(kind)?.tag ? [categoryOf(kind).tag] : [];
  if (k === "set") return library.saveDialog({ kind: "set", tags });
  if (k === "snippet") {
    return library.saveDialog({ kind: "snippet", folder: snippetFolder || "", tags });
  }
  cur = { id: null, kind: VALID_MEDIA_KINDS.has(k) ? k : "char", name: "", folder: "", tags, fav: 0, note: "", data: {} };
  fill();
  F("asName").focus();
}

function fill() {
  F("asEmpty").hidden = !!cur;
  F("asForm").hidden = !cur;
  if (!cur) return paint();
  const d = cur.data || {};
  F("asName").value = cur.name || "";
  const k = cur.kind;
  F("asKind").value = categories.find((c) => c.kind === k && c.tag && cur.tags?.includes(c.tag))?.id || (VALID_BACKEND_KINDS.has(k) ? k : "char");
  F("asFolder").value = cur.folder || "";
  F("asLabels").value = (cur.tags || []).join(", ");
  F("asFav").checked = !!cur.fav;
  F("asLookZh").value = d.look_zh || "";
  F("asLookEn").value = d.look_en || "";
  F("asAnima").value = (d.tags_anima || []).join(", ");
  F("asVoice").value = d.voice || "";
  F("asLang").value = d.lang || "";
  F("asText").value = d.text || "";
  F("asNote").value = cur.note || "";
  for (const [key] of LAYOUT) F("asL_" + key).value = d.layout?.[key] || "";
  F("asUnver").hidden = true;
  F("asDel").hidden = !cur.id;
  paintImgs();
  paintAudio();
  paintCard();
  byKind();
  paint();
}

/** 分類不同，顯示的欄位不同 */
function byKind() {
  const k = backendKind(F("asKind").value);
  F("asCharBox").hidden = k !== "char";
  F("asSheetGo").hidden = k !== "char" || !cur?.id;
  F("asSceneBox").hidden = k !== "scene";
  F("asTextBox").hidden = !TEXT_KINDS.has(k);
  F("asShotNote").hidden = k !== "shot";
}

function paintImgs() {
  const box = F("asImgs");
  const imgs = cur.data?.images || [];
  box.replaceChildren(...imgs.map((im) => el("div", { class: "as-img" },
    el("img", { src: fileUrl(im.file), alt: "", loading: "lazy" }),
    el("select", { "aria-label": "用途", onchange: (e) => { im.role = e.target.value; } },
      ...ROLES.map(([r, name]) => el("option", { value: r, selected: im.role === r }, name))),
    el("button", { class: "akey sm", type: "button", title: "拿掉這張（搬到待刪除）", onclick: () => removeFile(im.file) }, "拿掉"))));
  if (!imgs.length) box.append(el("div", { class: "muted sm" }, "還沒有圖片"));
}

/** 角色卡狀態：四樣東西有沒有；設定表鎖住時顯示固定文字（唯讀，要改去工坊解鎖） */
export function cardState(d) {
  const has = (role) => (d?.images || []).some((im) => im.role === role);
  const sp = d?.spec;
  return [
    ["多視圖", has("sheet")], ["正面特寫", has("portrait")],
    ["設定表", sp?.locked ? "locked" : sp && Object.values(sp.fields || {}).some((f) => f?.zh || f?.en) ? "open" : false],
    ["RefMod", !!d?.refmod?.file],
  ];
}

function paintCard() {
  const d = cur.data || {};
  const word = (v) => (v === "locked" ? "🔒 已鎖定" : v === "open" ? "寫了還沒鎖" : v ? "✓ 有" : "— 還沒有");
  const sp = d.spec;
  const canMod = cur.kind === "char" && (d.images || []).length;
  F("asCard").replaceChildren(
    el("div", { class: "row wrap gap as-card-state" }, ...cardState(d).map(([name, v]) => el("span", { class: "chip" + (v ? " on" : "") }, `${name}：${word(v)}`))),
    sp?.locked ? el("div", { class: "cs-spec-block" }, el("div", {}, sp.block_zh), el("div", {}, sp.block_en), el("div", { class: "muted" }, sp.block_tags)) : "",
    canMod ? el("div", { class: "row wrap gap" },
      el("button", { class: "akey sm", type: "button", onclick: makeRefmod,
        title: "用本機 ComfyUI 把正面特寫編成 H3 的 RefMod（只用 H3 影片 VAE，幾十秒）；拍攝單勾「用 RefMod 鎖臉」時，H3 拍片會接上它" },
        d.refmod?.file ? "重做 RefMod" : "做 RefMod"),
      el("span", { class: "muted sm" }, d.refmod?.file ? `已做：${d.refmod.name}` : "RefMod（實驗）：正面特寫編成 H3 的固定參考，拍片鎖臉用")) : "");
}

/** 做 RefMod：本機沒有外掛就問要不要裝（裝完要重開 ComfyUI），有了就做 */
async function makeRefmod() {
  if (!cur?.id) return toast("先存這個角色", "err");
  let st;
  try { st = await api("/api/refmod/status"); } catch (e) { return toast(e.message, "err"); }
  if (!st.online) return toast("本機的 ComfyUI 沒有連線", "err");
  if (!st.loaded) {
    if (!st.installed) {
      if (!confirm(`做 RefMod 要先在本機 ComfyUI 裝外掛 ComfyUI-MiniMaxH3Mod（繪匣審過的版本 ${st.commit.slice(0, 7)}，只用 torch／numpy／Pillow，不連網）。\n要裝嗎？裝完要重開 ComfyUI。`)) return;
      try { await api("/api/refmod/install", { json: {}, timeout: 10 * 60 * 1000 }); } catch (e) { return toast(e.message, "err"); }
    }
    if (!confirm("RefMod 外掛裝好了，要重開 ComfyUI 才會載入。現在重開嗎？（正在跑的工作會中斷）")) return toast("之後重開 ComfyUI，再按一次「做 RefMod」", "ok");
    try { await api("/api/models/restart_comfy", { json: {} }); } catch (e) { return toast(e.message, "err"); }
    return toast("ComfyUI 重開中：等狀態列變綠，再按一次「做 RefMod」", "ok");
  }
  return editAction(async () => {
    const it = await saveCurrent(true);
    if (!it) return;
    toast("做 RefMod 中…（本機 ComfyUI，第一次要載入 H3 影片 VAE）", "ok");
    cur = await api(`/api/assets/${it.id}/refmod`, { json: {}, timeout: 16 * 60 * 1000 });
    const i = items.findIndex((x) => x.id === cur.id);
    if (i >= 0) items[i] = cur;
    toast(`RefMod 做好了：${cur.data?.refmod?.name || ""}`, "ok");
  });
}

function paintAudio() {
  const a = cur.data?.audio?.file;
  F("asAudio").replaceChildren(a ? el("audio", { src: fileUrl(a), controls: true, preload: "none" }) : el("span", { class: "muted sm" }, "沒有音檔"));
  F("asAudioDel").hidden = !a;
}

/** 表單 → 送出的內容（圖片、音檔沿用 cur 裡的，用途可能剛改過） */
function collect() {
  const selected = categoryOf(F("asKind").value);
  let k = backendKind(F("asKind").value);
  let folder = F("asFolder").value.trim();
  const d = { ...(cur.data || {}) };
  Object.assign(d, { look_zh: F("asLookZh").value, look_en: F("asLookEn").value, tags_anima: splitList(F("asAnima").value) });
  if (k === "char") Object.assign(d, { voice: F("asVoice").value, lang: F("asLang").value });
  if (k === "scene") d.layout = Object.fromEntries(LAYOUT.map(([key]) => [key, F("asL_" + key).value]));
  if (TEXT_KINDS.has(k)) d.text = F("asText").value;

  if (!VALID_BACKEND_KINDS.has(k)) {
    k = "char";
  }

  if (k === "snippet" && !d.text) {
    d.text = d.tags_anima?.join(", ") || F("asName").value.trim() || "-";
  }

  const tags = splitList(F("asLabels").value).filter((t) => !categories.some((c) => c.tag === t && c.kind === cur.kind && c.id !== selected?.id));
  if (selected?.tag && !tags.includes(selected.tag)) tags.unshift(selected.tag);
  return { id: cur.id || undefined, kind: k, name: F("asName").value.trim(), folder,
    tags, fav: F("asFav").checked, note: F("asNote").value.trim(), data: d };
}

/** 存檔；quiet＝加檔之前順手存（不跳成功提示）。回傳存好的那筆，失敗回 null */
async function save(quiet = false) {
  return editAction(() => saveCurrent(quiet));
}

async function saveCurrent(quiet = false) {
  const body = collect();
  if (!body.name) {
    if (quiet) {
      body.name = "未命名资产";
      F("asName").value = body.name;
    } else {
      F("asName").focus();
      toast("資產要有名字", "err");
      return null;
    }
  }
  try {
    const r = await api("/api/lib", { json: body });
    cur = r;
    const i = items.findIndex((x) => x.id === r.id);
    if (i >= 0) items[i] = r; else items.unshift(r);
    // 寫入時表單仍是同一筆，不重建控制項，避免解除操作中的停用狀態。
    F("asDel").hidden = false;
    paint();
    if (!quiet) toast(`已存好：${r.name}`, "ok");
    return r;
  } catch (e) { toast(e.message, "err"); return null; }
}

function showUnverified(list) {
  const box = F("asUnver");
  box.hidden = !list.length;
  box.replaceChildren(el("span", {}, "這些 tag 在 tag 表裡找不到（照樣存了，確定要用再留）："),
    ...list.map((t) => el("span", { class: "as-bad" }, t)));
}

/** 加一個檔（圖片或音檔）：先存表單（新的才有 id），再請後端複製進資產資料夾 */
async function attach(it, body) {
  const r = await api(`/api/assets/${it.id}/file`, { json: body });
  cur = r;
  const i = items.findIndex((x) => x.id === r.id);
  if (i >= 0) items[i] = r;
}

async function addFile(body, target = cur) {
  if (cur !== target) return;
  if (!F("asName").value.trim()) {
    F("asName").value = "未命名资产";
  }
  return editAction(async () => {
    const it = await saveCurrent(true);
    if (it) await attach(it, body);
  });
}

async function removeFile(file) {
  if (!cur?.id) return;
  return editAction(async () => {
    const it = await saveCurrent(true);
    if (!it) return;
    cur = await api(`/api/assets/${it.id}/file/remove`, { json: { file } });
    const i = items.findIndex((x) => x.id === cur.id);
    if (i >= 0) items[i] = cur;
  });
}

const fileB64 = (file) => new Promise((ok, no) => {
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).split(",")[1] || "");
  fr.onerror = () => no(new Error("讀不到這個檔案"));
  fr.readAsDataURL(file);
});

/** 音檔：走 H3 影片台的上傳（會轉成 wav 放進 ComfyUI input），再加進資產 */
function pickAudio() {
  if (busy || !cur) return;
  const target = cur;
  const inp = el("input", { type: "file", accept: "audio/*,.mp3,.wav,.flac,.ogg,.m4a", hidden: true });
  inp.onchange = async () => {
    const f = inp.files[0];
    inp.remove();
    if (!f || cur !== target) return;
    if (!F("asName").value.trim()) {
      const autoName = (f.name || "").replace(/\.[^/.]+$/, "").trim() || "未命名资产";
      F("asName").value = autoName;
    }
    await editAction(async () => {
      const it = await saveCurrent(true);
      if (!it) return;
      const r = await api("/api/h3/media", { json: { file_name: f.name, data_b64: await fileB64(f) }, timeout: 10 * 60 * 1000 });
      if (r.kind !== "audio") throw new Error("這個檔案不是聲音");
      await attach(it, { input: r.name, role: "audio" });
    });
  };
  inp.oncancel = () => inp.remove();
  document.body.append(inp);
  inp.click();
}

async function del() {
  if (busy) return;
  if (!cur?.id || !confirm(`把「${cur.name}」移到待刪除？\n圖片、音檔和資料會搬到資料夾的 待刪除\\資產庫，不會真的刪掉。`)) return;
  return editAction(async () => {
    await api(`/api/lib/${cur.id}`, { method: "DELETE" });
    items = items.filter((x) => x.id !== cur.id);
    cur = null;
    toast("已移到待刪除", "ok");
  });
}

export function init() {
  const saved = store.get("assetCategories", null);
  if (Array.isArray(saved)) categories = saved.filter((c) => c && typeof c.id === "string" && typeof c.name === "string" && VALID_BACKEND_KINDS.has(c.kind) && (!c.tag || typeof c.tag === "string"));
  savedFolders = store.get("assetSnippetFolders", []);
  if (!Array.isArray(savedFolders)) savedFolders = [];
  savedFolders = savedFolders.filter((f) => typeof f === "string" && f);
  for (const c of categories) if (!c.tag) KIND_NAME[c.id] = c.name;
  F("asKind").replaceChildren(...categoryOptions());
  F("asRole").replaceChildren(...ROLES.map(([r, name]) => el("option", { value: r }, "新圖片用途：", name)));
  F("asLayout").replaceChildren(...LAYOUT.map(([k, name]) => el("label", {}, el("span", { class: "sub" }, name), el("input", { type: "text", id: "asL_" + k }))));
  F("asKind").onchange = byKind;
  F("asQ").oninput = paint;
  F("asNew").onclick = newOne;
  F("asSave").onclick = () => save();
  F("asDel").onclick = del;
  F("asImgUp").onclick = async () => {
    if (busy || !cur) return;
    const target = cur, role = F("asRole").value;
    const f = await pickFile();
    if (!f || cur !== target) return;
    if (!F("asName").value.trim()) {
      const autoName = (f.name || "").replace(/\.[^/.]+$/, "").trim() || "未命名资产";
      F("asName").value = autoName;
    }
    await editAction(async () => {
      const it = await saveCurrent(true);
      if (!it) return;
      const r = await uploadFile(f);
      await attach(it, { input: r.name, role });
    });
  };
  // 角色設定圖工坊：做完存回這個角色，再重讀這一筆
  F("asSheetGo").onclick = async () => {
    if (!cur?.id) return;
    const id = cur.id;
    (await import("./charsheet.js")).open({ asset: cur, onSaved: async () => { await load(); const it = items.find((x) => x.id === id); if (it) open(it); } });
  };
  F("asImgGal").onclick = () => {
    if (busy || !cur) return;
    const target = cur, role = F("asRole").value;
    pickFromGallery((rec) => {
      if (!F("asName").value.trim()) {
        const autoName = (rec.name || rec.filename || "").replace(/\.[^/.]+$/, "").trim() || "未命名资产";
        F("asName").value = autoName;
      }
      addFile({ gallery_id: rec.id, role }, target);
    });
  };
  F("asAudioUp").onclick = pickAudio;
  // 「存成資產」小視窗
  F("asSaveKind").replaceChildren(...KINDS.filter(([k]) => k !== "shot").map(([k, name]) => el("option", { value: k }, name)));
  F("asSaveRole").replaceChildren(...ROLES.map(([r, name]) => el("option", { value: r }, name)));
  $$("input[name=asSaveTo]").forEach((r) => (r.onchange = syncSaveTo));
  F("asAudioDel").onclick = () => { const a = cur?.data?.audio?.file; if (a) removeFile(a); };
  // 提示詞庫的編輯窗存好、刪掉之後（lib-updated），或設定匯入之後（lib-changed），這邊跟著重讀
  for (const ev of ["lib-updated", "lib-changed"]) document.addEventListener(ev, () => { if (loaded) load(); });
}

/** 圖庫、燈箱、生成結果的「存成資產」：小視窗二選一（新資產／加到現有資產），圖由後端從圖庫複製（只收使用者自己選的這張） */
export async function saveFromGallery(rec) {
  await list();
  const media = items.filter((x) => MEDIA.has(x.kind) && x.kind !== "shot");
  F("asSaveTarget").replaceChildren(...media.map((x) => el("option", { value: x.id }, KIND_NAME[x.kind], `・${x.name}`)));
  F("asSaveName").value = "";
  const old = $("input[name=asSaveTo][value=old]");
  old.disabled = !media.length;
  $(`input[name=asSaveTo][value=new]`).checked = true;
  syncSaveTo();
  openModal("#asSaveModal");
  F("asSaveName").focus();
  F("asSaveGo").onclick = async () => {
    if (busy) return;
    const toOld = old.checked;
    const role = F("asSaveRole").value;
    const name = F("asSaveName").value.trim();
    if (!toOld && !name) { F("asSaveName").focus(); return toast("新資產要有名字", "err"); }
    F("asSaveGo").disabled = true;
    try {
      const rawKind = F("asSaveKind").value;
      const kind = VALID_BACKEND_KINDS.has(rawKind) ? rawKind : "char";
      const folder = VALID_BACKEND_KINDS.has(rawKind) ? "" : rawKind;
      const id = toOld ? +F("asSaveTarget").value : (await api("/api/lib", { json: { kind, folder, name, data: {} } })).id;
      const r = await api(`/api/assets/${id}/file`, { json: { gallery_id: rec.id, role } });
      closeModal("#asSaveModal");
      await load();
      // 這個小視窗也可能從別頁開啟；只同步檔案，不蓋掉編輯區未儲存的文字／用途。
      if (!busy && cur?.id === r.id) {
        const roles = new Map((cur.data.images || []).map((im) => [im.file, im.role]));
        cur.data.images = (r.data.images || []).map((im) => ({ ...im, role: roles.get(im.file) || im.role }));
        cur.data.audio = r.data.audio;
        paintImgs(); paintAudio();
      }
      toast(`已存進資產庫：${KIND_NAME[r.kind]}「${r.name}」（${r.data.images?.length || 0} 張圖）`, "ok");
    } catch (e) { toast(e.message, "err"); } finally { F("asSaveGo").disabled = false; }
  };
}

function syncSaveTo() {
  const toOld = $("input[name=asSaveTo][value=old]").checked;
  F("asSaveNew").hidden = toOld;
  F("asSaveOld").hidden = !toOld;
}
