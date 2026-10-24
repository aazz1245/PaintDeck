// 影片工作流的「對應與參數」（2026-10-23）：設定頁 → 影片模型 → 選一個匯入的工作流 → 「對應與參數…」。
// 自動判斷不對（或判斷不出來：好幾個 Load Image、好幾個提示詞框）的，自己指定提示詞放哪、首格圖用哪個 Load Image；
// 任何欄位可以固定改值，或釘到「動起來」視窗每次調（例：LoRA 強度、速度滑桿、步數）。
// 後端：video_wf.rs 的 Mapping／detail／save_map，server\api_video.rs（GET／POST /api/video/workflows/{id}）。
// 欄位清單跟生圖工作流的參數面板同一套（image_wf::field_rows：型別、範圍、下拉選項從 ComfyUI 的 /object_info 來）
import { $, el, api, toast, openModal, closeModal } from "./util.js";

let D = null;      // 後端給的編輯資料
let M = null;      // 正在改的對應設定 {prompt?, image?, values, pins}
let saved = null;  // 存好後叫它（設定頁重讀清單）
let filter = "";

const same = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);
const short = (s, n = 40) => (s.length > n ? s.slice(0, n) + "…" : s);

/** 打開編輯視窗：id＝影片工作流代號；done(workflow)＝存好後 */
export async function open(id, done) {
  saved = done;
  filter = "";
  $("#vmTitle").textContent = "對應與參數";
  $("#vmBody").replaceChildren(el("div", { class: "muted sm" }, "讀取工作流中…"));
  openModal("#vidMapModal");
  try {
    D = await api(`/api/video/workflows/${encodeURIComponent(id)}`, { timeout: 60000 });
  } catch (e) {
    $("#vmBody").replaceChildren(el("div", { class: "warnbox sm" }, "讀不到這個工作流：" + e.message));
    return;
  }
  M = structuredClone(D.map || {});
  M.values ||= {};
  M.pins ||= [];
  $("#vmTitle").textContent = `對應與參數：${D.name}`;
  render();
}

// ---------------------------------------------------------------- 提示詞、首格圖
function promptBox() {
  const chosen = new Set(M.prompt ? M.prompt.map(([n, k]) => `${n}.${k}`) : D.used?.prompt || D.auto.prompt || []);
  const autoTxt = D.auto.prompt ? `自動判斷：${D.auto.prompt.join("、")}` : `自動判斷不出來：${D.auto.prompt_error}`;
  const list = D.texts.map((t) => {
    const cb = el("input", { type: "checkbox", checked: chosen.has(t.key) });
    cb.onchange = () => {
      const keys = [...$("#vmPrompt").querySelectorAll("input:checked")].map((x) => x.dataset.key);
      M.prompt = keys.map((k) => k.split(/\.(.+)/).slice(0, 2));
      paintStatus();
    };
    cb.dataset.key = t.key;
    return el("label", { class: "check vm-text", title: t.preview }, cb,
      el("span", { translate: "no" }, `${t.title} #${t.node} · ${t.input}`), el("span", { class: "muted sm", translate: "no" }, short(t.preview)));
  });
  return el("div", { class: "vm-sec" },
    el("div", { class: "row between" }, el("b", {}, "提示詞放哪"),
      el("button", { class: "link", type: "button", onclick: () => { delete M.prompt; render(); } }, "改回自動")),
    el("div", { class: "muted sm" }, M.prompt ? "自己指定：勾的每一格都會換成「動起來」寫的內容（文字裡有 {{prompt}} 的只換那幾個字）" : autoTxt),
    el("div", { class: "vm-list", id: "vmPrompt" }, list.length ? list : el("div", { class: "muted sm" }, "這個工作流沒有文字欄位")));
}

function imageBox() {
  const sel = el("select", { id: "vmImage" },
    el("option", { value: "__auto" }, D.auto.image_error ? "自動判斷（判斷不出來：好幾個 Load Image）" : `自動判斷（${D.auto.image ? "#" + D.auto.image : "沒有"}）`),
    el("option", { value: "" }, "沒有：只能文生影片"),
    ...D.loads.map((n) => el("option", { value: n.node, translate: "no" }, `${n.title} #${n.node}`)));
  sel.value = M.image === undefined ? "__auto" : M.image;
  sel.onchange = () => {
    if (sel.value === "__auto") delete M.image; else M.image = sel.value;
    paintStatus();
  };
  return el("div", { class: "vm-sec" }, el("b", {}, "首格圖放哪個 Load Image"),
    el("div", { class: "muted sm" }, "「動起來」那張圖會放進這裡；其他 Load Image 照工作流原本的圖"), sel);
}

// ---------------------------------------------------------------- 欄位：固定改值、釘到「動起來」
const val = (f) => (f.key in M.values ? M.values[f.key] : f.value);
const pinOf = (f) => M.pins.find((p) => p.key === f.key);

function control(f, onset) {
  const v = val(f);
  if (f.type === "BOOLEAN") {
    const c = el("input", { type: "checkbox", checked: !!v });
    c.onchange = () => onset(c.checked);
    return c;
  }
  if (f.type === "COMBO" && f.options?.length) {
    const list = f.options.slice();
    if (!list.includes(v)) list.unshift(v);
    const c = el("select", { translate: "no" }, list.map((o, i) => el("option", { value: String(i) }, f.options.includes(o) ? String(o) : `⚠ ${o}`)));
    c.value = String(list.indexOf(v));
    c.onchange = () => onset(list[+c.value]);
    return c;
  }
  if (f.type === "INT" || f.type === "FLOAT") {
    const c = el("input", { type: "number", min: f.min, max: f.max, step: f.step ?? (f.type === "INT" ? 1 : "any"), value: v });
    c.onchange = () => {
      let n = c.value === "" ? f.value : +c.value;
      if (f.type === "INT") n = Math.round(n);
      c.value = n;
      onset(n);
    };
    return c;
  }
  const c = el("input", { type: "text", spellcheck: "false", value: v ?? "" });
  c.onchange = () => onset(c.value);
  return c;
}

function fieldRow(f) {
  const row = el("div", { class: "wf-f" + (f.type === "STRING" ? " full" : "") });
  const paint = () => row.classList.toggle("mod", f.key in M.values);
  const ctl = control(f, (x) => {
    if (same(x, f.value)) delete M.values[f.key]; else M.values[f.key] = x;
    paint();
  });
  const pin = el("input", { type: "checkbox", checked: !!pinOf(f) });
  const name = el("input", { type: "text", placeholder: f.input, value: pinOf(f)?.label || "", hidden: !pinOf(f), maxlength: 30,
    title: "在「動起來」視窗顯示的名字（不填就用欄位名）" });
  pin.onchange = () => {
    M.pins = M.pins.filter((p) => p.key !== f.key);
    if (pin.checked) M.pins.push({ key: f.key, label: name.value.trim() });
    name.hidden = !pin.checked;
  };
  name.onchange = () => { const p = pinOf(f); if (p) p.label = name.value.trim(); };
  row.append(el("div", { class: "wf-lbl" }, el("span", { class: "sub", translate: "no", title: `${f.key}（${f.class}）` }, f.input),
    el("label", { class: "check vm-pin", title: "釘到「動起來」視窗：每次生成前可以調" }, pin, "動起來可調")), ctl, name);
  paint();
  return row;
}

// 照搜尋字過濾，一個節點一塊
function nodeBlocks() {
  const q = filter.trim().toLowerCase();
  const shown = D.fields.filter((f) => !f.auto && (!q || `${f.title} ${f.class} ${f.input} #${f.node}`.toLowerCase().includes(q)));
  if (!shown.length) return [el("div", { class: "muted sm" }, q ? "沒有符合的欄位" : "沒有可以改的欄位")];
  const groups = new Map();
  for (const f of shown) {
    if (!groups.has(f.node)) groups.set(f.node, []);
    groups.get(f.node).push(f);
  }
  return [...groups.values()].map((fs) => el("div", { class: "wf-node" },
    el("div", { class: "wf-nh" }, el("b", { translate: "no" }, fs[0].title), el("span", { class: "muted", translate: "no" }, ` #${fs[0].node}`),
      fs[0].node_missing ? el("div", { class: "wf-hint err" }, `你的 ComfyUI 沒有這個節點：${fs[0].class}`) : null),
    el("div", { class: "wf-grid" }, fs.map(fieldRow))));
}

function fieldsBox() {
  const search = el("input", { type: "search", placeholder: "找節點或欄位（例：lora、steps、#53）", value: filter });
  search.oninput = () => { filter = search.value; $("#vmFields").replaceChildren(...nodeBlocks()); };
  return el("div", { class: "vm-sec" },
    el("b", {}, "其他欄位"),
    el("div", { class: "muted sm" }, "改了值＝這個工作流以後都用新的值；勾「動起來可調」＝每次在「動起來」視窗調。提示詞、首格圖、種子、存檔名由生圖站自己填，不列在這裡。"),
    D.info_known ? null : el("div", { class: "warnbox sm" }, "ComfyUI 沒連線：欄位型別用猜的、沒有下拉選項。連上後重開這個視窗就會有。"),
    search, el("div", { class: "vm-fields", id: "vmFields" }, ...nodeBlocks()));
}

// ---------------------------------------------------------------- 狀態、存檔
function paintStatus() {
  const s = $("#vmStatus");
  if (!s) return;
  s.className = "sm " + (D.error && !M.prompt && M.image === undefined ? "warnbox" : "muted");
  s.textContent = D.error && !M.prompt && M.image === undefined
    ? `照現在的設定還看不懂：${D.error}`
    : "按「儲存」後生圖站會照這裡的設定換提示詞、首格圖、套上改過的值。";
}

function render() {
  $("#vmBody").replaceChildren(el("div", { id: "vmStatus" }), promptBox(), imageBox(), fieldsBox());
  paintStatus();
}

async function post(map, msg) {
  try {
    const r = await api(`/api/video/workflows/${encodeURIComponent(D.id)}`, { json: { map } });
    const w = r.workflow;
    toast(w.error ? `${msg}，但還看不懂：${w.error}` : msg, w.error ? "err" : "ok");
    closeModal("#vidMapModal");
    saved?.(w);
  } catch (e) { toast(e.message, "err"); }
}

export function init() {
  $("#vmSave").onclick = () => {
    if (!M) return;
    const map = { values: M.values, pins: M.pins };
    if (M.prompt?.length) map.prompt = M.prompt;
    else if (M.prompt) return toast("提示詞至少要勾一格（或按「改回自動」）", "err");
    if (M.image !== undefined) map.image = M.image;
    post(map, "對應與參數已儲存");
  };
  $("#vmClear").onclick = () => {
    if (!D || !confirm("清掉這個工作流所有的對應與參數，回到全部自動判斷？")) return;
    post(null, "已清掉，回到全部自動判斷");
  };
}
