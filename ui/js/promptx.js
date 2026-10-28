// 提示詞輔助：權重高亮與 Ctrl+↑/↓ 調權重、長度提示、最近用過的提示詞（我的片段搬到提示詞庫 library.js）
// 權重只有 Anima 有效：ComfyUI 的 Qwen 2.1、MOSS-Image 分詞器都設了 disable_weights，(tag:1.2) 會原封不動當成文字送進模型
import { $, el, toast, store } from "./util.js";

const F = (id) => $("#" + id);
let ctx = null;  // { prompt, negative, family(), save() }
const MAX_RECENT = 40;

export function init(c) {
  ctx = c;
  const promptList = [ctx.promptPrefix, ctx.prompt, ctx.promptSuffix].filter(Boolean);
  for (const ta of [...promptList, ctx.negative].filter(Boolean)) {
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        adjustWeight(ta, e.key === "ArrowUp" ? 0.05 : -0.05);
      }
    }, true);
  }

  setupHl(ctx.promptPrefix, F("promptPrefixHl"));
  setupHl(ctx.prompt, F("promptHl"));
  setupHl(ctx.promptSuffix, F("promptSuffixHl"));

  F("recentSel").onchange = () => {
    const v = F("recentSel").value;
    F("recentSel").value = "";
    if (!v) return;
    if (v === "__clear") { if (confirm("清空「最近用過的提示詞」？")) { store.set("recent", []); fillRecent(); } return; }
    const r = store.get("recent", [])[+v];
    if (!r) return;
    if (ctx.promptPrefix) ctx.promptPrefix.value = "";
    ctx.prompt.value = r.prompt;
    if (ctx.promptSuffix) ctx.promptSuffix.value = "";
    ctx.prompt.dispatchEvent(new Event("input", { bubbles: true }));
    ctx.save();
    toast("已換成這段提示詞（Ctrl+Z 可以復原）", "ok");
  };
  fillRecent();
  refresh();
}

function setupHl(ta, hl) {
  if (!ta || !hl) return;
  ta.addEventListener("input", refresh);
  ta.addEventListener("scroll", () => { hl.scrollTop = ta.scrollTop; });
  new ResizeObserver(() => { hl.style.height = ta.offsetHeight + "px"; }).observe(ta);
}

// ---------------------------------------------------------------- 高亮與長度
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function renderHl(ta, hl) {
  if (!ta || !hl) return;
  const v = ta.value;
  const qwen = ["qwen21", "moss"].includes(ctx.family());
  const re = /\(((?:\\.|[^()\\])*?):\s*(-?\d+(?:\.\d+)?)\)|\{[^{}]*\|[^{}]*\}|<image\d+>|<image\?>|(?<=^|[,\s])@[^,\n]+/g;
  let html = "", last = 0;
  for (const m of v.matchAll(re)) {
    html += esc(v.slice(last, m.index));
    let cls;
    if (m[2] !== undefined) { cls = qwen ? "w-bad" : +m[2] >= 1 ? "w-up" : "w-down"; }
    else if (m[0][0] === "{") cls = "w-rand";
    else if (m[0][0] === "<") cls = m[0] === "<image?>" ? "w-bad" : "w-img";
    else cls = "w-artist";
    html += `<mark class="${cls}">${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  hl.innerHTML = html + esc(v.slice(last)) + "\n";
  hl.scrollTop = ta.scrollTop;
}

export function refresh() {
  if (!ctx) return;
  renderHl(ctx.promptPrefix, F("promptPrefixHl"));
  renderHl(ctx.prompt, F("promptHl"));
  renderHl(ctx.promptSuffix, F("promptSuffixHl"));

  const fullText = (ctx.getFullPrompt ? ctx.getFullPrompt() : [
    ctx.promptPrefix?.value || "",
    ctx.prompt?.value || "",
    ctx.promptSuffix?.value || ""
  ].filter(Boolean).join(", ")).trim();

  const qwen = ["qwen21", "moss"].includes(ctx.family());
  const weights = (fullText.match(/\(((?:\\.|[^()\\])*?):\s*(-?\d+(?:\.\d+)?)\)/g) || []).length;

  // 長度：tag 數、英文字數；中文字另外算
  const tags = fullText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).length;
  const words = (fullText.match(/[A-Za-z0-9_'-]+/g) || []).length;
  const cjk = (fullText.match(/[㐀-鿿]/g) || []).length;
  const approx = Math.round(words * 1.35 + cjk * 1.1 + (fullText.match(/[,.()]/g) || []).length * 0.5);
  const parts = [`約 ${approx} token`, `${tags} 段`];
  if (cjk) parts.push(`含 ${cjk} 個中文字`);
  let warn = "";
  if (qwen && weights) warn = "Qwen 2.1／MOSS 不吃權重：(tag:1.2) 會被當成文字，建議拿掉括號，用句子描述想強調的東西";
  else if (!qwen && cjk > 8 && words < 3) warn = "Anima 看英文 tag 最準：中文可以打在框裡找對應的 tag（會跳建議）";
  else if (approx > 600) warn = "提示詞很長：越後面的內容影響越小，重要的放前面";
  F("promptStats").textContent = parts.join("・");
  F("promptWarn").textContent = warn;
  F("promptWarn").hidden = !warn;
}

// ---------------------------------------------------------------- Ctrl+↑/↓ 調權重
function adjustWeight(ta, d) {
  if (["qwen21", "moss"].includes(ctx.family()) && ta === ctx.prompt) toast("提醒：Qwen 2.1／MOSS 不吃權重，(tag:1.2) 會被當成文字", "err");
  const v = ta.value;
  let a = ta.selectionStart, b = ta.selectionEnd;
  // 游標在 (xxx:1.2) 裡面：整組調
  const around = findWeighted(v, a, b);
  if (around) {
    const w = round(around.w + d);
    const rep = Math.abs(w - 1) < 1e-9 ? around.inner : `(${around.inner}:${w.toFixed(2)})`;
    replace(ta, around.start, around.end, rep, around.inner);
    return;
  }
  if (a === b) {  // 沒選：用游標所在的那一段（逗號之間）
    const s = Math.max(v.lastIndexOf(",", a - 1), v.lastIndexOf("\n", a - 1)) + 1;
    let e = v.slice(a).search(/[,\n]/);
    e = e < 0 ? v.length : a + e;
    a = s; b = e;
  }
  while (a < b && /\s/.test(v[a])) a++;
  while (b > a && /\s/.test(v[b - 1])) b--;
  if (a === b) return;
  const inner = v.slice(a, b);
  replace(ta, a, b, `(${inner}:${round(1 + d).toFixed(2)})`, inner);
}

function findWeighted(v, a, b) {
  const re = /\(((?:\\.|[^()\\])*?):\s*(-?\d+(?:\.\d+)?)\)/g;
  for (const m of v.matchAll(re)) {
    const s = m.index, e = s + m[0].length;
    if (a >= s && b <= e) return { start: s, end: e, inner: m[1], w: +m[2] };
  }
  return null;
}

const round = (x) => Math.round(x * 100) / 100;

function replace(ta, s, e, text, inner) {
  ta.focus();
  ta.setSelectionRange(s, e);
  // execCommand 會進瀏覽器的復原紀錄，Ctrl+Z 可以退回
  if (!document.execCommand("insertText", false, text)) ta.setRangeText(text, s, e, "end");
  const i = s + text.indexOf(inner);
  ta.setSelectionRange(i, i + inner.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------------------------------------------------------- 最近用過的提示詞
export function remember(prompt, model) {
  prompt = (prompt || "").trim();
  if (!prompt) return;
  const list = store.get("recent", []).filter((r) => r.prompt !== prompt);
  list.unshift({ prompt, model: model || "", at: Date.now() });
  store.set("recent", list.slice(0, MAX_RECENT));
  fillRecent();
}

function fillRecent() {
  const s = F("recentSel"), list = store.get("recent", []);
  s.innerHTML = "";
  s.append(el("option", { value: "" }, `最近用過（${list.length}）`));
  list.forEach((r, i) => {
    const d = new Date(r.at);
    const when = d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(document.documentElement.lang, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(document.documentElement.lang);
    s.append(el("option", { value: i, title: r.prompt }, `${when}　${r.prompt.replace(/\s+/g, " ").slice(0, 60)}`));
  });
  if (list.length) s.append(el("option", { value: "__clear" }, "－ 清空這個清單 －"));
}
