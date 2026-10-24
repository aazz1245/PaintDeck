// 萬用工作流（2026-10-21）：生成頁選了「⚙ 生圖工作流」時左欄的「工作流參數」面板、把內建功能匯出成 ComfyUI 工作流、存檔小工具。
// 後端：server\api_wf.rs（欄位清單 fields、選項 options、匯出 export）、server\api_gen.rs（export_graph）；設計：design\萬用工作流與匯入匯出.md
// 面板的欄位從 ComfyUI 的 /object_info 長出來（型別、範圍、下拉選項）；改過的值存在這個瀏覽器（每個「工作流組＋模式」一份），
// 生成時以 params.wf_overrides 送出（鍵是「節點編號.欄位」）。
import { $, el, api, toast, store } from "./util.js";
import { app } from "./state.js";

// ---------------------------------------------------------------- 存檔
/** 存成檔的資料夾：記著上次存的地方，下次「另存新檔」從那裡開始 */
const lastDir = () => store.get("wfSaveDir", "");
// 存在磁碟根目錄（C:\x.json）時留 C:\，不能只剩 C:（那是「C 槽目前所在的資料夾」）
const keepDir = (path) => store.set("wfSaveDir", path.replace(/[\\/][^\\/]*$/, "").replace(/^([A-Za-z]:)$/, "$1\\"));

/** 把內建功能（照這些生成頁參數）存成 ComfyUI 的 API 格式工作流，後端加好 {{prompt}}、{{image}}… 標記。
 *  後端跳 Windows 的「另存新檔」讓使用者選位置、自己寫檔：回 {path, mode, family, filled}，按取消回 {cancelled: true}；失敗丟 Error */
export async function exportGraph(params) {
  const r = await api("/api/gen/export_graph", { json: { params, save: true, dir: lastDir() }, timeout: 0 });
  if (r.path) keepDir(r.path);
  return r;
}

/** 整組工作流存成檔（設定頁的「匯出」）：同上（POST，跳視窗的請求要過同源檢查），回 {path} 或 {cancelled: true} */
export async function exportSet(id) {
  const r = await api(`/api/image/workflows/${encodeURIComponent(id)}/export`, { json: { dir: lastDir() }, timeout: 0 });
  if (r.path) keepDir(r.path);
  return r;
}

/** 檔案總管打開存好的檔（選取它） */
export function reveal(path) {
  return api("/api/reveal", { json: { path } }).catch((e) => toast(e.message, "err"));
}

// ---------------------------------------------------------------- 改過的值（每個「工作流組＋模式」一份）
const OV_KEY = "wf_ov";
const ovAll = () => store.get(OV_KEY, {});
const curOv = () => (cur ? ovAll()[cur.key] || {} : {});

/** 目前這個「工作流組＋模式」改過的值（鍵只留還存在的欄位）；沒有就是 undefined */
export function overrides(setId, mode) {
  const key = `${setId}|${mode}`;
  const ov = ovAll()[key];
  if (!ov || !Object.keys(ov).length) return undefined;
  if (data && cur && cur.key === key) {
    const known = new Set(data.fields.map((f) => f.key));
    const o = Object.fromEntries(Object.entries(ov).filter(([k]) => known.has(k)));
    return Object.keys(o).length ? o : undefined;
  }
  return ov;
}

/** 把一組改過的值放回去（從圖庫「重用參數」帶回來時用） */
export function setOverrides(setId, mode, ov) {
  const all = ovAll();
  const key = `${setId}|${mode}`;
  if (ov && Object.keys(ov).length) all[key] = ov; else delete all[key];
  store.set(OV_KEY, all);
  if (cur && cur.key === key) render();
}

/** 已經被刪掉的工作流組留下的值清掉 */
function prune() {
  const sets = app.state?.models?.image_workflows;
  if (!sets) return;
  const ids = new Set(sets.map((w) => w.id.replace(/^wf:/, "")));
  const all = ovAll();
  let hit = false;
  for (const k of Object.keys(all)) if (!ids.has(k.slice(0, k.lastIndexOf("|")))) { delete all[k]; hit = true; }
  if (hit) store.set(OV_KEY, all);
}

// ---------------------------------------------------------------- 面板
let ctx = {};          // { adopt(vals)：把工作流原本的步數、CFG… 放回生成頁 }
let cur = null;        // 目前顯示的 { key, id（不含 wf:）, full, mode, name, pageSampler }
let data = null;       // 最近一次讀到的欄位清單
let err = "";          // 讀欄位失敗的原因
let loadSeq = 0, lastSig = "", advOpen = false, busy = "";

// 常用欄位的中文名（其他欄位直接用 ComfyUI 的欄位名，老手看得懂）
const LABEL = { steps: "步數", cfg: "CFG", sampler_name: "取樣器", scheduler: "排程", denoise: "重繪幅度", guidance: "Guidance",
  ckpt_name: "主模型檔", unet_name: "主模型檔", model_name: "主模型檔", lora_name: "LoRA 檔", strength_model: "LoRA 強度", strength_clip: "LoRA 文字強度" };
const SAMPLER_NODES = /^KSampler(Advanced)?$/;
const PAGE_FIELDS = ["steps", "cfg", "sampler_name", "scheduler"];
const NOTE = {
  inpaint: "局部重繪：輸入圖和遮罩由生成頁帶進去；遮罩範圍、擴張、柔化這些都照工作流，要改就在下面改。",
  upscale: "放大：輸入圖由生成頁帶進去；放大模型、倍率照工作流，要換就在下面改。",
  multiref: "多圖參考：參考圖依序放進標了 {{ref1}}、{{ref2}}… 的 Load Image 節點。",
};

export function init(c) {
  ctx = c || {};
  $("#wfReset").onclick = () => {
    if (!cur) return;
    setOverrides(cur.id, cur.mode, null);
    toast("已還原成工作流原本的值", "ok");
  };
  $("#wfPageSampler").onchange = setPageSampler;
}

/** set＝/api/state 的 models.image_workflows 其中一筆（沒選工作流就給 null）；mode＝目前的模式。
 *  選了別組、換了模式、讀失敗過、fresh（伺服器狀態剛更新：ComfyUI 剛上線、模型清單變了）時會（重新）讀欄位 */
export function sync(set, mode, fresh = false) {
  const box = $("#wfBox");
  if (!set) {
    box.hidden = true;
    cur = null; data = null; err = ""; lastSig = ""; busy = "";
    loadSeq++;
    return;
  }
  prune();
  box.hidden = false;
  const key = `${set.id.replace(/^wf:/, "")}|${mode}`;
  const same = cur?.key === key;
  cur = { key, id: set.id.replace(/^wf:/, ""), full: set.id, mode, name: set.name, pageSampler: !!set.options?.page_sampler };
  $("#wfPageSampler").checked = cur.pageSampler;
  $("#wfNote").textContent = NOTE[mode] || "";
  $("#wfNote").hidden = !NOTE[mode];
  if (!same) {
    data = null; err = ""; lastSig = ""; busy = "";
    $("#wfBody").replaceChildren(el("div", { class: "muted sm" }, "讀取工作流的欄位中…"));
    syncReset();
  }
  if (!same || fresh || err || !data) load();
}

async function load() {
  if (busy === cur.key) return;  // 同一份的請求還在路上（狀態連續更新幾次）：等它回來就好
  const mine = ++loadSeq, c = cur;
  busy = c.key;
  let r;
  try {
    r = await api(`/api/image/workflows/${encodeURIComponent(c.id)}/fields?mode=${encodeURIComponent(c.mode)}`, { timeout: 60000 });
  } catch (e) {
    if (mine === loadSeq && cur?.key === c.key) { data = null; err = e.message || "讀不到"; render(); }
    return;
  } finally {
    if (busy === c.key) busy = "";
  }
  if (mine !== loadSeq || cur?.key !== c.key) return;
  // 沒變就不重畫（輸入框裡正在打的字不會被洗掉）
  const sig = JSON.stringify([r.fields, cur.pageSampler]);
  const redraw = err || sig !== lastSig;
  err = ""; data = r; lastSig = sig;
  if (redraw) render();
}

function errBox() {
  const offline = !app.state?.online;
  return el("div", { class: "warnbox sm" },
    offline ? "ComfyUI 還沒連線：要靠它讀出工作流每個欄位能填什麼。連上之後這裡會自動長出來。" : `讀不到工作流的欄位：${err}`,
    " ", el("button", { class: "link", type: "button", onclick: () => { err = ""; load(); } }, "重新讀取"));
}

// ---------------------------------------------------------------- 欄位
const eff = (f) => (f.key in curOv() ? curOv()[f.key] : f.value);
const sameVal = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);
const isMissing = (f, v) => f.type === "COMBO" && f.options?.length > 0 && typeof v === "string" && !f.options.includes(v);
const looksFile = (v) => /\.(safetensors|ckpt|pt|pth|gguf|bin|sft|onnx)$/i.test(String(v));

function putOv(f, val) {
  const all = ovAll();
  const o = { ...(all[cur.key] || {}) };
  if (val === undefined || sameVal(val, f.value)) delete o[f.key]; else o[f.key] = val;
  if (Object.keys(o).length) all[cur.key] = o; else delete all[cur.key];
  store.set(OV_KEY, all);
  syncReset();
}

function syncReset() {
  $("#wfReset").hidden = !cur || !Object.keys(curOv()).length;
}

function fieldRow(f) {
  // 字串、檔案選單（模型、LoRA、VAE…名字長）占整列，其他兩個一排
  const wide = f.type === "STRING" || (f.type === "COMBO" && (looksFile(f.value) || (f.options || []).some(looksFile)));
  const row = el("div", { class: "wf-f" + (wide ? " full" : "") });
  const label = f.group === "common" && LABEL[f.input] ? LABEL[f.input] : f.input;
  const raw = label === f.input;  // 中文名會跟著介面語言翻；ComfyUI 的欄位名原樣
  const sub = el("span", { class: "sub", title: `${f.key}（${f.class}）`, translate: raw ? "no" : null }, label);
  const pg = el("span", { class: "wf-pg", hidden: true, title: "生成頁的設定會蓋在這個欄位上；在這裡改過的值優先" }, "生成頁");
  const hint = el("div", { class: "wf-hint err", hidden: true });
  const reset = el("button", { class: "icon wf-undo", type: "button", hidden: true, title: "這個欄位還原成工作流原本的值", "aria-label": "還原這個欄位",
    onclick: () => { putOv(f, undefined); build(); update(); } }, "↺");
  let ctl = null, read = () => eff(f);

  const build = () => {
    const v = eff(f);
    if (f.type === "BOOLEAN") {
      ctl.checked = !!v;
    } else if (f.type === "COMBO" && f.options?.length) {
      ctl.value = String(ctl._list.indexOf(v));
    } else {
      ctl.value = v ?? "";
    }
  };

  if (f.type === "BOOLEAN") {
    ctl = el("input", { type: "checkbox" });
    ctl.onchange = () => { putOv(f, ctl.checked); update(); };
    read = () => ctl.checked;
    row.append(el("label", { class: "check wf-bool" }, ctl, el("span", { translate: raw ? "no" : null }, label), pg), hint, reset);
  } else if (f.type === "COMBO" && f.options?.length) {
    // 目前的值不在選項裡（別人的模型檔名）：照樣列在最前面，標起來提醒使用者換
    const v = eff(f), list = f.options.slice();
    if (!list.includes(v) && v !== undefined && v !== null) list.unshift(v);
    ctl = el("select", { translate: "no" }, list.map((o, i) => el("option", { value: String(i) }, f.options.includes(o) ? String(o) : `⚠ ${o}`)));
    ctl._list = list;
    ctl.onchange = () => { putOv(f, list[+ctl.value]); update(); };
    read = () => list[+ctl.value];
    row.append(el("div", { class: "wf-lbl" }, sub, pg, reset), ctl, hint);
  } else if (f.type === "INT" || f.type === "FLOAT") {
    ctl = el("input", { type: "number", min: f.min, max: f.max, step: f.step ?? (f.type === "INT" ? 1 : "any") });
    ctl.onchange = () => {
      let n = ctl.value === "" ? NaN : +ctl.value;
      if (!Number.isFinite(n)) n = f.value;  // 清空＝還原
      if (f.type === "INT") n = Math.round(n);
      if (typeof f.min === "number") n = Math.max(f.min, n);
      if (typeof f.max === "number") n = Math.min(f.max, n);
      ctl.value = n;
      putOv(f, n);
      update();
    };
    read = () => (ctl.value === "" ? f.value : +ctl.value);
    row.append(el("div", { class: "wf-lbl" }, sub, pg, reset), ctl, hint);
  } else {
    // STRING（或選項讀不到的下拉）
    ctl = f.multiline ? el("textarea", { rows: 3, spellcheck: "false" }) : el("input", { type: "text", spellcheck: "false" });
    ctl.onchange = () => { putOv(f, ctl.value); update(); };
    read = () => ctl.value;
    row.append(el("div", { class: "wf-lbl" }, sub, pg, reset), ctl, hint);
  }
  build();

  const update = () => {
    const modified = f.key in curOv();
    row.classList.toggle("mod", modified);
    reset.hidden = !modified;
    const miss = isMissing(f, read());
    row.classList.toggle("miss", miss);
    hint.hidden = !miss;
    if (miss) hint.textContent = looksFile(read()) ? "這台電腦沒有這個檔：請選一個" : "這台 ComfyUI 沒有這個選項：請選一個";
    // 生成頁的值會蓋上去的欄位（勾了「用生成頁的步數、CFG、取樣器」，或圖生圖／局部重繪的重繪幅度）
    const overlay = SAMPLER_NODES.test(f.class) && ((cur.pageSampler && PAGE_FIELDS.includes(f.input))
      || (f.input === "denoise" && (cur.mode === "img2img" || cur.mode === "inpaint")));
    pg.hidden = !overlay || modified;
    updateBanner();
  };
  row._update = update;
  update();
  return row;
}

function nodeBlocks(list) {
  const groups = new Map();
  for (const f of list) {
    if (!groups.has(f.node)) groups.set(f.node, []);
    groups.get(f.node).push(f);
  }
  return [...groups.values()].map((fs) => {
    const f0 = fs[0];
    return el("div", { class: "wf-node" },
      el("div", { class: "wf-nh" }, el("b", { translate: "no" }, f0.title), el("span", { class: "muted", translate: "no" }, ` #${f0.node}`),
        f0.node_missing ? el("div", { class: "wf-hint err" }, `你的 ComfyUI 沒有這個節點：${f0.class}（要先裝對應的自訂節點，不然生成會失敗）`) : null),
      el("div", { class: "wf-grid" }, fs.map(fieldRow)));
  });
}

function updateBanner() {
  const b = $("#wfBanner");
  if (!b || !data) return;
  const shown = data.fields.filter((f) => !f.auto);
  const miss = shown.filter((f) => isMissing(f, eff(f)));
  const nodes = [...new Set(data.fields.filter((f) => f.node_missing).map((f) => f.class))];
  const kids = [];
  if (miss.length) kids.push(el("div", {}, `有 ${miss.length} 個欄位選的檔案這台電腦找不到（標紅的）：不換的話生成會失敗。`));
  if (nodes.length) kids.push(el("div", {}, `你的 ComfyUI 沒有這些節點：${nodes.join("、")}（要先裝對應的自訂節點）。`));
  b.hidden = !kids.length;
  b.replaceChildren(...kids);
}

function render() {
  const body = $("#wfBody");
  syncReset();
  if (err) return body.replaceChildren(errBox());
  if (!data) return;
  const shown = data.fields.filter((f) => !f.auto);
  const common = shown.filter((f) => f.group === "common");
  const adv = shown.filter((f) => f.group !== "common");
  const kids = [el("div", { class: "warnbox sm", id: "wfBanner", hidden: true }), ...nodeBlocks(common)];
  if (!common.length) kids.push(el("div", { class: "muted sm" }, "這個工作流沒有常用的取樣參數可以調。"));
  if (adv.length) {
    const holder = el("div", { class: "wf-adv" });
    const d = el("details", { class: "fold", id: "wfAdv" }, el("summary", {}, "進階（全部欄位）", el("span", { class: "muted sm" }, `${adv.length} 個`)), holder);
    let built = false;
    const open = () => { if (!built) { built = true; holder.replaceChildren(...nodeBlocks(adv)); } };
    d.addEventListener("toggle", () => { advOpen = d.open; if (d.open) open(); });
    d.open = advOpen || adv.some((f) => isMissing(f, eff(f)));
    if (d.open) open();
    kids.push(d);
  }
  const autoN = data.fields.length - shown.length;
  if (autoN) kids.push(el("div", { class: "muted sm" }, `另有 ${autoN} 個欄位由生成頁自動填（提示詞、種子、寬高、輸入圖、存檔名）。`));
  body.replaceChildren(...kids);
  updateBanner();
}

// ---------------------------------------------------------------- 「用生成頁的步數、CFG、取樣器」
/** 工作流第一個取樣節點原本的步數、CFG、取樣器、排程（打開「用生成頁的」時把生成頁的旋鈕先對齊它，不然會拿 Anima 的預設去跑別的模型） */
function samplerValues() {
  const fs = (data?.fields || []).filter((f) => SAMPLER_NODES.test(f.class) && PAGE_FIELDS.includes(f.input));
  if (!fs.length) return null;
  const node = fs[0].node, v = {};
  for (const f of fs) if (f.node === node) v[f.input] = f.value;
  return v;
}

async function setPageSampler() {
  if (!cur) return;
  const on = $("#wfPageSampler").checked, c = cur;
  try {
    await api(`/api/image/workflows/${encodeURIComponent(c.id)}/options`, { json: { page_sampler: on } });
  } catch (e) {
    $("#wfPageSampler").checked = !on;
    return toast("沒辦法改：" + e.message, "err");
  }
  const vals = on ? samplerValues() : null;
  if (vals) ctx.adopt?.(vals);
  await app.refreshState();
  toast(on ? "已改用生成頁的步數、CFG、取樣器、排程" + (vals ? "（先把它們對齊工作流原本的值，再自己調）" : "") : "步數、CFG、取樣器、排程回到照工作流", "ok");
}
