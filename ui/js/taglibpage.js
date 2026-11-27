// 左邊「隨機」頁（#taglib）：生成頁的分身。
// 左＝原生外掛 UI iframe（比照 LoRA 管理器：Anima 隨機＝Comfyui-Anima-Wardrobe-V6，Krea 2 隨機＝Comfyui-K2-Editorial）；
// 中＝借來的提示詞（含 AI 改寫）、LoRA 卡匣，底下黏著生成鈕＋最新一張；
// 右＝借來的模型與輸入、尺寸與模式、取樣（步數、CFG、張數、種子、整套設定）、附加（高解析修復、構圖控制、自動修臉、X/Y）。
import { $, el, api, toast, store } from "./util.js";
import { app } from "./state.js";
import { makeBorrower } from "./borrow.js";
import * as pe from "./pe.js";

const HOST_URL = {
  anima: "/plugin-host/host.html?engine=anima",
  krea2: "/plugin-host/host.html?engine=krea2",
};
const STATUS_URL = {
  anima: "/api/wardrobe/status",
  krea2: "/api/k2ed/status",
};
const INSTALL_URL = {
  anima: "/api/wardrobe/install",
  krea2: "/api/k2ed/install",
};

let lenders = [];
let engine = store.get("tl_engine", "anima") === "krea2" ? "krea2" : "anima";
const loadedFrame = { anima: false, krea2: false };
const latestPrompt = { anima: "", krea2: "" };
const pendingRerolls = new Map();
let rerollSeq = 1;

function frameOf(eng = engine) {
  return $(eng === "krea2" ? "#tlK2edFrame" : "#tlWardrobeFrame");
}

function applyMode() {
  return $("#tlApplyMode")?.value || store.get("tl_apply_mode", "replace");
}

/** 隨機產生器抽出來的整組提示詞 → 提示詞框（取代或接在後面），發 input 讓分段、自動完成那些跟著更新 */
function applyPrompt(text, how = applyMode()) {
  const clean = String(text || "").trim();
  if (!clean) return false;
  const ta = $("#prompt");
  if (!ta) return false;
  const cur = ta.value.trim();
  ta.value = how === "append" && cur ? `${cur.replace(/,\s*$/, "")}, ${clean}` : clean;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

const docks = (ids) => ids.map((id) => $(`[data-dock="${id}"]`)).filter(Boolean);

function syncTabs() {
  for (const b of document.querySelectorAll("#tlEngineTabs button[data-eng]")) {
    const on = b.dataset.eng === engine;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
}

async function restartComfy() {
  try { const deck = await import("./deck.js"); await deck.restartComfy(); } catch (e) { toast(e.message, "err"); }
  setTimeout(() => loadEngine(engine, true), 8000);
}

async function installEngine(eng) {
  const isK2 = eng === "krea2";
  toast(isK2 ? "正在從本機 Comfyui-K2-Editorial.zip 解壓安裝…" : "安裝中…（從 GitHub 抓，約幾十秒）");
  try {
    const r = await api(INSTALL_URL[eng], { json: {}, timeout: 300000 });
    toast(r.restart ? "裝好了：重開 ComfyUI 就能用" : "已經裝好了", "ok");
  } catch (e) {
    toast("安裝失敗：" + e.message, "err");
  }
  await loadEngine(eng, true);
}

function renderFallback(eng, st) {
  const box = $("#tlPluginFallback");
  if (!box) return;
  const isK2 = eng === "krea2";
  const title = isK2 ? "Krea 2 隨機（Comfyui-K2-Editorial）" : "Anima 隨機（Comfyui-Anima-Wardrobe-V6）";
  const nodes = [el("b", {}, title)];
  if (st?.error) {
    nodes.push(el("div", { class: "err sm" }, st.error));
  } else if (st?.remote) {
    nodes.push(el("div", { class: "notice sm" }, "現在連的是雲端的 ComfyUI：隨機產生器原生外掛要裝在本機的 ComfyUI。"));
  } else if (!st?.installed) {
    if (isK2) {
      if (st?.zip_found) {
        nodes.push(
          el("div", { class: "notice sm" }, `將使用資料夾內的 Comfyui-K2-Editorial.zip（${st.zip_path}）解壓安裝到本機 ComfyUI 的 custom_nodes。`),
          el("button", { type: "button", class: "akey go", onclick: () => installEngine("krea2") }, "從本機壓縮包安裝 Krea 2 外掛"),
        );
      } else {
        nodes.push(
          el("div", { class: "notice sm" }, "資料夾裡找不到 Comfyui-K2-Editorial.zip：請將壓縮包放在繪匣資料夾或其上層資料夾，再按重新檢查。"),
          el("button", { type: "button", class: "akey", onclick: () => loadEngine("krea2", true) }, "重新檢查"),
        );
      }
    } else {
      nodes.push(
        el("div", { class: "notice sm" }, "Anima 隨機使用 ComfyUI 外掛 Comfyui-Anima-Wardrobe-V6（原生面板），裝在本機 ComfyUI 的 custom_nodes。"),
        el("button", { type: "button", class: "akey go", onclick: () => installEngine("anima") }, "安裝 Anima 隨機外掛"),
      );
    }
  } else if (!st?.online) {
    nodes.push(
      el("div", { class: "notice sm" }, "本機的 ComfyUI 沒有連線：開著 ComfyUI 才能載入外掛原生介面。"),
      el("button", { type: "button", class: "akey", onclick: () => loadEngine(eng, true) }, "重新檢查"),
    );
  } else if (!st?.loaded) {
    nodes.push(
      el("div", { class: "notice sm" }, "外掛已安裝，重開一次 ComfyUI 就會載入原生介面。"),
      el("button", { type: "button", class: "akey go", onclick: restartComfy }, "重開 ComfyUI"),
    );
  }
  box.replaceChildren(...nodes);
  box.hidden = false;
  $("#tlWardrobeFrame").hidden = true;
  $("#tlK2edFrame").hidden = true;
}

async function loadEngine(eng = engine, forceReload = false) {
  syncTabs();
  const fb = $("#tlPluginFallback");
  const wFrame = $("#tlWardrobeFrame");
  const kFrame = $("#tlK2edFrame");
  if (!wFrame || !kFrame) return;

  let st;
  try { st = await api(STATUS_URL[eng]); } catch (e) { st = { error: e.message }; }
  if (!st?.loaded) {
    renderFallback(eng, st);
    return;
  }
  if (fb) fb.hidden = true;
  wFrame.hidden = eng !== "anima";
  kFrame.hidden = eng !== "krea2";
  const target = frameOf(eng);
  if (forceReload || !loadedFrame[eng] || !target.src || target.src === "about:blank") {
    loadedFrame[eng] = true;
    target.src = `${HOST_URL[eng]}&t=${Date.now()}`;
  }
}

/** 按「生成」前：勾了「生成前重抽」就請目前外掛重抽一次並填入提示詞（gen.js 呼叫） */
export async function beforeGenerate() {
  if (!$("#tlAutoRoll")?.checked) return;
  const target = frameOf(engine);
  if (!target || target.hidden || !target.contentWindow) return;
  const id = rerollSeq++;
  const text = await new Promise((resolve) => {
    const timer = setTimeout(() => { pendingRerolls.delete(id); resolve(""); }, 15000);
    pendingRerolls.set(id, (val) => { clearTimeout(timer); resolve(val || ""); });
    try { target.contentWindow.postMessage({ type: "PAINTDECK_PLUGIN_REROLL", id }, "*"); } catch {
      clearTimeout(timer);
      pendingRerolls.delete(id);
      resolve("");
    }
  });
  if (text) applyPrompt(text);
}

export function init() {
  lenders = [
    makeBorrower(docks(["prompt", "lora"]), $("#tlBorrowMid")),
    makeBorrower([$("#genRow")].filter(Boolean), $("#tlBorrowGen")),
    makeBorrower(docks(["source", "params", "sampler", "extra"]), $("#tlBorrowSide")),
  ];

  // 橋接控制列狀態還原
  const autoSync = $("#tlAutoSync");
  const modeSel = $("#tlApplyMode");
  const autoRoll = $("#tlAutoRoll");
  if (autoSync) {
    autoSync.checked = store.get("tl_auto_sync", true);
    autoSync.onchange = () => store.set("tl_auto_sync", autoSync.checked);
  }
  if (modeSel) {
    modeSel.value = store.get("tl_apply_mode", "replace");
    modeSel.onchange = () => store.set("tl_apply_mode", modeSel.value);
  }
  if (autoRoll) {
    autoRoll.checked = store.get("tl_auto_roll", false);
    autoRoll.onchange = () => store.set("tl_auto_roll", autoRoll.checked);
  }

  $("#tlApplyPrompt")?.addEventListener("click", () => {
    const txt = latestPrompt[engine];
    if (txt) {
      applyPrompt(txt);
      toast("已套用到提示詞框", "ok");
    } else {
      frameOf(engine)?.contentWindow?.postMessage({ type: "PAINTDECK_PLUGIN_GET_PROMPT" }, "*");
    }
  });

  $("#tlReloadPlugin")?.addEventListener("click", () => loadEngine(engine, true));

  for (const b of document.querySelectorAll("#tlEngineTabs button[data-eng]")) {
    b.onclick = () => {
      const next = b.dataset.eng === "krea2" ? "krea2" : "anima";
      if (next === engine) return;
      engine = next;
      store.set("tl_engine", engine);
      loadEngine(engine, false);
    };
  }
  syncTabs();

  // 接收來自原生外掛宿主頁 iframe 的提示詞與重抽回傳
  window.addEventListener("message", (e) => {
    if (e.origin && e.origin !== location.origin) return;
    const d = e.data;
    if (!d || typeof d !== "object") return;
    const eng = d.engine === "krea2" ? "krea2" : "anima";
    if (d.type === "PAINTDECK_PLUGIN_PROMPT") {
      if (typeof d.text === "string" && d.text.trim()) {
        latestPrompt[eng] = d.text.trim();
        if (eng === engine && (d.explicit || $("#tlAutoSync")?.checked)) {
          applyPrompt(latestPrompt[eng]);
          if (d.explicit) toast("已套用到提示詞框", "ok");
        }
      } else if (d.explicit) {
        toast("請先在左側外掛面板內隨機抽一次或生成預覽", "err");
      }
    } else if (d.type === "PAINTDECK_PLUGIN_REROLL_DONE") {
      const fn = pendingRerolls.get(d.id);
      if (fn) {
        pendingRerolls.delete(d.id);
        fn(d.text || latestPrompt[eng] || "");
      }
    }
  });

  $("#tlCompose").onclick = () => pe.composeFromPrompt();
  // 最新一張成品：跟著看圖區換；點了回生成頁看大圖
  const img = $("#viewImg"), last = $("#tlLast");
  const sync = () => { const src = img.currentSrc || img.getAttribute("src") || ""; last.hidden = !src; if (src) last.querySelector("img").src = src; };
  img.addEventListener("load", sync);
  sync();
  last.onclick = () => app.showPage("gen");
}

// 面板搬走時停靠區內容變短，捲動位置會被夾回 0：借之前記下來，還回去再捲回原位
let scrolls = [];

export function show() {
  if (!lenders[0].lent) scrolls = [...document.querySelectorAll("#page-gen .dock-zbody, #page-gen .dock-body")].map((e) => [e, e.scrollTop]);
  for (const b of lenders) b.lend();
  loadEngine(engine, false);
}

export function hide() {
  for (const b of lenders) b.giveBack();
  for (const [e, top] of scrolls) e.scrollTop = top;
  scrolls = [];
}
