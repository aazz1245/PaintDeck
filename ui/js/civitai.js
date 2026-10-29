// Civitai 分頁：依 Civitai 基底模型搜尋 LoRA、一鍵下載（含觸發詞與預覽圖）
import { $, el, api, toast, fmtN } from "./util.js";
import { app } from "./state.js";

let next = null, loaded = false, basesLoaded = false, base = "*";
const cards = new Map(); // versionId -> 卡片上的下載區
const ALL = "全部基底"; // 網頁上顯示的「全部基底」→ 後端的 "*"

export function init() {
  $("#cvGo").onclick = () => search(false);
  $("#cvQ").onkeydown = (e) => { if (e.key === "Enter") search(false); };
  for (const id of ["#cvBase", "#cvSort", "#cvPeriod", "#cvNsfw"]) $(id).onchange = () => search(false);
  $("#cvMore").onclick = () => search(true);
}

export function show() {
  if (!basesLoaded) {
    basesLoaded = true;
    api("/api/civitai/bases").then((r) => {
      const values = new Set([ALL, "Anima", "Qwen 2.1", "MOSS Image", "Krea 2", "Krea 2 Turbo", ...(r.bases || [])]);
      $("#cvBaseList").replaceChildren(...[...values].map((b) => el("option", { value: b })));
    }).catch(() => { basesLoaded = false; });
  }
  if (!loaded) search(false);
}

async function search(append) {
  loaded = true;
  if (!append) { $("#cvGrid").innerHTML = ""; next = null; cards.clear(); }
  if (!append) {
    const v = $("#cvBase").value.trim();
    base = !v || v === ALL ? "*" : v;
  }
  $("#cvNote").textContent = base === "*"
    ? "列出所有基底的 LoRA，卡片上會標每個版本是哪個基底；下載後依基底分開存放，觸發詞也會一起存好。"
    : `只列出有 ${base} 版本的 LoRA。下載後會依基底模型分開存放，觸發詞也會一起存好。`;
  const qs = new URLSearchParams({ base, query: $("#cvQ").value.trim(), sort: $("#cvSort").value, period: $("#cvPeriod").value, nsfw: $("#cvNsfw").checked ? 1 : 0 });
  if (append && next) qs.set("cursor", next);
  $("#cvMore").hidden = true;
  const loading = el("div", { class: "muted pad" }, "搜尋中…");
  $("#cvGrid").append(loading);
  try {
    const r = await api("/api/civitai/search?" + qs);
    loading.remove();
    next = r.next;
    for (const it of r.items) $("#cvGrid").append(card(it));
    if (!r.items.length && !append) $("#cvGrid").append(el("div", { class: "muted pad" }, base === "*" ? "沒有找到 LoRA，換個關鍵字試試。" : `沒有找到有 ${base} 版本的 LoRA，換個關鍵字試試。`));
    $("#cvMore").hidden = !next;
  } catch (e) {
    loading.textContent = e.message;
  }
}

function card(it) {
  const blurOn = app.state?.settings?.blur_nsfw;
  const im = it.images[0];
  const blur = blurOn && im && im.nsfwLevel > 1;
  const versions = it.versions?.length ? it.versions : [{ ...it.version, installed: it.installed }];
  const c = { cur: versions[0], versions, dl: el("div", { class: "ft" }), trig: el("div", { class: "trig" }) };
  c.setBtn = (installed) => {
    if (installed !== undefined) c.cur.installed = installed;
    c.dl.innerHTML = "";
    const bt = base === "*" && c.cur.base ? `${c.cur.base}・` : "";
    if (c.cur.installed) c.dl.append(el("span", { class: "badge ok" }, bt ? `已安裝（${c.cur.base}）` : "已安裝"));
    else c.dl.append(el("button", { class: "btn sm primary", onclick: () => start(it, c) }, `下載（${bt}${c.cur.sizeMB} MB）`));
    c.dl.append(el("a", { class: "icon", href: it.url, target: "_blank", title: "在 Civitai 開啟" }, "↗"));
    c.trig.textContent = c.cur.trainedWords?.length ? "觸發詞：" + c.cur.trainedWords.slice(0, 6).join(", ") : "";
  };
  c.setBtn();
  for (const v of versions) cards.set(String(v.id), c);
  // 同一個基底模型有多個版本時，可以挑要下載的版本（預設最新）
  const sel = versions.length > 1
    ? el("select", { class: "sm", title: "選擇版本", onchange: (e) => { c.cur = versions.find((v) => String(v.id) === e.target.value); c.setBtn(); } },
      ...versions.map((v) => el("option", { value: v.id }, `${v.name}${v.published ? "（" + v.published + "）" : ""}${base === "*" && v.base ? "・" + v.base : ""}${v.installed ? " ✓" : ""}`)))
    : null;
  return el("div", { class: "card" },
    el("div", { class: "ph" + (blur ? " blur" : ""), style: im ? `background-image:url('${im.url}')` : "" }, im ? "" : "沒有預覽圖"),
    el("div", { class: "bd" },
      el("div", { class: "t" }, it.name),
      el("div", { class: "st" }, `${it.creator || ""}・下載 ${fmtN(it.downloads)}・👍 ${fmtN(it.likes)}` + (sel ? `・${versions.length} 個版本` : `・${c.cur.name || ""}`)),
      sel,
      it.nsfw ? el("span", { class: "badge nsfw", style: "align-self:flex-start" }, "成人") : null,
      c.trig,
      el("div", { class: "st" }, (it.tags || []).slice(0, 5).join("・")),
      c.dl));
}

async function start(it, c) {
  try {
    // 全部基底模式下 base 是 "*"，下載要用這個版本自己的基底決定存哪個資料夾
    await api("/api/civitai/download", { json: { modelId: it.id, versionId: c.cur.id, base: c.cur.base || base } });
    c.dl.innerHTML = "";
    c.dl.append(el("div", { class: "bar", style: "flex:1" }, el("div")), el("span", { class: "sub" }, "準備中"));
  } catch (e) {
    toast(e.message, "err");
  }
}

export function onDownload(m) {
  const c = cards.get(String(m.key));
  if (m.status === "done") {
    toast(`「${m.name}」下載完成，可以在 LoRA 清單使用了`, "ok");
    const v = c?.versions.find((x) => String(x.id) === String(m.key));
    if (v) v.installed = true;
    if (c && String(c.cur.id) === String(m.key)) c.setBtn();
    app.refreshState();
  } else if (m.status === "error") {
    toast(`下載失敗：${m.error}`, "err");
    if (c && String(c.cur.id) === String(m.key)) c.setBtn(false);
  } else if (c && m.total && String(c.cur.id) === String(m.key)) {
    const bar = c.dl.querySelector(".bar > div"), lab = c.dl.querySelector(".sub");
    if (bar) bar.style.width = `${(100 * m.done) / m.total}%`;
    if (lab) lab.textContent = `${Math.round((100 * m.done) / m.total)}%`;
  }
}
