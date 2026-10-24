// ---- 下面這段是 tools\fablecut_i18n\runtime.js（換字的程式） ----
// 剪輯台中文化：FableCut 本體不動，只在畫面上把英文換成繁中／簡中（字典在上面 window.__ANIMA_I18N__）。
// 語言：生圖站嵌進來時網址帶 ?lang=zh-TW|zh-CN|en（ui\js\studio.js），記在這個網址自己的 localStorage；沒帶就用上次的，再沒有就繁中。
// 只換給人看的字：text node、title／placeholder／aria-label、alert／confirm／prompt、監看螢幕上幾句固定提示（fillText 白名單）。
// 輸入框的值、textarea、可編輯區、<kbd>、<code> 不碰；<option> 沒寫 value 的先把原文補成 value，選到的值才不會跟著變。
(function () {
  "use strict";
  const ALL = window.__ANIMA_I18N__ || {};
  let lang = null;
  try { lang = new URLSearchParams(location.search).get("lang"); } catch (e) { /* 沒網址參數 */ }
  try {
    if (lang) localStorage.setItem("anima_lang", lang);
    else lang = localStorage.getItem("anima_lang");
  } catch (e) { /* 無痕模式 */ }
  if (lang !== "zh-CN" && lang !== "en") lang = "zh-TW";
  if (lang === "en" || !ALL["zh-TW"]) return;

  const base = ALL["zh-TW"], cn = lang === "zh-CN" ? ALL["zh-CN"] || {} : null;
  const pick = (k) => (cn && cn[k] != null ? cn[k] : base[k]);
  // 句型變數專用的小字典（程式拼進句子的 in／out、clip／track、a／an…）：只在套句型時查
  const ARGS = ALL.args || {}, ARGS_CN = cn ? ALL["args-CN"] || {} : {};
  function arg(v, whole) {
    const t = v.trim(), low = t.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ARGS, low)) return v.replace(t, () => (ARGS_CN[low] != null ? ARGS_CN[low] : ARGS[low]));
    return (LETTER.test(v) && v !== whole && core(v)) || v;
  }
  // 套完句型：全形標點旁邊不留空白（變數是空字串或自己帶標點時會多出來）
  const tidy = (s) => s.replace(/\s+([，。：；、！？）」』])/g, "$1").replace(/([（「『，。：；、])\s+/g, "$1").replace(/ {2,}/g, " ")
    .replace(/([㐀-鿿]) (?=[㐀-鿿])/g, "$1").trim();  // 「主輸出 的效果」→「主輸出的效果」
  const ATTRS = ["title", "placeholder", "aria-label", "alt"];
  const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, KBD: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, svg: 1, SVG: 1 };
  const LETTER = /[A-Za-z]{2}/;

  // 句型：鍵裡有 {0}、{1}…；用「最長一段固定字」先篩，再用正規式比對
  const exact = new Map(), pats = [];
  for (const k of Object.keys(base)) {
    if (!/\{\d+\}/.test(k)) { exact.set(k, k); continue; }
    const parts = k.split(/\{(\d+)\}/);
    let re = "^";
    const order = [], glue = [];
    parts.forEach((p, i) => {
      if (i % 2) {
        re += "([\\s\\S]*?)"; order.push(+p);
        // 變數緊貼著英文字母（「Ch{0}」「file{1}」）：只能是數字、符號開頭，或複數 s，不然「Chroma」會被當成「Ch」+「roma」
        glue.push([/[A-Za-z]$/.test(parts[i - 1]), /^[A-Za-z]/.test(parts[i + 1] || "")]);
      } else re += p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    const anchor = parts.filter((p, i) => !(i % 2)).sort((a, b) => b.length - a.length)[0] || "";
    if (anchor.replace(/[^A-Za-z]/g, "").length >= 2) pats.push({ k, re: new RegExp(re + "$"), order, anchor, glue });
  }
  pats.sort((a, b) => b.anchor.length - a.anchor.length);
  const glued = (p, m) => p.glue.some(([l, r], i) => {
    const v = m[i + 1] || "";
    return (l && /^[A-Za-z]/.test(v) && !/^e?s$/.test(v)) || (r && /[A-Za-z]$/.test(v));
  });

  function viaPattern(s) {
    for (const p of pats) {
      if (!s.includes(p.anchor)) continue;
      const m = p.re.exec(s);
      if (!m || glued(p, m)) continue;
      const args = {};
      p.order.forEach((n, i) => { const v = m[i + 1]; args[n] = v ? arg(v, s) : v; });
      return tidy(pick(p.k).replace(/\{(\d+)\}/g, (_, n) => (args[n] != null ? args[n] : "")));
    }
    return null;
  }

  // 一段字（已經去掉頭尾空白）：整句 → 句型 → 去掉頭尾符號再查 → 照「 · 」「 — 」切開每段都查得到才算
  const UNIT = /^[\d\s.,:×x/+−-]+\s*(fps|px|kHz|Hz|dB|dBTP|LUFS|ms|s|p|k|Mbps|Mb\/s|kb\/s|KB|MB|GB)?$/i;  // 「24 fps」「832×480」這種分段本來就不用翻
  const EDGE = /^([^A-Za-z0-9{(]*)([\s\S]*?)([\s:：…▾▸▼▶→←↑↓*•·]*)$/;
  function core(s) {
    if (exact.has(s)) return pick(s);
    const p = viaPattern(s);
    if (p != null) return p;
    const m = EDGE.exec(s);
    if (m && (m[1] || m[3]) && m[2] && m[2] !== s) {
      const mid = exact.has(m[2]) ? pick(m[2]) : viaPattern(m[2]);
      if (mid != null) return m[1] + mid + m[3].replace(/^\s*:\s*$/, "：");
    }
    for (const sep of [" · ", " — ", " | ", " / ", "\n"]) {
      if (!s.includes(sep)) continue;
      const bits = s.split(sep);
      let ok = true;
      const out = bits.map((b) => {
        const t = b.trim();
        if (!t || !LETTER.test(t) || UNIT.test(t)) return b;
        const v = core(t);
        if (v == null) ok = false;
        return v == null ? b : b.replace(t, () => v);
      });
      if (ok) return out.join(sep === " — " ? "，" : sep);
    }
    return null;
  }

  const cache = new Map();
  function tr(s) {
    if (!s || !LETTER.test(s)) return s;
    if (cache.has(s)) return cache.get(s);
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    const v = core(m[2].replace(/\s+/g, " "));
    const out = v == null ? s : m[1] + v + m[3];
    if (cache.size > 20000) cache.clear();
    cache.set(s, out);
    return out;
  }
  window.__animaTr = tr;  // 除錯用

  // ---------------------------------------------------------------- 畫面
  const shown = new WeakMap();  // text node／元素 → 最後一次換成的字（程式之後自己改字時分得出來）
  const skipEl = (e) => SKIP[e.tagName] || e.isContentEditable || e.getAttribute("translate") === "no";
  function skipped(node) {
    for (let e = node.nodeType === 1 ? node : node.parentElement; e; e = e.parentElement) if (skipEl(e)) return true;
    return false;
  }
  function doText(t) {
    const cur = t.nodeValue;
    if (shown.get(t) === cur || !LETTER.test(cur)) return;
    const p = t.parentElement;
    if (p && p.tagName === "OPTION" && !p.hasAttribute("value")) p.setAttribute("value", p.textContent);
    const v = tr(cur);
    if (v !== cur) t.nodeValue = v;
    shown.set(t, v);
  }
  function doAttrs(e) {
    let s = shown.get(e);
    for (const a of ATTRS) {
      const cur = e.getAttribute(a);
      if (cur == null || !LETTER.test(cur) || (s && s[a] === cur)) continue;
      const v = tr(cur);
      if (v !== cur) e.setAttribute(a, v);
      if (!s) { s = {}; shown.set(e, s); }
      s[a] = v;
    }
  }
  // <svg> 整塊不碰，只換它的 <title>（滑鼠移上去的提示，例如時間軸片段上的音量線）
  function svgTitles(root) {
    for (const t of root.querySelectorAll("svg title")) if (t.firstChild && t.firstChild.nodeType === 3) doText(t.firstChild);
  }
  function walk(root) {
    if (root.nodeType === 3) { if (!skipped(root)) doText(root); return; }
    if (root.nodeType !== 1) return;
    if (skipped(root)) { if (root.tagName.toLowerCase() === "svg" || root.closest("svg")) svgTitles(root.closest("svg") || root); return; }
    svgTitles(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === 1 && skipEl(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = w.currentNode; n; n = w.nextNode()) {
      if (n.nodeType === 3) doText(n); else doAttrs(n);
    }
  }
  const obs = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === "childList") r.addedNodes.forEach(walk);
      else if (r.type === "characterData") { if (!skipped(r.target)) doText(r.target); }
      else if (!skipped(r.target)) doAttrs(r.target);
    }
  });
  function start() {
    document.documentElement.lang = lang === "zh-CN" ? "zh-Hans-CN" : "zh-Hant-TW";
    // 中文會在字和字之間斷行（英文單字不會）：小標籤、按鈕擠一點時會變成直排「縮／放」，改成跟英文一樣只在空白處斷
    const css = document.createElement("style");
    css.textContent = ".tiny-label,.btn,button,th,label{word-break:keep-all}";
    document.head.appendChild(css);
    walk(document.documentElement);
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  // 原生對話框
  for (const k of ["alert", "confirm", "prompt"]) {
    const f = window[k].bind(window);
    window[k] = (msg, ...a) => f(typeof msg === "string" ? tr(msg) : msg, ...a);
  }

  // 監看螢幕上程式自己畫的幾句提示（只換白名單：影片內容的文字、使用者打的字幕不能動）
  const CANVAS = new Set(["Double-click a clip to load Source", "Audio", "Media offline"]);
  const fill = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, ...a) {
    return fill.call(this, typeof text === "string" && CANVAS.has(text) ? tr(text) : text, ...a);
  };
})();
