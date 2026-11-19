// LoRA 管理器（內嵌 ComfyUI-Lora-Manager 獨立頁面）與生圖卡匣挑選視窗
import { $, el, api, toast, openModal, closeModal, debounce, store, pickFile, makeDrop } from "./util.js";
import { app } from "./state.js";

const LM_ORIGIN = "http://127.0.0.1:8188";
const LM_PAGE_URL = `${LM_ORIGIN}/loras`;

let list = [];
let pickCb = null;
let pickFam = null;
let pickAll = false;
let pickShown = 0;
let shown = 0;
// 卡片／列表兩種排法（2026-11-17 網友：「或者是列表化选择」）：LoRA 庫和挑選視窗各記各的
const view = { page: store.get("lora_view", "grid"), pick: store.get("lora_pick_view", "grid") };
const PAGE = 60;
let pickerTab = "single"; // "single" | "recipe"

let lmOnline = false;
let lmLoaded = false;
let lmRecipes = [];
let lmMetaSynced = false;

const KIND_ZH = { style: "畫風", character: "角色", clothing: "服裝", concept: "概念", pose: "姿勢", detail: "細節", lighting: "光影", other: "其他" };
const KINDS = Object.entries(KIND_ZH);

export function init() {
  // ComfyUI-Lora-Manager 離線重試
  $("#lmRetryBtn")?.addEventListener("click", () => {
    lmLoaded = false;
    showPage();
  });

  // 跨窗口消息通信 (Bridge): 接收從 ComfyUI-Lora-Manager 發來的動作
  window.addEventListener("message", async (e) => {
    if (e.origin && !e.origin.includes("127.0.0.1") && !e.origin.includes("localhost")) return;

    if (e.data?.type === "PAINTDECK_LM_READY") {
      lmOnline = true;
      console.log("[PaintDeck] ComfyUI-Lora-Manager bridge confirmed ready");
    } else if (e.data?.type === "PAINTDECK_INSERT_LORA") {
      const canonical = resolveCanonicalLora(e.data.name);
      const loraName = canonical?.name || (e.data.name.endsWith(".safetensors") || e.data.name.endsWith(".pt") ? e.data.name : `${e.data.name}.safetensors`);
      const title = canonical?.title || e.data.title || e.data.name;

      let triggers = Array.isArray(e.data.triggers) ? e.data.triggers : [];
      if ((!triggers || !triggers.length) && canonical?.triggers?.length) {
        triggers = canonical.triggers;
      }

      const flatTriggers = (Array.isArray(triggers) ? triggers : [triggers])
        .flatMap((x) => (typeof x === "string" ? x.split(",") : []))
        .map((s) => s.trim())
        .filter(Boolean);

      const gen = await import("./gen.js");
      gen.addLora({
        name: loraName,
        strength: 1.0,
        title: title,
        triggers: flatTriggers
      });
      app.showPage("gen");
      toast(`已將「${title}」加入生圖卡匣！`, "ok");
    } else if (e.data?.type === "PAINTDECK_LM_RECIPES") {
      if (Array.isArray(e.data.recipes)) {
        lmRecipes = e.data.recipes;
        if (pickerTab === "recipe") renderRecipePicker();
      }
    } else if (e.data?.type === "PAINTDECK_APPLY_RECIPE") {
      const gen = await import("./gen.js");
      gen.applyLoraRecipe({
        name: e.data.recipeName || "LoRA 配方",
        loras: (e.data.loras || []).map((x) => ({
          name: x.name.endsWith(".safetensors") || x.name.endsWith(".pt") ? x.name : `${x.name}.safetensors`,
          strength: 1.0,
          title: x.title || x.name,
          triggers: x.triggers || []
        }))
      });
      app.showPage("gen");
    }
  });

  // 挑選視窗搜尋與篩選事件
  $("#lpQ")?.addEventListener("input", debounce(() => { pickShown = 0; renderPicker(); }, 150));
  $("#lpFolder")?.addEventListener("change", () => { pickShown = 0; renderPicker(); });

  // 挑選視窗 Tab 切換 (單個 LoRA / 配方組)
  $("#lpTabs")?.addEventListener("click", (e) => {
    const pill = e.target.closest(".pill");
    if (!pill) return;
    $("#lpTabs").querySelectorAll(".pill").forEach((p) => p.classList.remove("on"));
    pill.classList.add("on");
    pickerTab = pill.dataset.tab || "single";
    pickShown = 0;
    const folderSel = $("#lpFolder");
    if (folderSel) folderSel.style.display = pickerTab === "recipe" ? "none" : "";
    renderPicker();
  });
  const lmTools = $("#lmTools"), lmOpenBtn = $("#lmOpenBtn");
  const syncLmToggle = () => lmOpenBtn?.setAttribute("aria-expanded", String(!!lmTools?.open));
  lmOpenBtn?.addEventListener("click", () => {
    if (!lmTools) return;
    lmTools.open = !lmTools.open;
    syncLmToggle();
    if (lmTools.open) showPage();
  });
  lmTools?.addEventListener("toggle", () => {
    syncLmToggle();
    if (lmTools.open) showPage();
  });
  $("#loraQ")?.addEventListener("input", debounce(() => renderPage(true), 150));
  for (const id of ["#loraFamily", "#loraCategory", "#loraTag", "#loraFav"]) $(id)?.addEventListener("change", () => renderPage(true));
  $("#loraMore")?.addEventListener("click", () => renderPage(false));
  $("#loraLearn")?.addEventListener("click", () => $("#assistBtn")?.click());
  $("#loraRefresh")?.addEventListener("click", async () => { await app.refreshState(); toast("已重新整理", "ok"); });
  $("#loraView")?.addEventListener("click", () => { view.page = view.page === "list" ? "grid" : "list"; store.set("lora_view", view.page); renderPage(true); });
  $("#lpView")?.addEventListener("click", () => { view.pick = view.pick === "list" ? "grid" : "list"; store.set("lora_pick_view", view.pick); pickShown = 0; renderPicker(); });
  initPreviewDialog();
}

// 切換鈕寫「現在按下去會變成什麼」
function syncViewBtn(btn, mode, box) {
  btn.textContent = mode === "list" ? "▦ 卡片" : "☰ 列表";
  btn.title = mode === "list" ? "改回大卡片（看得到大預覽圖）" : "改成一行一個的列表（一次看比較多）";
  box.classList.toggle("as-list", mode === "list");
}

export function onState(st) {
  list = (st.models?.loras || []).slice().sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || (a.title || a.name).localeCompare(b.title || b.name));
  if (app.page === "loras") {
    fillFilters();
    renderPage(true);
    showPage();
  }
}

// ---------------------------------------------------------------- 全屏管理頁面
export function showPage() {
  const frame = $("#loraManagerFrame");
  const offline = $("#loraManagerOffline");
  if (!frame || !offline) return;
  if (!$("#lmTools")?.open) return;

  const isOnline = app.state?.online !== false;

  if (isOnline) {
    offline.hidden = true;
    frame.hidden = false;
    if (!lmLoaded || frame.src === "about:blank" || !frame.src.startsWith(LM_ORIGIN)) {
      frame.src = LM_PAGE_URL;
      lmLoaded = true;
    }
  } else {
    offline.hidden = false;
    frame.hidden = true;
  }
}

// ---------------------------------------------------------------- 同步 Lora-Manager 豐富資料
async function syncLmData() {
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 3500);

    // 1. 同步配方
    const rRes = await fetch(`${LM_ORIGIN}/api/lm/recipes`, { signal: ctrl.signal }).catch(() => null);
    if (rRes?.ok) {
      const rData = await rRes.json();
      lmRecipes = rData.items || [];
    }

    // 2. 同步 LoRA 預覽圖與觸發詞
    let page = 1;
    let items = [];
    while (page <= 5) {
      const resp = await fetch(`${LM_ORIGIN}/api/lm/loras/list?page=${page}&page_size=100`, { signal: ctrl.signal }).catch(() => null);
      if (!resp?.ok) break;
      const data = await resp.json();
      if (!data.items?.length) break;
      items.push(...data.items);
      if (items.length >= (data.total || 0)) break;
      page++;
    }
    clearTimeout(tm);

    if (items.length) {
      const map = new Map();
      for (const it of items) {
        if (it.file_name) map.set(it.file_name.toLowerCase(), it);
      }

      for (const l of list) {
        const b = baseName(l.name).toLowerCase();
        const found = map.get(b);
        if (found) {
          if (!l.preview && !l.local_preview && found.preview_url) {
            l.lm_preview_url = found.preview_url;
          }
          if ((!l.triggers || !l.triggers.length) && found.civitai?.trainedWords?.length) {
            l.triggers = found.civitai.trainedWords;
          }
          if (found.folder && !l.folder) {
            l.folder = found.folder;
          }
          if (found.model_name && !l.title) {
            l.title = found.model_name;
          }
        }
      }
      lmMetaSynced = true;
      if (!$("#loraPicker")?.hidden) renderPicker();
    }
  } catch (err) {
    console.warn("syncLmData error:", err);
  }
}

export function resolveCanonicalLora(inputName) {
  if (!inputName) return null;
  const pool = [...(app.state?.models?.loras || []), ...(list || [])];
  const norm = (s) => (s || "").replace(/\\/g, "/").toLowerCase();
  const base = (s) => norm(s).split("/").pop().replace(/\.(safetensors|pt|bin|ckpt)$/i, "");
  const inNorm = norm(inputName);
  const inBase = base(inputName);

  let found = pool.find((x) => norm(x.name) === inNorm || norm(x.name) === `${inNorm}.safetensors` || norm(x.name).endsWith(`/${inNorm}`) || norm(x.name).endsWith(`/${inNorm}.safetensors`));
  if (found) return found;

  found = pool.find((x) => base(x.name) === inBase);
  if (found) return found;

  return null;
}

export function getLoraInfo(inputName) {
  return resolveCanonicalLora(inputName);
}

const baseName = (name) => (name || "").replace(/\\/g, "/").split("/").pop().replace(/\.(safetensors|pt|bin|ckpt)$/i, "");
const title = (l) => l.title || baseName(l.name);
const famName = (l) => app.state?.models?.family_names?.[l.family] || "";
// 卡片的底模小標和「模型」篩選：照站上判斷的家族分組，名稱用 Civitai 的寫法（2026-10-28 使用者：同一個底模出現「Anima」「Anima（動漫）」、「MOSS」「MOSS Image」兩個選項）
const FAM_LABEL = { anima: "Anima", moss: "MOSS Image", qwen21: "Qwen 2.1", sdxl: "SDXL", sd15: "SD1.5", flux: "Flux", sd3: "SD3" };
const tagsOf = (l) => (Array.isArray(l.tags) ? l.tags.filter((x) => typeof x === "string" && x.trim()) : []);
const categoryOf = (l) => {
  if (l.category) return l.category;
  if (KIND_ZH[l.agent?.kind] && l.agent?.kind !== "other") return l.agent.kind;
  const words = (tagsOf(l).join(" ") + " " + title(l) + " " + (l.agent?.desc_zh || l.agent?.desc || "")).toLowerCase();
  const clues = [
    ["character", /character|人物|角色|chara|cosplay/],
    ["clothing", /clothing|outfit|costume|fashion|服裝|服饰|衣服/],
    ["pose", /pose|姿勢|姿势|動作|动作/],
    ["lighting", /lighting|light effect|光影|燈光|灯光/],
    ["style", /style|artstyle|畫風|画风|aesthetic|anime style/],
    ["detail", /detail|texture|細節|细节|材質|材质/],
    ["concept", /concept|subject|object|背景|場景|场景/],
  ];
  return clues.find(([, re]) => re.test(words))?.[0] || l.agent?.kind || "";
};
const categoryLabel = (c) => KIND_ZH[c] || c || "未分類";
const modelLabel = (l) => FAM_LABEL[l.family] || l.base_model || "其他";
const match = (l, q) =>
  !q ||
  (
    title(l) + " " +
    modelLabel(l) + " " +
    l.name + " " +
    (l.triggers || []).join(" ") + " " +
    tagsOf(l).join(" ") + " " +
    categoryLabel(categoryOf(l)) + " " +
    (l.note || "") + " " +
    (l.agent?.desc_zh || "") + " " +
    (l.agent?.desc || "")
  ).toLowerCase().includes(q.toLowerCase());

// 生圖助手對這個 LoRA 的認識（agent.rs 的 parse_lora_desc 寫進 lora_meta.agent）
function agentDesc(l) {
  const a = l.agent;
  if (!a?.desc) return null;
  return el("div", { class: "agent-desc", title: (a.src === "user" ? "你寫的" : a.src === "probe" ? "助手試畫比較後寫的" : "助手讀線索寫的") + "（給助手挑 LoRA 用）\n" + a.desc },
    el("span", { class: "ag-kind" + (a.sure === false ? " unsure" : "") }, "助手：" + (KIND_ZH[a.kind] || a.kind || "其他") + (a.sure === false ? "？" : "")), a.desc_zh || a.desc);
}
// 預覽圖的順序：自己下載／抓過存的 → 模型旁邊的同名圖 → 程式附的封面縮圖（cover_file，2026-11-08：不用連網）
// 換過的預覽圖檔名不變（custom_<雜湊>.jpg），用 preview_t 讓瀏覽器重抓
const previewUrl = (l) => l.lm_preview_url
  ? `${l.lm_preview_url.startsWith("http") ? "" : LM_ORIGIN}${l.lm_preview_url}`
  : l.preview ? `/lora_preview/${encodeURIComponent(l.preview)}` + (l.preview_t ? `?v=${Math.round(l.preview_t)}` : "")
  : l.local_preview ? `/api/loras/local-preview?name=${encodeURIComponent(l.name)}`
  : l.cover_file ? `/api/loras/bundled-cover/${encodeURIComponent(l.cover_file)}` : "";
const preview = (l) => previewUrl(l) ? `url("${previewUrl(l)}")` : "";
// 模糊成人預覽圖：LoRA 標成人的，或封面那張圖 C 站的尺度等級大於 1（同下載中心的 cover_nsfw）
const blurOf = (l) => !!app.state?.settings?.blur_nsfw && (!!l.nsfw || (l.preview_nsfw ?? l.cover_nsfw ?? 1) > 1);

// 卡片上方的圖：有圖用 <img>（載不出來換成寫著名字的替代卡）；還在抓封面的先寫名字＋「正在抓封面…」（2026-11-07：預載的 LoRA 整片黑不好找）
function ph(l, attrs = {}) {
  const box = el("div", { class: "ph", "data-lora": l.name, ...attrs });
  fillPh(box, l);
  return box;
}
function fillPh(box, l) {
  const url = previewUrl(l);
  const noImg = (waiting) => [el("div", { class: "ph-name" }, title(l)), el("div", { class: "ph-note" }, waiting ? "正在抓封面…" : "沒有預覽圖")];
  box.classList.toggle("blur", blurOf(l));
  if (!url) return box.replaceChildren(...noImg(l.cover && !l.coverFailed));
  const img = el("img", { class: "ph-img", src: url, loading: "lazy", alt: "" });
  img.onerror = () => box.replaceChildren(...noImg(false));
  box.replaceChildren(img);
}
// 沒預覽圖、抓得到封面的（/api/state 的 cover）：後端在背景抓，抓完廣播 lora_cover（main.js 轉給 onCover）
const coverAsked = new Set();
const COVER_WAIT = 120000;
function askCovers(items) {
  const names = items.filter((l) => l.cover && !l.preview && !coverAsked.has(l.name)).map((l) => l.name);
  if (!names.length) return;
  for (const n of names) coverAsked.add(n);
  api("/api/loras/covers", { json: { names } }).catch(() => { for (const n of names) coverAsked.delete(n); });
  // 連不上（例如大陸連 C 站）又一直沒消息：兩分鐘後改寫「沒有預覽圖」，不要永遠停在「正在抓封面…」
  setTimeout(() => {
    for (const n of names) {
      const l = list.find((x) => x.name === n);
      if (l && !l.preview && !l.coverFailed) onCover({ name: n, failed: true });
    }
  }, COVER_WAIT);
}
export function onCover(m) {
  for (const l of [list.find((x) => x.name === m.name), app.state?.models?.loras?.find((x) => x.name === m.name)]) {
    if (!l) continue;
    if (m.failed) l.coverFailed = true;
    else Object.assign(l, { preview: m.preview, preview_nsfw: m.nsfw });
  }
  const l = list.find((x) => x.name === m.name);
  if (l) for (const box of document.querySelectorAll(".ph[data-lora]")) if (box.dataset.lora === m.name) fillPh(box, l);
}

function fillFilters() {
  const fill = (id, options) => {
    const box = $(id), old = box.value;
    box.replaceChildren(...options.map(([value, label]) => el("option", { value }, label)));
    box.value = [...box.options].some((o) => o.value === old) ? old : "";
  };
  const families = [...new Set(list.map(modelLabel))].sort((a, b) => (a === "其他") - (b === "其他") || a.localeCompare(b));
  const categories = [...new Set(list.map(categoryOf))].filter((c) => c && !KIND_ZH[c]).sort((a, b) => a.localeCompare(b));
  const counts = new Map();
  for (const l of list) for (const tag of tagsOf(l)) counts.set(tag, (counts.get(tag) || 0) + 1);
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  fill("#loraFamily", [["", "全部模型"], ...families.map((f) => [f, f])]);
  fill("#loraCategory", [["", "全部分類"], ["_none", "未分類"], ...KINDS.map(([id, label]) => [id, label]), ...categories.map((c) => [c, c])]);
  fill("#loraTag", [["", "常用標籤"], ...tags.slice(0, 100).map(([tag, n]) => [tag, `${tag} (${n})`])]);
}

function filtered() {
  const q = $("#loraQ")?.value?.trim() || "", fam = $("#loraFamily")?.value, category = $("#loraCategory")?.value, tag = $("#loraTag")?.value;
  return list.filter((l) => match(l, q) && (!fam || modelLabel(l) === fam) && (!category || (category === "_none" ? !categoryOf(l) : categoryOf(l) === category)) && (!tag || tagsOf(l).includes(tag)) && (!$("#loraFav")?.checked || l.fav));
}

export function renderPage(reset = true) {
  const items = filtered(), g = $("#loraGrid");
  if (!g) return;
  if (reset) { shown = 0; g.replaceChildren(); }
  syncViewBtn($("#loraView"), view.page, g);
  const end = Math.min(items.length, shown + PAGE);
  for (const l of items.slice(shown, end)) g.append(view.page === "list" ? row(l) : card(l));
  askCovers(items.slice(shown, end));
  shown = end;
  if ($("#loraMore")) $("#loraMore").hidden = shown >= items.length;
  if ($("#loraTotal")) $("#loraTotal").textContent = `${items.length} / ${list.length} 個`;
}

// 預覽圖可以直接拖一張圖上去換掉
function dropPh(l, attrs) {
  const box = ph(l, { title: "把圖拖到這裡就能換成這個 LoRA 的預覽圖", ...attrs });
  makeDrop(box, (f) => setPreview(l, f, isAdult(l)));
  return box;
}
const isAdult = (l) => !!l.nsfw || (l.preview_nsfw ?? l.cover_nsfw ?? 1) > 1;

// 列表模式的一行：小縮圖（滑過放大）＋名稱、觸發詞＋強度＋按鈕
function row(l) {
  const add = () => import("./gen.js").then((g) => { g.addLora(l, true); app.showPage("gen"); toast(`已加入「${title(l)}」`, "ok"); });
  return el("div", { class: "card lrow" },
    dropPh(l),
    el("div", { class: "bd" },
      el("div", { class: "t" }, (l.fav ? "★ " : "") + title(l), modelLabel(l) ? el("span", { class: "badge fam" }, modelLabel(l)) : null,
        el("span", { class: "badge" + (!l.category ? " auto" : "") }, categoryLabel(categoryOf(l)))),
      el("div", { class: "st", title: l.name }, l.name),
      l.triggers?.length ? el("div", { class: "trig", title: l.triggers.join(", ") }, "觸發詞：" + l.triggers.join(", ")) : null),
    el("div", { class: "ft" },
      el("span", { class: "sub" }, "強度"),
      el("input", { type: "number", step: 0.05, min: -2, max: 3, value: l.strength ?? 0.8, style: "width:62px", "aria-label": "預設強度", onchange: (e) => setMeta(l, { strength: +e.target.value }) }),
      el("button", { class: "btn sm primary", onclick: add }, "加到生成"),
      el("button", { class: "btn sm", onclick: () => openPreview(l) }, "換預覽圖"),
      el("button", { class: "btn sm", onclick: () => editTriggers(l) }, "改觸發詞"),
      el("button", { class: "icon", title: "收藏", onclick: () => setMeta(l, { fav: !l.fav }, true) }, l.fav ? "★" : "☆"),
      l.url ? el("a", { class: "icon", href: l.url, target: "_blank", title: "在 Civitai 開啟" }, "↗") : null));
}

function card(l) {
  return el("div", { class: "card" },
    dropPh(l),
    el("div", { class: "bd" },
      el("div", { class: "t" }, (l.fav ? "★ " : "") + title(l), modelLabel(l) ? el("span", { class: "badge fam" }, modelLabel(l)) : null),
      el("div", { class: "st" }, l.name),
      el("div", { class: "lora-card-meta" },
        el("span", { class: "badge" + (!l.category ? " auto" : ""), title: l.category ? "手動分類" : "依助手認識結果、標籤與名稱自動分類" }, categoryLabel(categoryOf(l))),
        ...tagsOf(l).slice(0, 8).map((tag) => el("button", { class: "chip", type: "button", title: `只看標籤 ${tag}`, onclick: () => { const box = $("#loraTag"); if (![...box.options].some((o) => o.value === tag)) box.append(el("option", { value: tag }, tag)); box.value = tag; renderPage(true); } }, tag))),
      l.triggers?.length ? el("div", { class: "trig", title: "觸發詞" }, "觸發詞：" + l.triggers.join(", ")) : el("div", { class: "st" }, "沒有觸發詞"),
      l.note ? el("div", { class: "st", style: "white-space:pre-wrap" }, l.note) : null,
      agentDesc(l),
      el("div", { class: "ft" },
        el("span", { class: "sub" }, "預設強度"),
        el("input", { type: "number", step: 0.05, min: -2, max: 3, value: l.strength ?? 0.8, style: "width:70px", onchange: (e) => setMeta(l, { strength: +e.target.value }) })),
      el("div", { class: "ft" },
        el("button", { class: "btn sm primary", onclick: () => { import("./gen.js").then((g) => { g.addLora(l, true); app.showPage("gen"); toast(`已加入「${title(l)}」`, "ok"); }); } }, "加到生成"),
        el("button", { class: "btn sm", onclick: () => editTriggers(l) }, "改觸發詞"),
        el("button", { class: "btn sm", title: "選一張圖、貼上或拖進來，當這個 LoRA 的預覽圖", onclick: () => openPreview(l) }, "換預覽圖"),
        el("button", { class: "btn sm", onclick: () => editCategory(l) }, "分類"),
        el("button", { class: "btn sm", onclick: () => editTags(l) }, "標籤"),
        el("button", { class: "btn sm", title: "生圖助手靠這句話決定什麼時候掛這個 LoRA", onclick: () => editAgentDesc(l) }, "改用途"),
        el("button", { class: "icon", title: "收藏", onclick: () => setMeta(l, { fav: !l.fav }, true) }, l.fav ? "★" : "☆"),
        l.url ? el("a", { class: "icon", href: l.url, target: "_blank", title: "在 Civitai 開啟" }, "↗") : null,
        el("button", { class: "btn sm danger", title: "把這個 LoRA 檔搬到「待刪除」資料夾（不是真的刪，搬回去就能再用）", onclick: () => remove(l) }, "移到待刪除"))));
}

// ---------------------------------------------------------------- 右鍵選單
let pickerMenuEl = null;

export function closePickerMenu() {
  pickerMenuEl?.remove();
  pickerMenuEl = null;
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("pointerdown", (e) => {
    if (pickerMenuEl && !pickerMenuEl.contains(e.target)) closePickerMenu();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePickerMenu();
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("scroll", closePickerMenu, true);
}

function openPickerMenu(e, l) {
  closePickerMenu();
  const dispName = title(l);
  const item = (label, fn) =>
    el("button", {
      type: "button",
      role: "menuitem",
      onclick: (ev) => {
        ev.stopPropagation();
        closePickerMenu();
        fn();
      },
    }, label);

  const m = el(
    "div",
    {
      class: "play-menu lora-picker-menu",
      role: "menu",
      style: "z-index: 99999; min-width: 190px; box-shadow: 0 8px 28px rgba(0,0,0,.65), 0 0 0 1px var(--case-hi);",
    },
    el(
      "div",
      {
        class: "muted sm",
        style: "padding: 5px 9px 4px; font-weight: bold; border-bottom: 1px solid var(--edge, rgba(128,128,128,.2)); margin-bottom: 3px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
      },
      `更多工具：${dispName}`
    ),
    item("✏️ 重命名", () => editTitle(l)),
    item("💬 改觸發詞", () => editTriggers(l)),
    item("🏷️ 標籤", () => editTags(l)),
    item("📁 分類", () => editCategory(l)),
    item(l.fav ? "★ 取消收藏" : "☆ 設為收藏", async () => {
      await setMeta(l, { fav: !l.fav }, false);
      renderPicker();
      toast(l.fav ? "已取消收藏 ☆" : "已加入收藏 ★", "ok");
    }),
    item("📋 複製檔案路徑", () => {
      navigator.clipboard?.writeText(l.name);
      toast(`已複製路徑：${l.name}`, "ok");
    }),
    item("➕ 插入此 LoRA", () => {
      pickCb(l);
      closeModal("#loraPicker");
    })
  );

  document.body.append(m);
  pickerMenuEl = m;
  const mw = m.offsetWidth || 190, mh = m.offsetHeight || 220;
  const x = Math.max(8, Math.min(innerWidth - mw - 8, e.clientX));
  const y = Math.max(8, Math.min(innerHeight - mh - 8, e.clientY));
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
  m.querySelector("button")?.focus();
}

async function setMeta(l, patch, rerender) {
  Object.assign(l, await api("/api/loras/meta", { json: { name: l.name, ...patch } }));
  if (rerender) await app.refreshState();
  if (!$("#loraPicker")?.hidden) renderPicker();
}

async function editTitle(l) {
  const current = l.title || baseName(l.name);
  const value = prompt("LoRA 顯示名稱（清空＝恢復預設檔案名）：", current);
  if (value === null) return;
  const t = value.trim();
  l.title = t;
  await setMeta(l, { title: t }, false);
  try {
    const gen = await import("./gen.js");
    const item = gen.S?.loras?.find((x) => x.name === l.name);
    if (item) item.title = t;
    gen.renderLoras?.();
  } catch (_) {}
  renderPicker();
  toast(t ? `已將名稱改為「${t}」` : `已恢復為預設名稱`, "ok");
}

async function editCategory(l) {
  const current = l.category || categoryOf(l);
  const value = prompt("用途分類（畫風／角色／服裝／概念／姿勢／細節／光影／其他；可自訂）。\n清空＝恢復自動分類。", categoryLabel(current) === "未分類" ? "" : categoryLabel(current));
  if (value === null) return;
  const t = value.trim();
  const known = KINDS.find(([, zh]) => zh === t)?.[0] || (KIND_ZH[t] ? t : t);
  await setMeta(l, { category: known }, true);
}

async function editTags(l) {
  const value = prompt("標籤（用逗號分隔；可搜尋與篩選）：", tagsOf(l).join(", "));
  if (value === null) return;
  const tags = [...new Set(value.split(/[,，]/).map((s) => s.trim()).filter(Boolean))].slice(0, 60);
  await setMeta(l, { tags }, true);
}

async function editTriggers(l) {
  const v = prompt("觸發詞（用逗號分隔）：", (l.triggers || []).join(", "));
  if (v === null) return;
  await setMeta(l, { triggers: v.split(",").map((s) => s.trim()).filter(Boolean) }, true);
}

// ---------------------------------------------------------------- 挑選視窗
// 用途說明：生圖助手挑 LoRA 時看的那一句。自己寫的會蓋掉助手猜的；清空＝讓助手重新認識
async function editAgentDesc(l) {
  const a = l.agent || {};
  const v = prompt("這個 LoRA 是做什麼用的？一句話（中文、英文都可以）。\n例：把畫面變成雪夜發光的柔焦畫風，適合冬天、夜景。\n清空＝讓助手之後重新認識。", a.desc_zh || a.desc || "");
  if (v === null) return;
  const t = v.trim();
  await setMeta(l, { agent: t ? { ...a, desc: t, desc_zh: t, kind: a.kind || "other", sure: true, src: "user", t: Date.now() / 1000 } : {} }, true);
}

// ---------------------------------------------------------------- 換預覽圖（2026-11-17）
// 後端縮成長邊 640 的 JPEG 存進 previews\custom_<雜湊>.jpg；原本的預覽圖（C 站抓的）記著，按「還原」換回去
let prevLora = null;
function initPreviewDialog() {
  makeDrop($("#lpvDrop"), (f) => prevLora && setPreview(prevLora, f, $("#lpvNsfw").checked));
  $("#lpvPick").onclick = async () => { const f = await pickFile("image/png,image/jpeg,image/webp"); if (f && prevLora) setPreview(prevLora, f, $("#lpvNsfw").checked); };
  $("#lpvReset").onclick = async () => {
    if (!prevLora) return;
    const name = prevLora.name;
    try {
      applyMeta(prevLora, await api("/api/loras/preview/set", { json: { name, reset: true } }));
      // 本來沒有預覽圖的：重抓清單，才拿得到內建縮圖（cover_file）或抓封面的標記
      await app.refreshState();
      prevLora = list.find((x) => x.name === name) || prevLora;
      fillPreviewDialog();
      toast("已還原原本的預覽圖", "ok");
    } catch (e) { toast(e.message, "err"); }
  };
  document.addEventListener("paste", (e) => {
    if ($("#loraPrev").hidden || !prevLora) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
    if (!f) return;
    e.preventDefault();
    setPreview(prevLora, f, $("#lpvNsfw").checked);
  });
}
function openPreview(l) {
  prevLora = l;
  $("#lpvTitle").textContent = `換預覽圖：${title(l)}`;
  $("#lpvNsfw").checked = isAdult(l);
  fillPreviewDialog();
  openModal("#loraPrev");
  setTimeout(() => $("#lpvDrop").focus(), 50);
}
function fillPreviewDialog() {
  const l = prevLora;
  if (!l) return;
  const box = $("#lpvPh");
  box.dataset.lora = l.name;
  fillPh(box, l);
  $("#lpvReset").hidden = !l.preview_custom;
}
// 後端回的 LoRA 資訊蓋回清單（還原後沒有 preview 的欄位也要拿掉），重畫畫面上這個 LoRA 的所有預覽圖
function applyMeta(l, meta) {
  for (const x of [l, list.find((y) => y.name === l.name), app.state?.models?.loras?.find((y) => y.name === l.name)]) {
    if (!x) continue;
    for (const k of ["preview", "preview_nsfw", "preview_custom", "preview_t", "preview_orig", "preview_orig_nsfw"]) delete x[k];
    Object.assign(x, meta, { name: l.name });
  }
  for (const box of document.querySelectorAll(".ph[data-lora]")) if (box.dataset.lora === l.name) fillPh(box, l);
  if (prevLora?.name === l.name) fillPreviewDialog();
}
async function setPreview(l, file, nsfw) {
  const fd = new FormData();
  fd.append("image", file, file.name || "preview.png");
  try {
    applyMeta(l, await api(`/api/loras/preview?name=${encodeURIComponent(l.name)}&nsfw=${nsfw ? 1 : 0}`, { method: "POST", body: fd }));
    toast(`已換上「${title(l)}」的預覽圖`, "ok");
  } catch (e) { toast(e.message, "err"); }
}

/** 圖庫／生成結果的「設為 LoRA 預覽圖」：這張圖用了哪些 LoRA 就從那幾個挑（只用一個就直接問要不要換） */
export async function previewFromImage(rec) {
  let used = rec.params?.loras;
  if (!used) used = (await api(`/api/image/${rec.id}`)).params?.loras;
  const names = new Set((used || []).map((x) => x.name).filter(Boolean));
  const apply = async (l) => {
    try {
      applyMeta(l, await api("/api/loras/preview/set", { json: { name: l.name, id: rec.id, nsfw: isAdult(l) } }));
      toast(`已把這張圖設成「${title(l)}」的預覽圖`, "ok");
    } catch (e) { toast(e.message, "err"); }
  };
  const mine = list.filter((l) => names.has(l.name));
  if (mine.length === 1) {
    if (confirm(`把這張圖設成「${title(mine[0])}」的預覽圖？`)) await apply(mine[0]);
    return;
  }
  // 用了好幾個（或一個都沒用）：開挑選視窗，先只列這張圖用到的
  openPicker(apply, mine.length ? (x) => names.has(x.name) : null, { title: "這張圖要當哪個 LoRA 的預覽圖？" });
}

// ---------------------------------------------------------------- 挑選視窗
// fam：只列出這個家族的 LoRA（Anima 的 LoRA 套在 Qwen 2.1 上沒有用，反之亦然）。
// 也可以給判斷函式 (l) => 能不能用（匯入的工作流組：同家族或家族不明的都能接）；用函式時列表下面有「顯示全部」可以看被藏起來的
// opts：{title}（圖庫「設為 LoRA 預覽圖」借用這個視窗時換標題）
export function openPicker(cb, fam, opts = {}) {
  closePickerMenu();
  pickCb = cb;
  pickFam = fam || null;
  pickAll = false;
  pickShown = 0;
  if ($("#lpQ")) $("#lpQ").value = "";
  if ($("#lpFolder")) $("#lpFolder").value = "";

  const fits = (x) => !pickFam || (typeof pickFam === "function" ? pickFam(x) : (x.family || "anima") === pickFam);
  const usable = pickAll ? list : list.filter(fits);
  fillPickerFolders(usable);

  const pickerTitle = $("#lpTitle");
  if (pickerTitle) pickerTitle.textContent = opts.title || "選擇 LoRA 卡匣";
  renderPicker();
  openModal("#loraPicker");
  setTimeout(() => $("#lpQ")?.focus(), 50);

  // 異步同步最新的封面與觸發詞
  syncLmData();
}

function folderOf(name) {
  const norm = (name || "").replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i !== -1 ? norm.slice(0, i) : "";
}

function matchFolder(l, sel) {
  if (!sel) return true;
  const f = l.folder || folderOf(l.name);
  if (sel === "__root__") return !f;
  return f === sel || f.startsWith(sel + "/");
}

function fillPickerFolders(items) {
  const sel = $("#lpFolder");
  if (!sel) return;
  const oldVal = sel.value;

  const allFolders = new Set();
  let rootCount = 0;
  for (const l of items) {
    const f = l.folder || folderOf(l.name);
    if (!f) {
      rootCount++;
      continue;
    }
    const parts = f.split("/");
    for (let i = 1; i <= parts.length; i++) {
      allFolders.add(parts.slice(0, i).join("/"));
    }
  }

  const counts = new Map();
  for (const f of allFolders) {
    const prefix = f + "/";
    let cnt = 0;
    for (const l of items) {
      const lf = l.folder || folderOf(l.name);
      if (lf === f || lf.startsWith(prefix)) cnt++;
    }
    counts.set(f, cnt);
  }

  const sortedFolders = Array.from(allFolders).sort((a, b) => a.localeCompare(b));
  const options = [el("option", { value: "" }, `📁 全部資料夾 (${items.length})`)];
  if (rootCount > 0) {
    options.push(el("option", { value: "__root__" }, `📁 [根目錄] (${rootCount})`));
  }

  for (const f of sortedFolders) {
    const parts = f.split("/");
    const depth = parts.length - 1;
    const indent = depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└ " : "";
    const name = parts[parts.length - 1];
    const cnt = counts.get(f) || 0;
    options.push(el("option", { value: f }, `${indent}📁 ${name} (${cnt})`));
  }

  sel.replaceChildren(...options);
  sel.value = [...sel.options].some((o) => o.value === oldVal) ? oldVal : "";
}

function renderPicker() {
  if (pickerTab === "recipe") {
    renderRecipePicker();
    return;
  }

  const q = $("#lpQ")?.value.trim() || "";
  const folder = $("#lpFolder")?.value || "";
  const g = $("#lpGrid");
  if (!g) return;
  g.innerHTML = "";
  syncViewBtn($("#lpView"), view.pick, g);
  const asList = view.pick === "list";
  const fits = (x) => !pickFam || (typeof pickFam === "function" ? pickFam(x) : (x.family || "anima") === pickFam);
  const usable = pickAll ? list : list.filter(fits);
  if (!usable.length) g.append(el("div", { class: "muted pad" }, "還沒有這個模型能用的 LoRA。到「Civitai」分頁搜尋下載（記得選對基底模型）。"));
  const matches = usable.filter((x) => matchFolder(x, folder) && match(x, q));
  askCovers(matches.slice(0, pickShown + 80));
  for (const l of matches.slice(0, pickShown + 80)) {
    const pick = () => { closeModal("#loraPicker"); pickCb(l); };
    if (asList) {
      // 列表：一行一個，小縮圖＋名稱＋家族＋觸發詞，按整行就選
      g.append(el("div", { class: "card pick lrow", onclick: pick },
        ph(l),
        el("div", { class: "bd" },
          el("div", { class: "t" }, (l.fav ? "★ " : "") + title(l), modelLabel(l) ? el("span", { class: "badge fam" }, modelLabel(l)) : null),
          l.triggers?.length ? el("div", { class: "trig", title: l.triggers.join(", ") }, l.triggers.slice(0, 6).join(", ")) : null,
          l.note ? el("div", { class: "st", title: l.note }, l.note) : null)));
      const row = g.lastElementChild;
      row?.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openPickerMenu(e, l); });
      continue;
    }
    const cardEl = el("div", { class: "card pick", onclick: pick,
      title: `${l.folder || folderOf(l.name) ? `${l.folder || folderOf(l.name)} / ` : ""}${title(l)}\n【右鍵：更多工具／重命名】` },
      ph(l, { style: "aspect-ratio:1" }),
      el("div", { class: "bd" }, el("div", { class: "t" }, title(l)), l.triggers?.length ? el("div", { class: "trig" }, l.triggers.slice(0, 4).join(", ")) : null,
        l.note ? el("div", { class: "pick-note", title: l.note }, l.note) : null));
    cardEl.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openPickerMenu(e, l); });
    g.append(cardEl);
  }

  pickShown = Math.min(matches.length, pickShown + 80);
  if (pickShown < matches.length) {
    g.append(el("button", { class: "akey sm", type: "button", onclick: () => renderPicker() }, `載入更多（${matches.length - pickShown} 個）`));
  }

  const hidden = !pickAll ? list.filter((x) => !fits(x)).length : 0;
  if (hidden) {
    g.append(
      el(
        "div",
        { class: "muted sm pick-more" },
        `已藏起 ${hidden} 個其他模型家族的 LoRA（用了也會被略過）。`,
        el("button", { class: "link", type: "button", onclick: () => { pickAll = true; pickShown = 0; fillPickerFolders(list); renderPicker(); } }, "顯示全部")
      )
    );
  }
}

// ---------------------------------------------------------------- 配方列表挑選
function renderRecipePicker() {
  const q = $("#lpQ")?.value.trim().toLowerCase() || "";
  const g = $("#lpGrid");
  if (!g) return;
  g.innerHTML = "";

  if (!lmRecipes.length) {
    g.append(el("div", { class: "muted pad" }, "尚未發現任何 LoRA 配方。您可以在「LoRA」管理頁中將常用的 LoRA 組合建立為配方（Recipes）。"));
    return;
  }

  const matches = lmRecipes.filter((r) => !q || (r.title || r.name || "").toLowerCase().includes(q) || (r.loras || []).some((x) => (x.file_name || x.name || "").toLowerCase().includes(q)));

  if (!matches.length) {
    g.append(el("div", { class: "muted pad" }, "沒有符合搜尋條件的 LoRA 配方。"));
    return;
  }

  for (const r of matches) {
    const lorasList = (r.loras || []).map((x) => `${x.file_name || x.name} (${x.strength || x.weight || 1})`).join("、 ");
    const previewStyle = r.file_path ? `background-image:url("${LM_ORIGIN}/api/lm/previews?path=${encodeURIComponent(r.file_path)}")` : "";

    const cardEl = el(
      "div",
      {
        class: "card pick recipe-card",
        title: `配方：${r.title || r.name}\n包含：${lorasList}\n點擊一鍵套用至生圖卡匣`,
        onclick: async () => {
          const gen = await import("./gen.js");
          gen.applyLoraRecipe({
            name: r.title || r.name,
            loras: (r.loras || []).map((x) => ({
              name: (x.file_name || x.name).endsWith(".safetensors") || (x.file_name || x.name).endsWith(".pt") ? (x.file_name || x.name) : `${x.file_name || x.name}.safetensors`,
              strength: x.strength || x.weight || 1,
              title: x.custom_name || x.file_name || x.name,
              triggers: x.trigger_words || x.trained_words || []
            }))
          });
          closeModal("#loraPicker");
        },
      },
      el("div", { class: "ph", style: previewStyle ? `${previewStyle};aspect-ratio:1` : "aspect-ratio:1" }, previewStyle ? "" : "📋 配方"),
      el("div", { class: "bd" },
        el("div", { class: "t" }, `📋 ${r.title || r.name}`),
        el("div", { class: "trig", style: "color:var(--text-dim);font-size:11px;" }, `${(r.loras || []).length} 個 LoRA：${lorasList}`)
      )
    );

    g.append(cardEl);
  }
}
