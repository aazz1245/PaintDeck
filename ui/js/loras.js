// LoRA：已安裝清單頁、挑選視窗（加到生成）、觸發詞與預設強度編輯、移到待刪除
import { $, el, api, toast, openModal, closeModal, debounce } from "./util.js";
import { app } from "./state.js";

let list = [], pickCb = null, pickFam = null, pickAll = false, shown = 0, pickShown = 0;
const PAGE = 60;
const KIND_ZH = { style: "畫風", character: "角色", clothing: "服裝", concept: "概念", pose: "姿勢", detail: "細節", lighting: "光影", other: "其他" };
const KINDS = Object.entries(KIND_ZH);

export function init() {
  $("#loraQ").oninput = debounce(() => renderPage(true), 150);
  for (const id of ["#loraFamily", "#loraCategory", "#loraTag", "#loraFav"]) $(id).onchange = () => renderPage(true);
  $("#loraMore").onclick = () => renderPage(false);
  $("#loraLearn").onclick = () => $("#assistBtn").click();
  $("#lpQ").oninput = debounce(() => { pickShown = 0; renderPicker(); }, 150);
  $("#lpFolder").onchange = () => { pickShown = 0; renderPicker(); };
  $("#loraRefresh").onclick = async () => { await app.refreshState(); toast("已重新整理", "ok"); };
}

export function onState(st) {
  list = (st.models?.loras || []).slice().sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || (a.title || a.name).localeCompare(b.title || b.name));
  if (app.page === "loras") { fillFilters(); renderPage(true); }
}

export function showPage() { fillFilters(); renderPage(true); }

const baseName = (name) => (name || "").replace(/\\/g, "/").split("/").pop().replace(/\.(safetensors|pt|bin|ckpt)$/i, "");
const title = (l) => l.title || baseName(l.name);
const famName = (l) => app.state?.models?.family_names?.[l.family] || "";
// 卡片右上角的家族小標（Anima 是預設，不標）
const FAM_BADGE = { qwen21: "Qwen 2.1", moss: "MOSS", sdxl: "SDXL", sd15: "SD1.5", flux: "Flux", sd3: "SD3" };
const tagsOf = (l) => Array.isArray(l.tags) ? l.tags.filter((x) => typeof x === "string" && x.trim()) : [];
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
const match = (l, q) => !q || (title(l) + " " + modelLabel(l) + " " + l.name + " " + (l.triggers || []).join(" ") + " " + tagsOf(l).join(" ") + " " + categoryLabel(categoryOf(l)) + " " + (l.note || "") + " " + (l.agent?.desc_zh || "") + " " + (l.agent?.desc || "")).toLowerCase().includes(q.toLowerCase());
// 生圖助手對這個 LoRA 的認識（agent.rs 的 parse_lora_desc 寫進 lora_meta.agent）
function agentDesc(l) {
  const a = l.agent;
  if (!a?.desc) return null;
  return el("div", { class: "agent-desc", title: (a.src === "user" ? "你寫的" : a.src === "probe" ? "助手試畫比較後寫的" : "助手讀線索寫的") + "（給助手挑 LoRA 用）\n" + a.desc },
    el("span", { class: "ag-kind" + (a.sure === false ? " unsure" : "") }, "助手：" + (KIND_ZH[a.kind] || a.kind || "其他") + (a.sure === false ? "？" : "")), a.desc_zh || a.desc);
}
const preview = (l) => l.preview ? `url(/lora_preview/${encodeURIComponent(l.preview)})` : l.local_preview ? `url(/api/loras/local-preview?name=${encodeURIComponent(l.name)})` : "";

function fillFilters() {
  const fill = (id, options) => {
    const box = $(id), old = box.value;
    box.replaceChildren(...options.map(([value, label]) => el("option", { value }, label)));
    box.value = [...box.options].some((o) => o.value === old) ? old : "";
  };
  const families = [...new Set(list.map(modelLabel))].sort((a, b) => a.localeCompare(b));
  const categories = [...new Set(list.map(categoryOf))].filter((c) => c && !KIND_ZH[c]).sort((a, b) => a.localeCompare(b));
  const counts = new Map();
  for (const l of list) for (const tag of tagsOf(l)) counts.set(tag, (counts.get(tag) || 0) + 1);
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  fill("#loraFamily", [["", "全部模型"], ...families.map((f) => [f, f])]);
  fill("#loraCategory", [["", "全部分類"], ["_none", "未分類"], ...KINDS.map(([id, label]) => [id, label]), ...categories.map((c) => [c, c])]);
  fill("#loraTag", [["", "常用標籤"], ...tags.slice(0, 100).map(([tag, n]) => [tag, `${tag} (${n})`])]);
}

function filtered() {
  const q = $("#loraQ").value.trim(), fam = $("#loraFamily").value, category = $("#loraCategory").value, tag = $("#loraTag").value;
  return list.filter((l) => match(l, q) && (!fam || modelLabel(l) === fam) && (!category || (category === "_none" ? !categoryOf(l) : categoryOf(l) === category)) && (!tag || tagsOf(l).includes(tag)) && (!$("#loraFav").checked || l.fav));
}

function renderPage(reset = true) {
  const items = filtered(), g = $("#loraGrid");
  if (reset) { shown = 0; g.replaceChildren(); }
  const end = Math.min(items.length, shown + PAGE);
  for (const l of items.slice(shown, end)) g.append(card(l));
  shown = end;
  $("#loraMore").hidden = shown >= items.length;
  $("#loraTotal").textContent = `${items.length} / ${list.length} 個`;
  if (!list.length) g.append(el("div", { class: "muted pad" }, "還沒有 LoRA。到「Civitai」分頁搜尋下載。"));
  else if (!items.length) g.append(el("div", { class: "muted pad" }, "沒有符合條件的 LoRA。"));
}

function card(l) {
  const blur = app.state?.settings?.blur_nsfw && l.nsfw;
  return el("div", { class: "card" },
    el("div", { class: "ph" + (blur ? " blur" : ""), style: preview(l) ? `background-image:${preview(l)}` : "" }, preview(l) ? "" : "沒有預覽圖"),
    el("div", { class: "bd" },
      el("div", { class: "t" }, (l.fav ? "★ " : "") + title(l), modelLabel(l) ? el("span", { class: "badge fam" }, modelLabel(l)) : null),
      el("div", { class: "st" }, l.name),
      el("div", { class: "lora-card-meta" },
        el("span", { class: "badge" + (!l.category ? " auto" : ""), title: l.category ? "手動分類" : "依助手認識結果、標籤與名稱自動分類" }, categoryLabel(categoryOf(l))),
        ...tagsOf(l).slice(0, 8).map((tag) => el("button", { class: "chip", type: "button", title: `只看標籤：${tag}`, onclick: () => { const box = $("#loraTag"); if (![...box.options].some((o) => o.value === tag)) box.append(el("option", { value: tag }, tag)); box.value = tag; renderPage(true); } }, tag))),
      l.triggers?.length ? el("div", { class: "trig", title: "觸發詞" }, "觸發詞：" + l.triggers.join(", ")) : el("div", { class: "st" }, "沒有觸發詞"),
      l.note ? el("div", { class: "st", style: "white-space:pre-wrap" }, l.note) : null,
      agentDesc(l),
      el("div", { class: "ft" },
        el("span", { class: "sub" }, "預設強度"),
        el("input", { type: "number", step: 0.05, min: -2, max: 3, value: l.strength ?? 0.8, style: "width:70px", onchange: (e) => setMeta(l, { strength: +e.target.value }) })),
      el("div", { class: "ft" },
        el("button", { class: "btn sm primary", onclick: () => { import("./gen.js").then((g) => { g.addLora(l, true); app.showPage("gen"); toast(`已加入「${title(l)}」`, "ok"); }); } }, "加到生成"),
        el("button", { class: "btn sm", onclick: () => editTitle(l) }, "改名稱"),
        el("button", { class: "btn sm", onclick: () => editTriggers(l) }, "改觸發詞"),
        el("button", { class: "btn sm", onclick: () => editCategory(l) }, "分類"),
        el("button", { class: "btn sm", onclick: () => editTags(l) }, "標籤"),
        el("button", { class: "btn sm", title: "生圖助手靠這句話決定什麼時候掛這個 LoRA", onclick: () => editAgentDesc(l) }, "改用途"),
        el("button", { class: "icon", title: "收藏", onclick: () => setMeta(l, { fav: !l.fav }, true) }, l.fav ? "★" : "☆"),
        l.url ? el("a", { class: "icon", href: l.url, target: "_blank", title: "在 Civitai 開啟" }, "↗") : null,
        el("button", { class: "btn sm danger", title: "把這個 LoRA 檔搬到「待刪除」資料夾（不是真的刪，搬回去就能再用）", onclick: () => remove(l) }, "移到待刪除"))));
}

// 移到待刪除：檔案和預覽圖搬到 <資料>\待刪除\LoRA\，觸發詞等備註留著（搬回 LoRA 資料夾就回來）
async function remove(l) {
  if (!confirm(`把「${title(l)}」移到待刪除？\n\n檔案不會真的刪掉，會搬到生圖站資料夾的「待刪除\\LoRA」裡；想再用就搬回 LoRA 資料夾。\n生成頁、預設組裡用到它的地方會找不到這個 LoRA。`)) return;
  try {
    const r = await api("/api/loras/delete", { json: { name: l.name } });
    toast(`已移到待刪除：${r.moved_to}`, "ok");
    await app.refreshState();
    fillFilters(); renderPage(true);
  } catch (e) { toast(e.message, "err"); }
}

async function setMeta(l, patch, rerender) {
  Object.assign(l, await api("/api/loras/meta", { json: { name: l.name, ...patch } }));
  if (rerender) { await app.refreshState(); fillFilters(); renderPage(true); }
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
  if (app.page === "loras") { fillFilters(); renderPage(true); }
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

// 用途說明：生圖助手挑 LoRA 時看的那一句。自己寫的會蓋掉助手猜的；清空＝讓助手重新認識
async function editAgentDesc(l) {
  const a = l.agent || {};
  const v = prompt("這個 LoRA 是做什麼用的？一句話（中文、英文都可以）。\n例：把畫面變成雪夜發光的柔焦畫風，適合冬天、夜景。\n清空＝讓助手之後重新認識。", a.desc_zh || a.desc || "");
  if (v === null) return;
  const t = v.trim();
  await setMeta(l, { agent: t ? { ...a, desc: t, desc_zh: t, kind: a.kind || "other", sure: true, src: "user", t: Date.now() / 1000 } : {} }, true);
}

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
  const item = (label, fn) => el("button", {
    type: "button",
    role: "menuitem",
    onclick: (ev) => {
      ev.stopPropagation();
      closePickerMenu();
      fn();
    }
  }, label);

  const m = el("div", {
    class: "play-menu lora-picker-menu",
    role: "menu",
    style: "z-index: 99999; min-width: 190px; box-shadow: 0 8px 28px rgba(0,0,0,.65), 0 0 0 1px var(--case-hi);"
  },
    el("div", {
      class: "muted sm",
      style: "padding: 5px 9px 4px; font-weight: bold; border-bottom: 1px solid var(--edge, rgba(128,128,128,.2)); margin-bottom: 3px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
    }, `更多工具：${dispName}`),
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
      pickCb(l, $("#lpTrig").checked);
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

// ---------------------------------------------------------------- 挑選視窗
// fam：只列出這個家族的 LoRA（Anima 的 LoRA 套在 Qwen 2.1 上沒有用，反之亦然）。
// 也可以給判斷函式 (l) => 能不能用（匯入的工作流組：同家族或家族不明的都能接）；用函式時列表下面有「顯示全部」可以看被藏起來的
export function openPicker(cb, fam) {
  closePickerMenu();
  pickCb = cb;
  pickFam = fam || null;
  pickAll = false;
  pickShown = 0;
  $("#lpQ").value = "";
  if ($("#lpFolder")) $("#lpFolder").value = "";
  const fits = (x) => !pickFam || (typeof pickFam === "function" ? pickFam(x) : (x.family || "anima") === pickFam);
  const usable = pickAll ? list : list.filter(fits);
  fillPickerFolders(usable);
  renderPicker();
  openModal("#loraPicker");
  setTimeout(() => $("#lpQ").focus(), 50);
}

function folderOf(name) {
  const norm = (name || "").replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i !== -1 ? norm.slice(0, i) : "";
}

function matchFolder(l, sel) {
  if (!sel) return true;
  const f = folderOf(l.name);
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
    const f = folderOf(l.name);
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
      const lf = folderOf(l.name);
      if (lf === f || lf.startsWith(prefix)) cnt++;
    }
    counts.set(f, cnt);
  }

  const sortedFolders = Array.from(allFolders).sort((a, b) => a.localeCompare(b));

  const options = [
    el("option", { value: "" }, `📁 全部資料夾 (${items.length})`)
  ];
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
  if ([...sel.options].some((o) => o.value === oldVal)) {
    sel.value = oldVal;
  } else {
    sel.value = "";
  }
}

function renderPicker() {
  const q = $("#lpQ").value.trim();
  const folder = $("#lpFolder")?.value || "";
  const g = $("#lpGrid");
  g.innerHTML = "";
  const fits = (x) => !pickFam || (typeof pickFam === "function" ? pickFam(x) : (x.family || "anima") === pickFam);
  const usable = pickAll ? list : list.filter(fits);
  if (!usable.length) g.append(el("div", { class: "muted pad" }, "還沒有這個模型能用的 LoRA。到「Civitai」分頁搜尋下載（記得選對基底模型）。"));
  const matches = usable.filter((x) => matchFolder(x, folder) && match(x, q));
  for (const l of matches.slice(0, pickShown + 80)) {
    const blur = app.state?.settings?.blur_nsfw && l.nsfw;
    const fPath = folderOf(l.name);
    const cardEl = el("div", {
      class: "card pick",
      title: (fPath ? `${fPath} / ${title(l)}` : title(l)) + "\n【右鍵：更多工具／重命名】",
      onclick: () => { pickCb(l, $("#lpTrig").checked); closeModal("#loraPicker"); }
    },
      el("div", { class: "ph" + (blur ? " blur" : ""), style: preview(l) ? `background-image:${preview(l)};aspect-ratio:1` : "aspect-ratio:1" }, preview(l) ? "" : "無預覽"),
      el("div", { class: "bd" }, el("div", { class: "t" }, (l.fav ? "★ " : "") + title(l)), l.triggers?.length ? el("div", { class: "trig" }, l.triggers.slice(0, 4).join(", ")) : null,
        l.note ? el("div", { class: "pick-note", title: l.note }, l.note) : null));
    cardEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPickerMenu(e, l);
    });
    g.append(cardEl);
  }
  pickShown = Math.min(matches.length, pickShown + 80);
  if (pickShown < matches.length) g.append(el("button", { class: "akey sm", type: "button", onclick: () => renderPicker() }, `載入更多（${matches.length - pickShown} 個）`));
  // 匯入的工作流組：不同家族的 LoRA 先藏起來，需要時按「顯示全部」（選了也會在生成時被略過）
  const hidden = !pickAll ? list.filter((x) => !fits(x)).length : 0;
  if (hidden) g.append(el("div", { class: "muted sm pick-more" }, `已藏起 ${hidden} 個其他模型家族的 LoRA（用了也會被略過）。`,
    el("button", { class: "link", type: "button", onclick: () => { pickAll = true; pickShown = 0; fillPickerFolders(list); renderPicker(); } }, "顯示全部")));
}
