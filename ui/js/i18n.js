// 介面語言（2026-10-20）：繁體中文是原文；简体中文用 OpenCC 的「台灣詞→大陸詞」整頁自動轉（vendor\opencc-t2cn.js，MIT）；
// English 查字典 i18n\en.json（tools\i18n_extract.py 從 index.html、ui\js、Rust 回給網頁的訊息抽出來翻的：exact＝整句、patterns＝含變數的句型）。
// 只換畫面上的字：text node 跟 title／placeholder／aria-label；輸入框裡的值、標了 translate="no" 的地方（提示詞的上色層等）不動。
// confirm／alert／prompt 的訊息也照翻。原文記在 WeakMap（程式改字時分得出是新字還是翻過的字）；設定頁換語言會重新整理頁面（choose）。
import { store } from "./util.js";

export const LANGS = { "zh-TW": "繁體中文", "zh-CN": "简体中文", en: "English" };
const HTML_LANG = { "zh-TW": "zh-Hant-TW", "zh-CN": "zh-Hans-CN", en: "en" };
const ATTRS = ["title", "placeholder", "aria-label"];
const SKIP = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "NOSCRIPT"]);  // TEXTAREA 只翻 placeholder，內容（doText）不碰
const CJK = /[㐀-鿿豈-﫿]/;

let lang = "zh-TW";
let toCN = null;              // OpenCC 轉換函式
let exact = null, pats = [];  // 英文字典
const cache = new Map();
const origText = new WeakMap(), shownText = new WeakMap();
const origAttr = new WeakMap(), shownAttr = new WeakMap();
let obs = null;

export const current = () => lang;

// ---------------------------------------------------------------- 字串
async function load(l) {
  if (l === "zh-CN" && !toCN) {
    const { Converter } = await import(new URL("../vendor/opencc-t2cn.js", import.meta.url));
    toCN = Converter({ from: "twp", to: "cn" });
  }
  if (l === "en" && !exact) {
    const d = await (await fetch(new URL("../i18n/en.json", import.meta.url))).json();
    exact = new Map(Object.entries(d.exact || {}));
    // 句型：{0}、{1}… 是變數；用「最長一段含中文的固定字」先篩，再用正規式比對（「約 {0} token」的錨點是「約 」不是「 token」）
    pats = (d.patterns || []).map(([zh, en]) => {
      const parts = zh.split(/\{(\d+)\}/);
      let re = "^", order = [];
      parts.forEach((p, i) => { if (i % 2) { re += "([\\s\\S]+?)"; order.push(+p); } else re += p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); });
      const anchor = parts.filter((p, i) => !(i % 2) && CJK.test(p)).sort((a, b) => b.length - a.length)[0] || "";
      return { re: new RegExp(re + "$"), order, en, anchor };
    }).filter((p) => p.anchor);
  }
}

function enPat(s) {
  for (const p of pats) {
    if (!s.includes(p.anchor)) continue;
    const m = p.re.exec(s);
    if (!m) continue;
    const args = {};
    p.order.forEach((k, i) => { const v = m[i + 1]; args[k] = CJK.test(v) && v.length < s.length ? (enCore(v) ?? v) : v; });
    return p.en.replace(/\{(\d+)\}/g, (_, k) => args[k] ?? "");
  }
  return null;
}

// 沒有整句也沒有句型：照標點切開，一段一段查（至少有一段查到才算）
const SEP = /(・|｜|／|、|，|。|：|；|（|）|\n)/;
const SEP_EN = { "・": " · ", "｜": " | ", "／": " / ", "、": ", ", "，": ", ", "。": ". ", "：": ": ", "；": "; ", "（": " (", "）": ") ", "\n": "\n" };
function enPieces(s) {
  const parts = s.split(SEP);
  if (parts.length < 2) return null;
  let hit = false;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2) { out.push(SEP_EN[p] ?? p); continue; }
    const t = p.trim();
    if (!t || !CJK.test(t)) { out.push(p); continue; }
    let v = exact.get(t) ?? enPat(t);
    // 「・{0} 個版本」「（之後可以到…還原）」這種連前後的標點才是一句：把標點併進來查，查到就不再另外輸出那個標點
    const prev = i > 0 ? parts[i - 1] : "", next = i + 1 < parts.length ? parts[i + 1] : "";
    let eatPrev = false, eatNext = false;
    for (const [w, a, b] of [[prev + t, 1, 0], [t + next, 0, 1], [prev + t + next, 1, 1]]) {
      if (v != null) break;
      if ((a && !prev) || (b && !next)) continue;
      v = exact.get(w) ?? enPat(w);
      if (v != null) { eatPrev = !!a; eatNext = !!b; }
    }
    if (eatPrev) out[out.length - 1] = "";
    if (v != null) { hit = true; out.push(p.replace(t, () => v)); } else out.push(p);
    if (eatNext) { out.push(""); i++; }
  }
  return hit ? out.join("").replace(/ {2,}/g, " ").trim() : null;
}

// 最後一招：照空白切（「直 13:19」「◆ 傳教士（正常位）」這種程式自己拼的）
function enWords(s) {
  const parts = s.split(/(\s+)/);
  if (parts.length < 3) return null;
  let hit = false;
  const out = parts.map((p) => {
    if (!CJK.test(p)) return p;
    const v = exact.get(p) ?? enPat(p) ?? enPieces(p);
    if (v != null) hit = true;
    return v ?? p;
  });
  return hit ? out.join("") : null;
}

const cjkLeft = (s) => (s == null ? Infinity : (s.match(/[㐀-鿿豈-﫿]/g) || []).length);
function enCore(s) {
  const v = exact.get(s) ?? enPat(s);
  if (v != null) return v;
  // 「無法使用：」＋伺服器回的錯誤：冒號前後各翻各的
  const i = s.indexOf("：");
  if (i > 0 && i < s.length - 1) {
    const L = exact.get(s.slice(0, i + 1)) ?? exact.get(s.slice(0, i)), R = L != null ? enCore(s.slice(i + 1)) : null;
    if (R != null) return L.replace(/[:：]\s*$/, "") + ": " + R;
  }
  // 照標點切、照空白切；要每一段都查得到才算（只翻得了一半的多半是使用者自己寫的中文：提示詞、對話、檔名，維持原樣）
  const a = enPieces(s);
  if (!cjkLeft(a)) return a;
  const b = enWords(s);
  return cjkLeft(b) ? null : b;
}

/** 一段字照目前的語言轉（繁中原樣） */
export function tr(s) {
  if (lang === "zh-TW" || !s || !CJK.test(s)) return s;
  const k = lang + "\u0000" + s;
  if (cache.has(k)) return cache.get(k);
  let v = s;
  if (lang === "zh-CN") v = toCN(s);
  else {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    const t = enCore(m[2]);
    if (t != null) v = m[1] + t + m[3];
  }
  if (cache.size > 20000) cache.clear();
  cache.set(k, v);
  return v;
}

// ---------------------------------------------------------------- 畫面
const skipEl = (e) => SKIP.has(e.tagName) || e.getAttribute("translate") === "no" || e.isContentEditable;
function skipped(node) {
  for (let e = node.nodeType === 1 ? node : node.parentElement; e; e = e.parentElement) if (skipEl(e)) return true;
  return false;
}

function doText(t) {
  if (t.parentElement?.tagName === "TEXTAREA") return;
  const cur = t.nodeValue;
  if (shownText.get(t) !== cur) {
    // 第一次看到，或程式後來自己改了字：沒有中文就不用記（舊的原文也要丟掉，不然換回繁中會蓋回舊字）
    if (!CJK.test(cur)) { origText.delete(t); shownText.set(t, cur); return; }
    origText.set(t, cur);
  }
  const o = origText.get(t);
  if (o == null) return;
  const v = lang === "zh-TW" ? o : tr(o);
  if (v !== cur) t.nodeValue = v;
  shownText.set(t, v);
}

function doAttrs(e) {
  const keep = e.getAttribute("data-i18n-keep") || "";  // 例：圖庫格子的 aria-label 是使用者的提示詞，標 data-i18n-keep="aria-label"
  for (const a of ATTRS) {
    const cur = e.getAttribute(a);
    if (cur == null || keep.includes(a)) continue;
    const o0 = origAttr.get(e) || {}, s0 = shownAttr.get(e) || {};
    if (s0[a] !== cur) {
      if (!CJK.test(cur)) { delete o0[a]; s0[a] = cur; shownAttr.set(e, s0); continue; }
      o0[a] = cur; origAttr.set(e, o0);
    }
    const o = o0[a];
    if (o == null) continue;
    const v = lang === "zh-TW" ? o : tr(o);
    if (v !== cur) e.setAttribute(a, v);
    s0[a] = v; shownAttr.set(e, s0);
  }
}

function walk(root) {
  if (root.nodeType === 3) { if (!skipped(root)) doText(root); return; }
  if (root.nodeType !== 1 || skipped(root)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && skipEl(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.currentNode; n; n = w.nextNode()) {
    if (n.nodeType === 3) doText(n);
    else doAttrs(n);
  }
}

// 監看器在載入這支檔案時就建好：同一批 DOM 變動，先建的監看器先收到通知，
// 這樣會比 deck.js 把觀景窗的中文切成 .zh 小段（watchZh）更早翻好整句。
const watcher = new MutationObserver((recs) => {
  for (const r of recs) {
    if (r.type === "childList") r.addedNodes.forEach(walk);
    else if (r.type === "characterData") { if (!skipped(r.target)) doText(r.target); }
    else if (r.type === "attributes" && !skipped(r.target)) doAttrs(r.target);
  }
});
function observe() {
  if (obs) return;
  obs = watcher;
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

// 對話框的訊息也翻（原生 confirm／alert／prompt）
for (const k of ["alert", "confirm", "prompt"]) {
  const f = window[k].bind(window);
  window[k] = (msg, ...a) => f(typeof msg === "string" ? tr(msg) : msg, ...a);
}

/** 換語言：存起來、整頁重翻（換回繁中＝還原原文、停止監看） */
export async function setLang(l) {
  if (!LANGS[l]) l = "zh-TW";
  try { await load(l); } catch (e) { console.error("載入語言失敗", e); l = "zh-TW"; }
  lang = l;
  store.set("lang", l);
  document.documentElement.lang = HTML_LANG[l];
  walk(document.documentElement);
  if (l === "zh-TW") { obs?.disconnect(); obs = null; } else observe();
}

/** 設定頁換語言：存起來、重新整理頁面。
 * 不在原地重翻：觀景窗、狀態列的字被 deck.js 切成 .zh 小段後，原文對不回去（簡中切回繁中會卡住幾個簡體字），
 * 重新整理就會照 main.js 的順序「先翻原始畫面、再初始化各頁」，一定乾淨。輸入的表單 gen.js 本來就會存。 */
export function choose(l) {
  if (!LANGS[l]) l = "zh-TW";
  if (l === lang) return;
  store.set("lang", l);
  location.reload();
}

/** 還沒選過語言：照系統語言。繁中（台港澳、zh-Hant）→ 繁中；其他中文 → 簡中；其他語言 → English */
function systemLang() {
  const s = String((navigator.languages && navigator.languages[0]) || navigator.language || "").toLowerCase();
  if (!s || /^zh-(tw|hk|mo|hant)/.test(s)) return "zh-TW";
  return s.startsWith("zh") ? "zh-CN" : "en";
}

/** 開站時呼叫一次 */
export async function init() {
  const l = store.get("lang", null) || systemLang();
  if (l !== "zh-TW") await setLang(l);
}
