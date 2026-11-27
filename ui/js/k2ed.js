// 隨機頁的「Krea 2 隨機產生器」：
// 引擎是 ComfyUI 外掛 Comfyui-K2-Editorial（作者灵冻不冻），從本機資料夾的 Comfyui-K2-Editorial.zip 安裝。
// 繪匣後端將 /api/k2ed/x/* 轉送至本機 ComfyUI 的 /k2ed/*（server\api_k2ed.rs），視覺與操作風格完全沿用 wardrobe.js（.wd）。
import { el, store, toast, api } from "./util.js";
import { fixHair } from "./wardrobe.js";

let cn2tw = null, twLoading = null;
const twCache = new Map();
async function loadTW() {
  twLoading ||= import(new URL("../vendor/opencc-cn2t.js", import.meta.url)).then(({ Converter }) => { cn2tw = Converter({ from: "cn", to: "twp" }); });
  try { await twLoading; } catch { twLoading = null; }
}
function tw(s) {
  if (!s || !cn2tw) return s || "";
  let v = twCache.get(s);
  if (v === undefined) { v = fixHair(cn2tw(s)); twCache.set(s, v); }
  return v;
}

const X = "/api/k2ed/x/";
const ASPECT_OPTS = [
  ["auto", "自動（跟隨母題）"], ["16:9", "16:9"], ["3:2", "3:2"], ["4:3", "4:3"],
  ["1:1", "1:1"], ["4:5", "4:5"], ["3:4", "3:4"], ["2:3", "2:3"], ["9:16", "9:16"],
];
const TEXT_MODES = [["all", "全部字樣"], ["title", "僅主標題"], ["notext", "無文字"]];
const MOTIF_POOL_OPTS = [["all", "全部母題"], ["fav", "僅收藏母題"], ["pick", "僅勾選池"]];
const CHAR_POOL_OPTS = [["all", "全部角色"], ["fav", "僅收藏角色"], ["keep", "保持母題原角色"]];
const PAGE = 72;

const DEF = {
  aspect: "auto",
  costume: "auto",
  textMode: "all",
  display: "",
  motifPool: "all",
  charPool: "all",
  pinMotif: "",
  pinChar: "",
  pinCharLabel: "",
  pinItem: "",
  pinItemLabel: "",
  apply: "replace",
  auto: false,
};

const S = {
  o: { ...DEF, ...store.get("k2ed_opts", {}) },
  tab: store.get("k2ed_tab", "motifs"),
  last: null,
};

const D = {
  status: null,
  manifest: null,
  favs: { characters: [], costumes: [], motifs: [], works: [] },
  pick: [],
  chars: null,
  outfits: null,
  outfitsChar: null,
};

let ui = null, applyFn = null;
const save = () => {
  store.set("k2ed_opts", S.o);
  store.set("k2ed_tab", S.tab);
};

const xget = (p) => api(X + p, { timeout: 60000 });
const xpost = (p, json) => api(X + p, { json, timeout: 120000 });

// ---------------------------------------------------------------- 純函式（tests\k2ed.test.cjs）

/** 依選項與隨機抽中的母題／角色組出 /k2ed/build 查詢字串 */
export function buildQuery(o, { motif, char, motifRatio }) {
  const q = new URLSearchParams();
  q.set("motif", motif || "");
  q.set("char", char || "keep");
  const asp = o.aspect && o.aspect !== "auto" ? o.aspect : (motifRatio || "16:9");
  q.set("aspect", asp);
  q.set("costume", o.costume || "auto");
  if (o.pinItem) q.set("item", o.pinItem);
  if (o.display && String(o.display).trim()) q.set("display", String(o.display).trim());
  if (o.textMode === "notext") q.set("notext", "1");
  else if (o.textMode === "title") q.set("mode", "title");
  return q.toString();
}

/** 從候選池隨機挑一項；若指定鎖定項且存在則回鎖定項 */
export function pickRandomItem(items, pinnedId, poolIds, rng = Math.random) {
  if (pinnedId) return pinnedId;
  const src = Array.isArray(poolIds) && poolIds.length ? poolIds : items;
  if (!src || !src.length) return "";
  return src[Math.floor(rng() * src.length)] || "";
}

// ---------------------------------------------------------------- 抽題

async function ensureManifest() {
  if (!D.manifest) {
    const [m, f, p] = await Promise.all([
      xget("manifest"),
      xget("favs").catch(() => ({ characters: [], costumes: [], motifs: [], works: [] })),
      xget("pick").catch(() => ({ motif: [] })),
    ]);
    D.manifest = m;
    D.favs = {
      characters: f.characters || [],
      costumes: f.costumes || [],
      motifs: f.motifs || [],
      works: f.works || [],
    };
    D.pick = p.motif || [];
  }
}

async function pickCharForRoll() {
  if (S.o.pinChar) return { id: S.o.pinChar, label: S.o.pinCharLabel || S.o.pinChar };
  if (S.o.charPool === "keep") return { id: "keep", label: "保持母題原角色" };
  if (S.o.charPool === "fav" && D.favs.characters.length) {
    const id = pickRandomItem(D.favs.characters, "", null);
    return { id, label: id };
  }
  const page = await xget("chars?offset=0&limit=1");
  const total = page.total || 0;
  if (!total) return { id: "miku", label: "miku" };
  const idx = Math.floor(Math.random() * total);
  const hit = await xget(`chars?offset=${idx}&limit=1`);
  const ch = (hit.items || [])[0];
  return ch ? { id: ch.id, label: tw(ch.zh || ch.id) } : { id: "miku", label: "miku" };
}

async function roll() {
  await ensureManifest();
  const motifs = D.manifest?.motifs || [];
  if (!motifs.length) throw new Error("K2-Editorial 母題清單為空");
  const poolIds = S.o.motifPool === "fav"
    ? D.favs.motifs
    : S.o.motifPool === "pick"
      ? D.pick
      : null;
  const allIds = motifs.map((m) => m.id);
  const motifId = pickRandomItem(allIds, S.o.pinMotif, poolIds);
  const motifObj = motifs.find((m) => m.id === motifId) || motifs[0];
  const ch = await pickCharForRoll();
  const qs = buildQuery(S.o, { motif: motifObj.id, char: ch.id, motifRatio: motifObj.ratio });
  const r = await xget("build?" + qs);
  if (!r?.ok) throw new Error(r?.error || "K2-Editorial 組裝失敗");
  S.last = {
    ...r,
    motifId: motifObj.id,
    motifZh: tw(motifObj.zh || motifObj.title || motifObj.id),
    charId: ch.id,
    charLabel: ch.label,
    aspect: S.o.aspect !== "auto" ? S.o.aspect : (motifObj.ratio || "16:9"),
  };
  paintResult();
  return S.last;
}

function apply(r = S.last) {
  if (!r?.text) return toast("先按「🎲 全部隨機」抽一次", "err");
  applyFn?.(r.text, S.o.apply);
}

/** 按「生成」前：勾了「每次生成前重抽」就先抽一次套進提示詞（gen.js 呼叫） */
export async function beforeGenerate() {
  if (!S.o.auto || !applyFn) return;
  try { apply(await roll()); } catch (e) { toast("Krea 2 隨機產生器沒抽成（照原本的提示詞生成）：" + e.message, "err"); }
}

// ---------------------------------------------------------------- 狀態與資料

async function refreshStatus() {
  try { D.status = await api("/api/k2ed/status"); } catch (e) { D.status = { error: e.message }; }
  return D.status;
}

let charQ = "", charWork = "", charOffset = 0;
async function loadChars(reset = false) {
  if (reset) charOffset = 0;
  const q = new URLSearchParams({ offset: String(charOffset), limit: String(PAGE) });
  if (charQ.trim()) q.set("q", charQ.trim());
  if (charWork) q.set("work", charWork);
  D.chars = await xget("chars?" + q.toString());
}

async function loadOutfits() {
  const key = S.o.pinChar && S.o.pinChar !== "keep" ? S.o.pinChar : "miku";
  if (D.outfits && D.outfitsChar === key) return;
  D.outfits = await xget("outfits?char=" + encodeURIComponent(key));
  D.outfitsChar = key;
}

async function loadTab() {
  await ensureManifest();
  if (S.tab === "chars" && !D.chars) await loadChars(true);
  if (S.tab === "outfits") await loadOutfits();
}

// ---------------------------------------------------------------- 畫面（與 wardrobe.js 同一套 .wd 樣式）

const sel = (opts, val, onchange, attrs = {}) => {
  const s = el("select", { class: "sm", ...attrs }, ...opts.map(([v, t]) => el("option", { value: v }, t)));
  s.value = val;
  s.onchange = () => onchange(s.value);
  return s;
};
const chk = (label, key, title) => el("label", { class: "check inline", title: title || "" },
  el("input", { type: "checkbox", checked: !!S.o[key], onchange: (e) => { S.o[key] = e.target.checked; save(); } }), " " + label);
const set = (key) => (v) => { S.o[key] = v; save(); };

function costumeOptions() {
  const tpls = D.manifest?.costume_templates || [];
  return [
    ["auto", "自動（跟隨母題）"],
    ["keep", "保持母題原樣"],
    ...tpls.map((t) => [t.id, tw(t.zh || t.id)]),
  ];
}

function topBar() {
  const disp = el("input", {
    type: "text", class: "sm wd-seed", value: S.o.display, placeholder: "畫面字樣（選填）",
    "aria-label": "畫面字樣", title: "覆寫畫面中出現的字樣；空白＝照母題預設",
  });
  disp.oninput = () => { S.o.display = disp.value; save(); };
  return el("div", { class: "wd-top" },
    el("div", { class: "row wrap gap" },
      el("span", { class: "sub" }, "畫幅"), sel(ASPECT_OPTS, S.o.aspect, set("aspect"), { "aria-label": "畫幅" }),
      el("span", { class: "sub" }, "服裝"), sel(costumeOptions(), S.o.costume, set("costume"), { "aria-label": "服裝模板" }),
      el("span", { class: "sub" }, "文字"), sel(TEXT_MODES, S.o.textMode, set("textMode"), { "aria-label": "文字模式" }),
      disp),
    el("div", { class: "row wrap gap" },
      el("span", { class: "sub" }, "母題池"), sel(MOTIF_POOL_OPTS, S.o.motifPool, set("motifPool"), { "aria-label": "母題隨機池" }),
      el("span", { class: "sub" }, "角色池"), sel(CHAR_POOL_OPTS, S.o.charPool, set("charPool"), { "aria-label": "角色隨機池" }),
      chk("每次生成前重抽", "auto", "按「生成」時先抽一次 Krea 2 長提示詞再畫")),
    el("div", { class: "row wrap gap" },
      el("button", { type: "button", class: "akey go", onclick: async () => { try { await roll(); } catch (e) { toast(e.message, "err"); } } }, "🎲 全部隨機"),
      sel([["replace", "取代提示詞"], ["append", "接在提示詞後面"]], S.o.apply, set("apply"), { "aria-label": "套用方式" }),
      el("button", { type: "button", class: "akey", onclick: () => apply() }, "套用到提示詞")),
    ui.result);
}

function paintResult() {
  const r = S.last;
  if (!r) {
    ui.result.replaceChildren(el("span", { class: "muted sm" }, "按「🎲 全部隨機」組裝一組 Krea 2 長提示詞，滿意再「套用到提示詞」"));
    return;
  }
  ui.result.replaceChildren(
    el("div", { class: "muted sm" }, `${r.motifZh}・${r.charLabel}・${r.aspect}・${r.words ?? "?"} 詞／${r.paras ?? "?"} 段`),
    el("textarea", { class: "wd-text", rows: 4, readonly: true, spellcheck: "false", "aria-label": "抽出來的 Krea 2 提示詞" }, r.text),
    (r.log || []).length ? el("details", { class: "sm" }, el("summary", {}, "組裝說明"), el("ul", {}, ...(r.log || []).map((n) => el("li", {}, tw(String(n)))))) : "",
  );
}

function tabs() {
  const T = [["motifs", "母題"], ["chars", "角色"], ["outfits", "服裝"]];
  return el("div", { class: "tl-tabs wd-tabs" }, ...T.map(([k, name]) =>
    el("button", {
      type: "button", class: "tl-tab" + (S.tab === k ? " on" : ""),
      onclick: async () => {
        S.tab = k; save();
        try { await loadTab(); } catch (e) { toast(e.message, "err"); }
        render();
      },
    }, name)));
}

async function toggleFav(kind, id, on) {
  try {
    const r = await xpost("favs", { kind, id, on });
    D.favs = {
      characters: r.characters || [],
      costumes: r.costumes || [],
      motifs: r.motifs || [],
      works: r.works || [],
    };
    render();
  } catch (e) { toast(e.message, "err"); }
}

async function togglePickMotif(id, inPool) {
  try {
    const r = await xpost("pick", inPool ? { remove: [id] } : { add: [id] });
    D.pick = r.motif || [];
    render();
  } catch (e) { toast(e.message, "err"); }
}

// ---------------------------------------------------------------- 母題分頁
let motifQ = "", motifAsp = "", motifFavOnly = false, motifN = PAGE;
function motifsTab() {
  const list = D.manifest?.motifs || [];
  const q = el("input", { type: "search", class: "sm", value: motifQ, placeholder: "找母題（中文、標題、標籤）", "aria-label": "找母題" });
  q.oninput = () => { motifQ = q.value; motifN = PAGE; render(); };
  const aspSel = sel([["", "全部畫幅"], ["portrait", "豎屏"], ["landscape", "橫屏"], ["square", "方屏"]], motifAsp, (v) => { motifAsp = v; motifN = PAGE; render(); }, { "aria-label": "畫幅篩選" });
  const favChk = el("label", { class: "check inline" }, el("input", { type: "checkbox", checked: motifFavOnly, onchange: (e) => { motifFavOnly = e.target.checked; motifN = PAGE; render(); } }), " 只看收藏");

  const favSet = new Set(D.favs.motifs);
  const pickSet = new Set(D.pick);
  const kw = motifQ.trim().toLowerCase();
  const hit = list.filter((m) =>
    (!motifAsp || m.aspect === motifAsp)
    && (!motifFavOnly || favSet.has(m.id))
    && (!kw || [m.id, m.title, m.zh, tw(m.zh), m.branch_zh, ...(m.tags || [])].some((s) => (s || "").toLowerCase().includes(kw))));

  const pinnedObj = S.o.pinMotif ? list.find((m) => m.id === S.o.pinMotif) : null;
  const pickedRow = el("div", { class: "wd-picked" },
    ...(pinnedObj
      ? [el("span", { class: "sub" }, "固定母題："), el("span", { class: "tl-rc" }, tw(pinnedObj.zh || pinnedObj.title || pinnedObj.id),
          el("button", { type: "button", class: "icon", "aria-label": "取消固定", onclick: () => { S.o.pinMotif = ""; save(); render(); } }, "✕"))]
      : [el("span", { class: "muted sm" }, `點卡片＝固定該母題；勾選池 ${D.pick.length} 個（共 ${list.length} 個母題）`)]),
    D.pick.length ? el("button", { type: "button", class: "link sm", onclick: async () => { try { const r = await xpost("pick", { clear: true }); D.pick = r.motif || []; render(); } catch (e) { toast(e.message, "err"); } } }, "清空勾選池") : "");

  const card = (m) => {
    const on = S.o.pinMotif === m.id;
    const fav = favSet.has(m.id);
    const inPool = pickSet.has(m.id);
    return el("div", {
      class: "wd-card" + (on ? " on" : ""),
      title: `${m.title || m.id}\n${tw(m.branch_zh || "")}・${m.ratio || ""}`,
      onclick: () => { S.o.pinMotif = on ? "" : m.id; save(); render(); },
    },
      m.thumb ? el("img", { src: `${X}thumb/${m.thumb.split("/").map(encodeURIComponent).join("/")}`, alt: "", loading: "lazy" }) : el("div", { class: "wd-noimg" }, m.ratio || "?"),
      el("b", {}, tw(m.zh) || m.title || m.id),
      el("small", {}, `${m.ratio || ""}・${tw(m.branch_zh || "")}${inPool ? "・池✓" : ""}`),
      el("button", {
        type: "button", class: "icon wd-fav" + (fav ? " on" : ""), title: fav ? "取消收藏" : "收藏", "aria-label": fav ? "取消收藏" : "收藏",
        onclick: (e) => { e.stopPropagation(); toggleFav("motifs", m.id, !fav); },
      }, fav ? "★" : "☆"),
      el("button", {
        type: "button", class: "link sm", title: inPool ? "移出隨機勾選池" : "加入隨機勾選池",
        onclick: (e) => { e.stopPropagation(); togglePickMotif(m.id, inPool); },
      }, inPool ? "✓ 已在池" : "＋入池"));
  };

  return [
    el("div", { class: "row wrap gap" }, q, aspSel, favChk),
    pickedRow,
    el("div", { class: "wd-grid" },
      ...hit.slice(0, motifN).map(card),
      ...(hit.length > motifN ? [el("button", { type: "button", class: "akey sm wd-more", onclick: () => { motifN += PAGE; render(); } }, `再顯示 ${Math.min(PAGE, hit.length - motifN)} 個（共 ${hit.length}）`)] : [])),
  ];
}

// ---------------------------------------------------------------- 角色分頁
function charsTab() {
  const c = D.chars || { items: [], total: 0, works: [], fav: [] };
  const q = el("input", { type: "search", class: "sm", value: charQ, placeholder: "找角色（中文、英文、作品）", "aria-label": "找角色" });
  q.onkeydown = async (e) => { if (e.key === "Enter") { charQ = q.value; await loadChars(true); render(); } };
  const searchBtn = el("button", { type: "button", class: "akey sm", onclick: async () => { charQ = q.value; await loadChars(true); render(); } }, "搜尋");
  const workOpts = [["", `全部作品（${c.total}）`], ["__fav__", "★ 只看收藏"], ...(c.works || []).map((w) => [w.en || w.id || w, tw(w.zh || w.en || w)])];
  const works = sel(workOpts, charWork, async (v) => { charWork = v; await loadChars(true); render(); }, { "aria-label": "作品" });
  const favSet = new Set(D.favs.characters);

  const pickedRow = el("div", { class: "wd-picked" },
    ...(S.o.pinChar
      ? [el("span", { class: "sub" }, "固定角色："), el("span", { class: "tl-rc" }, S.o.pinCharLabel || S.o.pinChar,
          el("button", { type: "button", class: "icon", "aria-label": "取消固定", onclick: () => { S.o.pinChar = ""; S.o.pinCharLabel = ""; D.outfitsChar = null; save(); render(); } }, "✕"))]
      : [el("span", { class: "muted sm" }, "沒有固定角色：照上面的「角色池」隨機抽")]));

  const card = (x) => {
    const on = S.o.pinChar === x.id;
    const fav = favSet.has(x.id);
    const label = tw(x.zh || x.id);
    return el("div", {
      class: "wd-card" + (on ? " on" : ""),
      title: `${x.id}\n${tw(x.work_zh || x.work_en || "")}`,
      onclick: () => {
        S.o.pinChar = on ? "" : x.id;
        S.o.pinCharLabel = on ? "" : label;
        D.outfitsChar = null;
        save();
        render();
      },
    },
      x.thumb ? el("img", { src: `${X}thumb/${x.thumb.split("/").map(encodeURIComponent).join("/")}`, alt: "", loading: "lazy" }) : el("div", { class: "wd-noimg" }, "?"),
      el("b", {}, label),
      el("small", {}, tw(x.work_zh || x.work_en || "")),
      el("button", {
        type: "button", class: "icon wd-fav" + (fav ? " on" : ""), title: fav ? "取消收藏" : "收藏", "aria-label": fav ? "取消收藏" : "收藏",
        onclick: (e) => { e.stopPropagation(); toggleFav("characters", x.id, !fav); },
      }, fav ? "★" : "☆"));
  };

  const nav = el("div", { class: "row wrap gap" },
    charOffset > 0 ? el("button", { type: "button", class: "akey sm", onclick: async () => { charOffset = Math.max(0, charOffset - PAGE); await loadChars(false); render(); } }, "‹ 上一頁") : "",
    el("span", { class: "muted sm" }, `${c.total ? charOffset + 1 : 0}–${Math.min(charOffset + PAGE, c.total)} / ${c.total}`),
    charOffset + PAGE < c.total ? el("button", { type: "button", class: "akey sm", onclick: async () => { charOffset += PAGE; await loadChars(false); render(); } }, "下一頁 ›") : "");

  return [
    el("div", { class: "row wrap gap" }, q, searchBtn, works),
    pickedRow,
    el("div", { class: "wd-grid" }, ...(c.items || []).map(card)),
    nav,
  ];
}

// ---------------------------------------------------------------- 服裝分頁
function outfitsTab() {
  const o = D.outfits || { character: [], library: [], categories: [] };
  const charItems = o.character || [];
  const libItems = o.library || [];
  const pickedRow = el("div", { class: "wd-picked" },
    ...(S.o.pinItem
      ? [el("span", { class: "sub" }, "固定套裝："), el("span", { class: "tl-rc" }, S.o.pinItemLabel || S.o.pinItem,
          el("button", { type: "button", class: "icon", "aria-label": "取消固定", onclick: () => { S.o.pinItem = ""; S.o.pinItemLabel = ""; save(); render(); } }, "✕"))]
      : [el("span", { class: "muted sm" }, `點一套＝固定穿搭（目前角色：${S.o.pinCharLabel || S.o.pinChar || "miku"}）；不選則照上方「服裝」模板`)]),
  );

  const card = (prefix, x) => {
    const val = `${prefix}:${x.id}`;
    const on = S.o.pinItem === val;
    const label = tw(x.zh || x.name || x.id);
    return el("div", {
      class: "wd-card wd-outfit" + (on ? " on" : ""),
      title: (x.tags || []).join(", "),
      onclick: () => {
        S.o.pinItem = on ? "" : val;
        S.o.pinItemLabel = on ? "" : label;
        save();
        render();
      },
    },
      x.thumb ? el("img", { src: `${X}thumb/${x.thumb.split("/").map(encodeURIComponent).join("/")}`, alt: "", loading: "lazy" }) : el("div", { class: "wd-noimg" }, prefix === "char" ? "角色" : "庫"),
      el("b", {}, label),
      el("small", {}, (x.tags || []).slice(0, 3).join(", ")));
  };

  return [
    pickedRow,
    charItems.length ? el("div", { class: "sub" }, `角色專屬服裝（${charItems.length}）`) : "",
    charItems.length ? el("div", { class: "wd-grid" }, ...charItems.map((x) => card("char", x))) : "",
    el("div", { class: "sub" }, `通用服裝庫（${libItems.length}）`),
    el("div", { class: "wd-grid" }, ...libItems.slice(0, 120).map((x) => card("lib", x))),
  ];
}

// ---------------------------------------------------------------- 安裝狀態

function statusView(st) {
  if (st?.error) return [el("div", { class: "err sm" }, st.error)];
  if (st.loaded) return null;
  if (st.remote) return [el("div", { class: "notice sm" }, "現在連的是雲端的 ComfyUI：Krea 2 隨機產生器要裝在本機的 ComfyUI。")];
  if (!st.installed) {
    if (st.zip_found) {
      return [
        el("div", { class: "notice sm" }, `Krea 2 隨機產生器使用資料夾內的 Comfyui-K2-Editorial.zip（${st.zip_path}），解壓安裝到本機 ComfyUI 的 custom_nodes 即可使用。`),
        el("button", { type: "button", class: "akey go", onclick: install }, "從本機壓縮包安裝 Krea 2 隨機產生器"),
      ];
    }
    return [
      el("div", { class: "notice sm" }, "資料夾裡找不到 Comfyui-K2-Editorial.zip：請將 Comfyui-K2-Editorial.zip 放在繪匣資料夾或其上層資料夾，再點重新檢查。"),
      el("button", { type: "button", class: "akey", onclick: show }, "重新檢查"),
    ];
  }
  if (!st.online) return [el("div", { class: "notice sm" }, "本機的 ComfyUI 沒有連線：開著 ComfyUI 才能抽。")];
  if (!st.loaded) return [
    el("div", { class: "notice sm" }, "裝好了，ComfyUI 重開一次才會載入 Krea 2 隨機產生器。"),
    el("button", { type: "button", class: "akey go", onclick: restartComfy }, "重開 ComfyUI"),
  ];
  return null;
}

async function install() {
  toast("正在從本機 Comfyui-K2-Editorial.zip 解壓安裝…");
  try {
    const r = await api("/api/k2ed/install", { json: {}, timeout: 300000 });
    toast(r.restart ? "裝好了：重開 ComfyUI 就能用" : "已經裝好了", "ok");
  } catch (e) { toast("安裝失敗：" + e.message, "err"); }
  await show();
}

async function restartComfy() {
  try { const deck = await import("./deck.js"); await deck.restartComfy(); } catch (e) { toast(e.message, "err"); }
  setTimeout(show, 8000);
}

// ---------------------------------------------------------------- 進入點

function render() {
  if (!ui) return;
  const st = D.status;
  const blocked = st && statusView(st);
  if (blocked) { ui.box.replaceChildren(el("b", {}, "Krea 2 隨機產生器"), ...blocked); return; }
  let body;
  try {
    body = S.tab === "chars" ? charsTab() : S.tab === "outfits" ? outfitsTab() : motifsTab();
  } catch (e) { body = [el("div", { class: "err sm" }, e.message)]; }
  ui.box.replaceChildren(
    topBar(),
    tabs(),
    el("div", { class: "wd-body" }, ...[body].flat().filter(Boolean)),
    el("div", { class: "muted sm tl-src" }, "引擎：Comfyui-K2-Editorial（灵冻不冻；本機壓縮包安裝）"),
  );
  paintResult();
}

export async function show() {
  if (!ui) return;
  ui.box.replaceChildren(el("span", { class: "muted sm" }, "讀取 Krea 2 隨機產生器…"));
  await loadTW();
  const st = await refreshStatus();
  if (st?.loaded) {
    try { await loadTab(); } catch (e) { D.status = { error: e.message }; }
  }
  render();
}

/** box：放面板的空 div；onApply(text, mode)：把抽出來的提示詞套進提示詞框（mode＝replace／append） */
export function init({ box, onApply }) {
  applyFn = onApply;
  ui = { box, result: el("div", { class: "wd-result" }) };
}
