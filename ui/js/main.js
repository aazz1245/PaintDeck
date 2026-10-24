// 進入點：分頁切換、websocket、載入伺服器狀態
import { $, $$, api, toast } from "./util.js";
import * as gen from "./gen.js";
import * as gallery from "./gallery.js";
import * as assets from "./assets.js";
import * as loras from "./loras.js";
import * as civitai from "./civitai.js";
import * as settings from "./settings.js";
import * as pe from "./pe.js";
import * as queue from "./queue.js";
import * as system from "./system.js";
import { app } from "./state.js";
import * as deck from "./deck.js";
import * as director from "./director.js";
import * as studio from "./studio.js";
import * as comic from "./comic.js";
import * as agent from "./agent.js";
import * as play from "./play.js";
import * as h3 from "./h3.js";
import * as h3chain from "./h3chain.js";
import * as shotsheet from "./shotsheet.js";
import * as framepick from "./framepick.js";
import * as charsheet from "./charsheet.js";
import * as i18n from "./i18n.js";

function showPage(p) {
  app.page = p;
  $$("#tabs button").forEach((b) => { b.classList.toggle("on", b.dataset.page === p); b.setAttribute("aria-selected", String(b.dataset.page === p)); });
  $$(".page").forEach((pg) => pg.classList.toggle("on", pg.id === `page-${p}`));
  if (p === "gallery") gallery.show();
  if (p === "assets") assets.show();
  if (p === "loras") loras.showPage();
  if (p === "civitai") civitai.show();
  if (p === "settings") settings.show();
  if (p === "director") { director.show(); studio.show(); }
  if (p === "comic") comic.show();
  if (p === "agent") agent.show();
}
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-page]"); if (b && !b.disabled) showPage(b.dataset.page); });
app.showPage = showPage;

// 好幾個地方會同時要求重讀（換設定、ComfyUI 上線、重新連線）：只收最後一次的結果，晚回的舊狀態不能蓋掉新的
let stateSeq = 0;
async function refreshState() {
  const seq = ++stateSeq;
  let st;
  try {
    st = await api("/api/state");
  } catch (e) {
    if (seq === stateSeq) toast("無法連到生圖站伺服器：" + e.message + "\n解法：從右下角系統列的生圖站圖示按右鍵「結束」，再重新開啟「繪匣 PaintDeck」（按視窗的 X 常常只是縮到系統列，程式還在）。", "err");
    return;
  }
  if (seq !== stateSeq) return;
  app.state = st;
  setOnline(app.state.online, app.state.remaining);
  gen.onState(app.state);
  loras.onState(app.state);
  settings.onState(app.state);
  pe.onStatus(app.state.pe);
  pe.refreshTask();
}

app.refreshState = refreshState;

function setOnline(on, remaining) {
  $("#comfyDot").classList.toggle("on", !!on);
  $("#comfyDot").title = on ? "ComfyUI 已連線" : "ComfyUI 沒有連線：點狀態列的系統狀態，按「重開 ComfyUI」";
  $("#comfyDot").setAttribute("aria-label", $("#comfyDot").title);
  deck.setOnline(!!on);
  if (remaining !== undefined) queue.onQueue(remaining);
}

// 斷線重連（伺服器重開、換版）後要重讀整份狀態：斷線那段時間的 comfy 事件收不到，模型清單和設定可能已經變了
let connectedOnce = false;
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "blob";
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return gen.onPreview(ev.data);
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case "hello": setOnline(m.online, m.remaining); if (connectedOnce) refreshState(); connectedOnce = true; break;
      case "comfy": setOnline(m.online); if (m.online) refreshState(); else toast("ComfyUI 連線中斷，正在重新連線…", "err"); break;
      case "queue": setOnline(true, m.remaining); if (!m.remaining) { $("#topProg > div").style.width = "0"; deck.idle(); } break;
      case "start": gen.onStart(m.job); queue.onStart(m.job); deck.onStart(m.job, gen.S.pending.has(m.job)); break;
      case "progress": gen.onProgress(m); queue.onProgress(m); deck.onProgress(m); $("#topProg > div").style.width = `${(100 * m.value) / m.max}%`; break;
      case "image": if (gen.S.pending.has(m.job)) queue.onImage(m.job, m.image); play.onImage(m.job, m.image); gen.onImage(m.job, m.image); gallery.onNewImage(m.image); charsheet.onImage(m.job, m.image); h3.onImage(m.job, m.image); framepick.onImage(m.job, m.image); break;
      case "director": case "director_llm": director.onEvent(m); break;
      case "comic": comic.onEvent(m); break;
      case "agent": case "agent_llm": case "agent_lora": agent.onEvent(m); break;
      case "agent_cloud": agent.onEvent(m); h3.onEvent(m); h3chain.onEvent(m); break;
      case "h3": h3.onEvent(m); break;
      case "h3chain": h3chain.onEvent(m); break;
      case "finish": {
        const mine = gen.S.pending.has(m.job);
        play.onFinish(m);
        gen.onFinish(m);
        queue.onFinish(m, gen.S.pending.size, mine);
        $("#topProg > div").style.width = "0";
        deck.onFinish(m);
        break;
      }
      case "download": civitai.onDownload(m); break;
      case "pe": if (app.state) app.state.pe = m; pe.onStatus(m); settings.onPe?.(m); deck.onPe(m); break;
    }
  };
  ws.onclose = () => { setOnline(false); setTimeout(connect, 2000); };
}

$("#peChip").onclick = async () => {
  if (!confirm("現在關掉 AI 改寫模型（llama-server）？正在改寫的會中斷。")) return;
  try { await api("/api/pe/stop", { json: {} }); toast("已關閉改寫模型", "ok"); } catch (e) { toast(e.message, "err"); }
};
// 改寫模型的閒置倒數：每 5 秒更新一次狀態列
setInterval(async () => { if (app.state?.pe?.running && !document.hidden) { try { const st = await api("/api/pe/status"); app.state.pe = st; pe.onStatus(st); } catch { /* 伺服器重開中 */ } } }, 5000);

// 沒綁 <label> 的選單、輸入框：拿旁邊那行小標題（.sub／.name／.lbl）當無障礙名稱，讀屏軟體才念得出是什麼（2026-10-20）。
// 要在 i18n.init() 前面做，換語言時 aria-label 會跟著翻。
function labelControls() {
  const near = (c) => {
    for (const p of [c.previousElementSibling, c.parentElement?.previousElementSibling]) {
      if (!p) continue;
      const t = p.matches(".sub, .name, .lbl, summary") ? p : p.querySelector(".sub, .name, .lbl");
      const s = t?.textContent.trim().replace(/\s+/g, " ");
      if (s) return s;
    }
    return "";
  };
  for (const c of $$("select, textarea, input:not([type=checkbox]):not([type=radio]):not([type=hidden])")) {
    if (c.closest("label, .hidden-inputs, [aria-hidden=true]") || c.getAttribute("aria-label") || c.getAttribute("aria-labelledby") || c.title) continue;
    if (c.id && document.querySelector(`label[for="${c.id}"]`)) continue;
    const s = near(c);
    if (s) c.setAttribute("aria-label", s);
  }
}
labelControls();

// 介面語言：存的不是繁中才載入（簡中 OpenCC、英文字典）；先翻好原始畫面再讓各頁初始化（觀景窗的字會被 deck.js 切成小段），
// 之後新長出來的字由 MutationObserver 接著翻。繁中直接回來，不用等。
await i18n.init();
deck.init();
system.init();
gen.init();
gallery.init();
assets.init();
loras.init();
civitai.init();
settings.init();
queue.init();
director.init();
studio.init();
h3.init();
h3chain.init();
shotsheet.init();
comic.init();
agent.init();
charsheet.init();
refreshState();
connect();

// 網址的 #gallery、#loras、#civitai、#settings、#director、#comic、#agent 直接打開那一頁；#jobs 打開任務面板、#help 打開說明（系統列選單也用這個）
function fromHash() {
  const h = location.hash.slice(1);
  if (["gen", "gallery", "assets", "loras", "civitai", "settings", "director", "comic", "agent"].includes(h)) showPage(h);
  else if (h === "jobs") queue.toggle();
  else if (h === "help") system.openHelp();
}
window.addEventListener("hashchange", fromHash);
fromHash();
