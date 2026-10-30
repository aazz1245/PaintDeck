// 資產抽屜：生成、導演分鏡、H3 影片台、漫畫、助手共用。點一個資產 → 後端照目前的模型轉換（/api/assets/{id}/apply）→ 插文字、放圖。
// mount(box, ctx)：ctx = { family(), insert(text), images?: { base?(r), control?(r), ref?: {add(r), count(), max, has?(name)} }, lock?(chip) }。
// lock：鎖定設定表的角色不插字，交給頁面做成標籤（生成頁，見 lockedchips.js）；chip = {id, name, zh, en, tags, refs}。
// r 是 /api/to_input 的 {name, width, height}；ref.add 回傳加入後的 1 起算編號，放不下回 null。
import { api, el, toast, store } from "./util.js";
import * as assets from "./assets.js";

/** 小抄：每個模型吃得下什麼（設計文件 4.5） */
const HINT = {
  anima: "Anima：插 tag＋一句外觀英文；有圖可以選當圖生圖底圖或構圖控制（各 1 張）",
  qwen21: "Qwen 2.1：外觀文字＋參考圖最多 10 張（4 張以內細節最好），提示詞會自動寫上第幾張圖",
  moss: "MOSS：只吃文字，圖不會送",
  h3: "H3：中文外觀、聲音、說話語言（參考圖最多 9 張，影片台合併後再接）",
  ltx: "導演分鏡（LTX）：插外觀文字；第一格用角色卡的原圖",
  comic: "漫畫：插外觀文字和 tag",
};
const KINDS = [
  "all", "char", "scene", "frame", "outfit", "prop", "fx", "sound", "snippet"
];

const drawers = [];
const isOpen = () => store.get("assetDrawer", false);

export function mount(box, ctx) {
  const d = { box, ctx, kind: "all", tags: new Set(), q: "", menu: null, items: [] };
  drawers.push(d);
  box.classList.add("adr");
  paint(d);
  return {
    refresh: () => refreshCards(d),
    paint: () => paint(d),
  };
}

function refreshCards(d) {
  const cardsEl = d.box.querySelector(".adr-cards");
  if (!cardsEl) return;
  const top = cardsEl.scrollTop;
  paintCards(d, cardsEl, d.items || []);
  cardsEl.scrollTop = top;
}

/** 收起／打開：每一頁的抽屜一起 */
function toggle() {
  store.set("assetDrawer", !isOpen());
  for (const d of drawers) paint(d);
}

async function paint(d) {
  const open = isOpen();
  const fam = d.ctx.family();
  const head = el("div", { class: "row adr-head" },
    el("button", { class: "akey sm", type: "button", "aria-expanded": String(open), onclick: toggle }, open ? "▾ " : "▸ ", "資產"),
    el("span", { class: "muted sm adr-hint" }, HINT[fam] || "這個模型只插文字"));
  if (!open) return d.box.replaceChildren(head);
  let items = [];
  try { items = await assets.list(); } catch { /* list() 自己會報錯 */ }
  d.items = items;

  if (!d.tags) d.tags = new Set();
  const countOf = (k) => (k === "all" ? items.length : items.filter((x) => x.kind === k).length);
  const visibleKinds = KINDS.filter((k) => countOf(k) > 0 || k === "all" || k === d.kind);

  const search = el("input", { type: "search", class: "adr-q", placeholder: "搜尋…", value: d.q, "aria-label": "搜尋資產" });
  search.oninput = () => { d.q = search.value; paintCards(d, cards, items); };

  const kindsBox = el("div", { class: "row wrap adr-kinds" },
    ...visibleKinds.map((k) => el("button", {
      class: "chip" + (d.kind === k ? " on" : ""),
      type: "button",
      onclick: () => { d.kind = k; if (k !== "snippet") d.snippetFolder = "all"; paint(d); }
    }, (k === "all" ? "全部" : (assets.KIND_NAME[k] || k)) + (k === "all" ? "" : " " + countOf(k)))),
    search,
    el("button", { class: "akey sm", type: "button", title: "重新讀資產庫", onclick: async () => { await assets.load(); paint(d); } }, "↻")
  );

  let subRow = "";
  if (d.kind === "snippet") {
    if (!d.snippetFolder) d.snippetFolder = "all";
    const snippetItems = items.filter((x) => x.kind === "snippet");
    const countFolder = (f) => f === "all" ? snippetItems.length : snippetItems.filter((x) => x.folder === f).length;
    const known = ["少女", "萝莉", "假小子", "肉感", "厚涂", "强烈质感设计", "后缀", "anima"];
    const found = new Set(snippetItems.map((x) => x.folder).filter(Boolean));
    const folders = ["all", ...known.filter((f) => found.has(f) || countFolder(f) > 0), ...[...found].filter((f) => !known.includes(f))];
    subRow = el("div", { class: "row wrap adr-subkinds gap", style: "width: 100%; margin-top: 4px; padding: 2px 4px; background: rgba(0,0,0,0.05); border-radius: 4px; align-items: center;" },
      el("span", { class: "muted sm", style: "font-size: 11px;" }, "子选项："),
      ...folders.map((f) => el("button", {
        class: "chip sm" + ((d.snippetFolder || "all") === f ? " on" : ""),
        type: "button",
        onclick: () => { d.snippetFolder = f; paint(d); }
      }, (f === "all" ? "全部片段" : (assets.KIND_NAME[f] || f)) + ` ${countFolder(f)}`))
    );
  }

  const matchKind = (x) => {
    if (d.kind === "all") return true;
    if (d.kind === "snippet") {
      if (d.snippetFolder && d.snippetFolder !== "all") {
        return x.kind === "snippet" && x.folder === d.snippetFolder;
      }
      return x.kind === "snippet";
    }
    return x.kind === d.kind;
  };

  // 標籤多選篩選列（範圍逐漸縮小）
  const inCat = items.filter(matchKind);
  const allCatTags = new Set();
  for (const it of inCat) {
    for (const t of it.tags || []) allCatTags.add(t);
  }

  // 計算每個標籤在當前交集條件下的符合筆數
  const tagCounts = new Map();
  for (const t of allCatTags) {
    let cnt = 0;
    for (const it of inCat) {
      const itTags = it.tags || [];
      const testSet = new Set(d.tags);
      testSet.add(t);
      if (Array.from(testSet).every((req) => itTags.includes(req))) {
        cnt++;
      }
    }
    tagCounts.set(t, cnt);
  }

  const priority = ["收藏", "SSS", "常用", "画师串"];
  const sortedTags = [...tagCounts.entries()].sort(([a, ca], [b, cb]) => {
    const ia = priority.indexOf(a), ib = priority.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return cb - ca || a.localeCompare(b);
  });

  const tagRow = el("div", { class: "row wrap adr-tags" });
  if (sortedTags.length) {
    tagRow.append(el("span", { class: "muted sm adr-tag-lbl" }, "標籤:"));
    tagRow.append(el("button", {
      class: "chip sm" + (!d.tags.size ? " on" : ""),
      type: "button",
      onclick: () => { d.tags.clear(); paint(d); }
    }, "全部"));
    for (const [t, cnt] of sortedTags) {
      const on = d.tags.has(t);
      tagRow.append(el("button", {
        class: "chip sm" + (on ? " on" : "") + (!on && cnt === 0 ? " dim" : ""),
        type: "button",
        title: on ? `點擊取消 #${t}` : cnt === 0 ? `無交集（0 筆）` : `點擊增加 #${t} 進行交集篩選`,
        onclick: () => {
          if (on) d.tags.delete(t);
          else d.tags.add(t);
          paint(d);
        }
      }, `#${t} ${on ? "✓" : cnt}`));
    }
    if (d.tags.size > 0) {
      tagRow.append(el("button", {
        class: "akey sm",
        type: "button",
        title: "清除全部選中的標籤",
        onclick: () => { d.tags.clear(); paint(d); }
      }, `✕ 清除 (${d.tags.size})`));
    }
  }

  const cards = el("div", { class: "adr-cards" });
  d.box.replaceChildren(
    head,
    kindsBox,
    subRow || "",
    sortedTags.length ? tagRow : "",
    cards,
    d.menu || ""
  );
  paintCards(d, cards, items);
}

function paintCards(d, box, items, shown) {
  const q = d.q.trim().toLowerCase();
  const matchKind = (x) => {
    if (d.kind === "all") return true;
    if (d.kind === "snippet") {
      if (d.snippetFolder && d.snippetFolder !== "all") {
        return x.kind === "snippet" && x.folder === d.snippetFolder;
      }
      return x.kind === "snippet";
    }
    return x.kind === d.kind;
  };
  const matchQ = (x) => !q || [x.name, ...(x.tags || []), x.data?.look_zh, x.data?.look_en, x.data?.text].join("\n").toLowerCase().includes(q);
  const matchTags = (x) => !d.tags?.size || Array.from(d.tags).every((t) => (x.tags || []).includes(t));

  shown = shown || items.filter((x) => matchKind(x) && matchQ(x) && matchTags(x));
  box.replaceChildren(...shown.map((it) => {
    const pText = it.data?.text || it.data?.look_en || "";
    const active = !!((pText && d.ctx.has && d.ctx.has(pText)) || (d.ctx.isLocked && d.ctx.isLocked(it.id)));
    return el("button", {
      class: "adr-card" + (active ? " on" : ""),
      type: "button",
      title: (active ? "【已加入提示詞，點擊取消】\n" : "【點擊加入提示詞】\n") + (it.data?.look_zh || it.data?.look_en || it.data?.text || it.name || ""),
      onclick: () => use(d, it)
    },
      it.has_thumb ? el("img", { src: `/api/lib/${it.id}/thumb?v=${Math.round(it.updated || 0)}`, alt: "", loading: "lazy" }) : el("span", { class: "adr-ph" }, assets.KIND_NAME[it.kind] || it.kind),
      el("span", { class: "adr-name", title: it.name }, it.name)
    );
  }));
  if (!shown.length) box.append(el("span", { class: "muted sm" }, "沒有符合條件的資產"));
}

const toInput = (it, file) => api(`/api/assets/${it.id}/to_input`, { json: { file } });

/** 點一個資產：插文字；照模型放圖 */
async function use(d, it) {
  const fam = d.ctx.family();
  // 同一頁連點多個資產時，圖片與提示詞依點擊順序一起加入。
  d.pending = (d.pending || Promise.resolve()).then(() => apply(d, it, fam)).catch((e) => toast(e.message, "err"));
  return d.pending;
}

async function apply(d, it, fam) {
  if (d.ctx.family() !== fam) return;
  let p;
  try { p = await api(`/api/assets/${it.id}/apply`, { json: { family: fam } }); } catch (e) { return toast(e.message, "err"); }
  if (d.ctx.family() !== fam) return;
  if (fam !== "qwen21") for (const w of p.warn || []) toast(w, "err");
  const imgs = d.ctx.images || {};
  let text = p.text || "";
  const added = [];  // 這次放進多圖參考的檔名（鎖定標籤送出時照目前順序換成 <imageN>）
  try {
    if (fam === "qwen21" && imgs.ref && p.images.length) {
      const max = imgs.ref.max || 10;
      const room = Math.max(0, max - imgs.ref.count());
      const ready = [];
      for (const f of p.images.slice(0, room)) {
        try { ready.push(await toInput(it, f)); } catch (e) { toast(e.message, "err"); }
        if (d.ctx.family() !== fam) return;
      }
      // 複製期間使用者仍可改參考圖；等全部複製完再同步加入、取得實際編號及插文字。
      const tags = [];
      for (const r of ready) {
        // 鎖定角色再點一次：已經在參考圖裡的同一張不重複放，照樣記給標籤
        if (p.locked && d.ctx.lock && imgs.ref.has?.(r.name)) { added.push(r.name); continue; }
        if (imgs.ref.count() >= max) break;
        const n = imgs.ref.add(r);
        if (n) { tags.push(`<image${n}>`); added.push(r.name); }
      }
      if (p.images.length > room || added.length < ready.length || (p.warn || []).some((w) => w.includes("10"))) toast(`參考圖最多 ${max} 張`, "err");
      if (tags.length && imgs.ref.count() > 4) toast(`目前有 ${imgs.ref.count()} 張參考圖，4 張以內細節最好`, "err");
      if (tags.length) text = `${it.name}（${tags.join("")}）${text ? "：" + text : ""}`;
    }
  } catch (e) { toast(e.message, "err"); }
  if ((fam === "h3" || fam === "ltx") && (p.voice || p.lang)) {
    const voice = fam === "ltx"
      ? `${it.name}: Voice: ${p.voice || "—"}; Language: ${p.lang || "—"}`
      : `「${it.name}」聲音：${p.voice || "—"}；語言：${p.lang || "—"}`;
    text = [text, voice].filter(Boolean).join("\n");
  }
  const locked = !!(p.locked && d.ctx.lock);
  let didAdd = false;
  if (locked) {
    if (d.ctx.isLocked && d.ctx.isLocked(it.id)) {
      if (d.ctx.unlock) d.ctx.unlock(it.id);
      toast(`已解除鎖定「${it.name}」`, "ok");
    } else {
      d.ctx.lock({ id: it.id, name: it.name, zh: p.spec?.zh || "", en: p.spec?.en || "", tags: p.spec?.tags || "", refs: added });
      toast(`「${it.name}」的設定表鎖在提示詞最前面（送出時才接上）`, "ok");
      didAdd = true;
    }
  } else if (text) {
    if (d.ctx.toggle) {
      didAdd = d.ctx.toggle(text);
      toast(didAdd ? `已加入「${it.name}」` : `已從提示詞移除「${it.name}」`, "ok");
    } else {
      d.ctx.insert(text);
      toast(`已插入「${it.name}」`, "ok");
      didAdd = true;
    }
  }
  if (didAdd && fam === "anima" && p.images.length && (imgs.base || imgs.control)) {
    d.menu = el("div", { class: "row wrap adr-menu" },
      el("span", { class: "sm" }, `「${it.name}」有圖：`),
      imgs.base ? el("button", { class: "akey sm", type: "button", onclick: () => putImage(d, it, p.images[0], imgs.base) }, "當圖生圖底圖") : null,
      imgs.control ? el("button", { class: "akey sm", type: "button", onclick: () => putImage(d, it, p.images[0], imgs.control) }, "當構圖控制") : null,
      el("button", { class: "akey sm", type: "button", onclick: () => { d.menu = null; paint(d); } }, "不用圖"));
    paint(d);
  } else {
    refreshCards(d);
  }
}

async function putImage(d, it, file, put) {
  d.menu = null;
  paint(d);
  try { put(await toInput(it, file)); toast(`「${it.name}」的圖放好了`, "ok"); } catch (e) { toast(e.message, "err"); }
}

/** 一般文字框：接在最後（換一行），並觸發 input 讓各頁照常存檔 */
export function appendTo(ta) {
  return (text) => {
    const cur = ta.value.replace(/\s+$/, "");
    ta.value = cur ? `${cur}\n${text}` : text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
}
