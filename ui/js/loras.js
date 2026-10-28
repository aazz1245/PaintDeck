// LoRA 管理器（內嵌 ComfyUI-Lora-Manager 獨立頁面）與生圖卡匣挑選視窗
import { $, el, api, toast, openModal, closeModal, debounce } from "./util.js";
import { app } from "./state.js";

const LM_ORIGIN = "http://127.0.0.1:8188";
const LM_PAGE_URL = `${LM_ORIGIN}/loras`;

let list = [];
let pickCb = null;
let pickFam = null;
let pickAll = false;
let pickShown = 0;
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
      const gen = await import("./gen.js");
      const loraName = e.data.name.endsWith(".safetensors") || e.data.name.endsWith(".pt") ? e.data.name : `${e.data.name}.safetensors`;
      gen.addLora({
        name: loraName,
        strength: e.data.strength ?? 0.8,
        title: e.data.title || e.data.name,
        triggers: e.data.triggers || []
      }, true);
      app.showPage("gen");
      toast(`已將「${e.data.title || e.data.name}」加入生圖卡匣！`, "ok");
    } else if (e.data?.type === "PAINTDECK_APPLY_RECIPE") {
      const gen = await import("./gen.js");
      gen.applyLoraRecipe({
        name: e.data.recipeName || "LoRA 配方",
        loras: (e.data.loras || []).map((x) => ({
          name: x.name.endsWith(".safetensors") || x.name.endsWith(".pt") ? x.name : `${x.name}.safetensors`,
          strength: x.strength ?? 0.8,
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
}

export function onState(st) {
  list = (st.models?.loras || []).slice().sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || (a.title || a.name).localeCompare(b.title || b.name));
  if (lmOnline && !lmMetaSynced) {
    syncLmData();
  }
}

// ---------------------------------------------------------------- 全屏管理頁面
export async function showPage() {
  const frame = $("#loraManagerFrame");
  const offline = $("#loraManagerOffline");
  if (!frame || !offline) return;

  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${LM_ORIGIN}/api/lm/loras/list?page=1&page_size=1`, { signal: ctrl.signal });
    clearTimeout(tm);
    if (res.ok) {
      lmOnline = true;
      offline.hidden = true;
      frame.hidden = false;
      if (!lmLoaded || frame.src === "about:blank" || !frame.src.startsWith(LM_ORIGIN)) {
        frame.src = LM_PAGE_URL;
        lmLoaded = true;
      }
      if (!lmMetaSynced) syncLmData();
      return;
    }
  } catch (_) {}

  // 離線處理
  lmOnline = false;
  offline.hidden = false;
  frame.hidden = true;
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

const baseName = (name) => (name || "").replace(/\\/g, "/").split("/").pop().replace(/\.(safetensors|pt|bin|ckpt)$/i, "");
const title = (l) => l.title || baseName(l.name);
const famName = (l) => app.state?.models?.family_names?.[l.family] || "";
const FAM_BADGE = { qwen21: "Qwen 2.1", moss: "MOSS", sdxl: "SDXL", sd15: "SD1.5", flux: "Flux", sd3: "SD3" };
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
const modelLabel = (l) => l.base_model || FAM_BADGE[l.family] || famName(l) || l.family || "其他";
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

const preview = (l) => {
  if (l.lm_preview_url) {
    const u = l.lm_preview_url.startsWith("http") ? l.lm_preview_url : `${LM_ORIGIN}${l.lm_preview_url}`;
    return `url("${u}")`;
  }
  if (l.preview) return `url(/lora_preview/${encodeURIComponent(l.preview)})`;
  if (l.local_preview) return `url(/api/loras/local-preview?name=${encodeURIComponent(l.name)})`;
  return "";
};

// ---------------------------------------------------------------- 右鍵選單
let pickerMenuEl = null;

export function closePickerMenu() {
  pickerMenuEl?.remove();
  pickerMenuEl = null;
}

document.addEventListener("pointerdown", (e) => {
  if (pickerMenuEl && !pickerMenuEl.contains(e.target)) closePickerMenu();
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePickerMenu();
});

window.addEventListener("scroll", closePickerMenu, true);

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
      pickCb(l, $("#lpTrig")?.checked);
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
export function openPicker(cb, fam) {
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

  const fits = (x) => !pickFam || (typeof pickFam === "function" ? pickFam(x) : (x.family || "anima") === pickFam);
  const usable = pickAll ? list : list.filter(fits);

  if (!usable.length) {
    g.append(el("div", { class: "muted pad" }, "還沒有這個模型能用的 LoRA。"));
    return;
  }

  const matches = usable.filter((x) => matchFolder(x, folder) && match(x, q));
  for (const l of matches.slice(0, pickShown + 80)) {
    const blur = app.state?.settings?.blur_nsfw && l.nsfw;
    const fPath = l.folder || folderOf(l.name);
    const cardEl = el(
      "div",
      {
        class: "card pick",
        title: (fPath ? `${fPath} / ${title(l)}` : title(l)) + "\n【右鍵：更多工具／重命名】",
        onclick: () => {
          pickCb(l, $("#lpTrig")?.checked);
          closeModal("#loraPicker");
        },
      },
      el("div", { class: "ph" + (blur ? " blur" : ""), style: preview(l) ? `background-image:${preview(l)};aspect-ratio:1` : "aspect-ratio:1" }, preview(l) ? "" : "無預覽"),
      el("div", { class: "bd" },
        el("div", { class: "t" }, (l.fav ? "★ " : "") + title(l)),
        l.triggers?.length ? el("div", { class: "trig" }, l.triggers.slice(0, 4).join(", ")) : null,
        l.note ? el("div", { class: "pick-note", title: l.note }, l.note) : null
      )
    );

    cardEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPickerMenu(e, l);
    });

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
    const lorasList = (r.loras || []).map((x) => `${x.file_name || x.name} (${x.strength || x.weight || 0.8})`).join("、 ");
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
              strength: x.strength || x.weight || 0.8,
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
