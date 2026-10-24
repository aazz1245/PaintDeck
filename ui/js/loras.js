// LoRA：已安裝清單頁、挑選視窗（加到生成）、觸發詞與預設強度編輯、移到待刪除
import { $, el, api, toast, openModal, closeModal, debounce } from "./util.js";
import { app } from "./state.js";

let list = [], pickCb = null, pickFam = null, pickAll = false;

export function init() {
  $("#loraQ").oninput = debounce(renderPage, 150);
  $("#lpQ").oninput = debounce(renderPicker, 150);
  $("#loraRefresh").onclick = async () => { await app.refreshState(); toast("已重新整理", "ok"); };
}

export function onState(st) {
  list = (st.models?.loras || []).slice().sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || (a.title || a.name).localeCompare(b.title || b.name));
  if (app.page === "loras") renderPage();
}

export function showPage() { renderPage(); }

const title = (l) => l.title || l.name.replace(/\.safetensors$/, "");
const famName = (l) => app.state?.models?.family_names?.[l.family] || "";
// 卡片右上角的家族小標（Anima 是預設，不標）
const FAM_BADGE = { qwen21: "Qwen 2.1", moss: "MOSS", sdxl: "SDXL", sd15: "SD1.5", flux: "Flux", sd3: "SD3" };
const match = (l, q) => !q || (title(l) + " " + famName(l) + " " + l.name + " " + (l.triggers || []).join(" ") + " " + (l.tags || []).join(" ") + " " + (l.note || "") + " " + (l.agent?.desc_zh || "") + " " + (l.agent?.desc || "")).toLowerCase().includes(q.toLowerCase());
// 生圖助手對這個 LoRA 的認識（agent.rs 的 parse_lora_desc 寫進 lora_meta.agent）
const KIND_ZH = { style: "畫風", character: "角色", clothing: "服裝", concept: "概念", pose: "姿勢", detail: "細節", lighting: "光影", other: "其他" };
function agentDesc(l) {
  const a = l.agent;
  if (!a?.desc) return null;
  return el("div", { class: "agent-desc", title: (a.src === "user" ? "你寫的" : a.src === "probe" ? "助手試畫比較後寫的" : "助手讀線索寫的") + "（給助手挑 LoRA 用）\n" + a.desc },
    el("span", { class: "ag-kind" + (a.sure === false ? " unsure" : "") }, "助手：" + (KIND_ZH[a.kind] || a.kind || "其他") + (a.sure === false ? "？" : "")), a.desc_zh || a.desc);
}
const preview = (l) => (l.preview ? `url(/lora_preview/${encodeURIComponent(l.preview)})` : "");

function renderPage() {
  const q = $("#loraQ").value.trim();
  const g = $("#loraGrid");
  g.innerHTML = "";
  const items = list.filter((l) => match(l, q));
  $("#loraTotal").textContent = `${items.length} / ${list.length} 個`;
  if (!list.length) g.append(el("div", { class: "muted pad" }, "還沒有 LoRA。到「Civitai」分頁搜尋下載。"));
  for (const l of items) g.append(card(l));
}

function card(l) {
  const blur = app.state?.settings?.blur_nsfw && l.nsfw;
  return el("div", { class: "card" },
    el("div", { class: "ph" + (blur ? " blur" : ""), style: l.preview ? `background-image:${preview(l)}` : "" }, l.preview ? "" : "沒有預覽圖"),
    el("div", { class: "bd" },
      el("div", { class: "t" }, (l.fav ? "★ " : "") + title(l), FAM_BADGE[l.family] ? el("span", { class: "badge fam" }, FAM_BADGE[l.family]) : null),
      el("div", { class: "st" }, l.name),
      l.triggers?.length ? el("div", { class: "trig", title: "觸發詞" }, "觸發詞：" + l.triggers.join(", ")) : el("div", { class: "st" }, "沒有觸發詞"),
      l.note ? el("div", { class: "st", style: "white-space:pre-wrap" }, l.note) : null,
      agentDesc(l),
      el("div", { class: "ft" },
        el("span", { class: "sub" }, "預設強度"),
        el("input", { type: "number", step: 0.05, min: -2, max: 3, value: l.strength ?? 0.8, style: "width:70px", onchange: (e) => setMeta(l, { strength: +e.target.value }) })),
      el("div", { class: "ft" },
        el("button", { class: "btn sm primary", onclick: () => { import("./gen.js").then((g) => { g.addLora(l, true); app.showPage("gen"); toast(`已加入「${title(l)}」`, "ok"); }); } }, "加到生成"),
        el("button", { class: "btn sm", onclick: () => editTriggers(l) }, "改觸發詞"),
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
    renderPage();
  } catch (e) { toast(e.message, "err"); }
}

async function setMeta(l, patch, rerender) {
  Object.assign(l, await api("/api/loras/meta", { json: { name: l.name, ...patch } }));
  if (rerender) { await app.refreshState(); renderPage(); }
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

// ---------------------------------------------------------------- 挑選視窗
// fam：只列出這個家族的 LoRA（Anima 的 LoRA 套在 Qwen 2.1 上沒有用，反之亦然）。
// 也可以給判斷函式 (l) => 能不能用（匯入的工作流組：同家族或家族不明的都能接）；用函式時列表下面有「顯示全部」可以看被藏起來的
export function openPicker(cb, fam) {
  pickCb = cb;
  pickFam = fam || null;
  pickAll = false;
  $("#lpQ").value = "";
  renderPicker();
  openModal("#loraPicker");
  setTimeout(() => $("#lpQ").focus(), 50);
}

function renderPicker() {
  const q = $("#lpQ").value.trim();
  const g = $("#lpGrid");
  g.innerHTML = "";
  const fits = (x) => !pickFam || (typeof pickFam === "function" ? pickFam(x) : (x.family || "anima") === pickFam);
  const usable = pickAll ? list : list.filter(fits);
  if (!usable.length) g.append(el("div", { class: "muted pad" }, "還沒有這個模型能用的 LoRA。到「Civitai」分頁搜尋下載（記得選對基底模型）。"));
  for (const l of usable.filter((x) => match(x, q))) {
    const blur = app.state?.settings?.blur_nsfw && l.nsfw;
    g.append(el("div", { class: "card pick", onclick: () => { pickCb(l, $("#lpTrig").checked); closeModal("#loraPicker"); } },
      el("div", { class: "ph" + (blur ? " blur" : ""), style: l.preview ? `background-image:${preview(l)};aspect-ratio:1` : "aspect-ratio:1" }, l.preview ? "" : "無預覽"),
      el("div", { class: "bd" }, el("div", { class: "t" }, title(l)), l.triggers?.length ? el("div", { class: "trig" }, l.triggers.slice(0, 4).join(", ")) : null,
        l.note ? el("div", { class: "pick-note", title: l.note }, l.note) : null)));
  }
  // 匯入的工作流組：不同家族的 LoRA 先藏起來，需要時按「顯示全部」（選了也會在生成時被略過）
  const hidden = typeof pickFam === "function" && !pickAll ? list.filter((x) => !fits(x)).length : 0;
  if (hidden) g.append(el("div", { class: "muted sm pick-more" }, `已藏起 ${hidden} 個其他模型家族的 LoRA（用了也會被略過）。`,
    el("button", { class: "link", type: "button", onclick: () => { pickAll = true; renderPicker(); } }, "顯示全部")));
}
