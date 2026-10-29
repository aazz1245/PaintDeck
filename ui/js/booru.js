// Booru 畫廊：整合 ComfyUI-Aaalice-Nodes 的 BooruGalleryNode 服務
// 支援 Danbooru / Gelbooru / Safebooru / AI TAG 瀑布流檢索、抽卡、標籤提取與圖生圖聯動
// 支援懸浮預覽大圖與提示詞、點擊圖片加入/移除「主體提示詞」、單選/多選模式、提示詞處理與設定功能

import { $, $$, el, toast, uploadFile, store } from "./util.js";
import { appendPrompt, removePrompt, setInit, setMode, refs, S } from "./gen.js";

const COMFY_URL = "http://127.0.0.1:8188";
const API = `${COMFY_URL}/aaalice/booru-gallery`;

// 提示詞處理預設設定
export const promptConfig = {
  categories: ["character", "copyright", "artist", "general"],
  replaceUnderscores: false,
  escapeParentheses: false,
  blacklist: [
    "watermark", "signature", "username", "logo", "web_address",
    "commentary_request", "bad_id", "bad_pixiv_id", "translation_request",
  ],
};

export const state = {
  source: "danbooru",
  query: "",
  rating: "",
  sort: "latest",
  period: "",
  random: false,
  page: 1,
  limit: 40,
  loading: false,
  posts: [],
  selectedPost: null,
  activeDetail: null,
  sources: [],
  initialized: false,
  selectionMode: "single", // "single" | "multi"
  selectedPosts: new Map(), // key -> { post, tags, promptText }
  tooltipEnabled: true,
  selectionStamp: store.get("booru_selection_stamp", "quarantineQualified"),
};

// 原始畫廊全部 43 款檢驗印章
export const SELECTION_STAMPS = [
  "inspection", "approved", "pass", "qa", "audit", "certified", "verified", "selected", "quality", "accepted", "official", "checked", "pure", "crown",
  "inspectionDate", "inspectionReverse", "passDate", "qaDate", "reviewBadge", "birthday", "organic", "silverCapital", "visa", "hotPick", "soldOut", "hot", "nationwideShipping", "nationwideFlight",
  "sfShipping", "qualityGuarantee", "praise", "delicacySquare", "traditionVertical", "chinaCuisine", "ruyi", "snowCuisine", "traditionCircle", "delicacyWide", "traditionWide", "auspicious", "exclusiveCertification", "soldOutPostal", "quarantineQualified"
];

export const STAMP_LABELS = {
  inspection: "检验合格",
  approved: "审核通过",
  pass: "PASS",
  qa: "质量检验",
  audit: "已审核",
  certified: "专属认证",
  verified: "认证通过",
  selected: "已选",
  quality: "品质认证",
  accepted: "验收合格",
  official: "官方认证",
  checked: "检查通过",
  pure: "百分百纯正",
  crown: "优选",
  inspectionDate: "检验01日期章",
  inspectionReverse: "合格检01章",
  passDate: "PASS检02章",
  qaDate: "QA01日期章",
  reviewBadge: "审核通过齿章",
  birthday: "生日快乐",
  organic: "百分百原生态",
  silverCapital: "官银资本",
  visa: "VISA灰章",
  hotPick: "爆款推荐",
  soldOut: "今日已售罄",
  hot: "爆",
  nationwideShipping: "全国包邮",
  nationwideFlight: "全国可飞",
  sfShipping: "顺丰包邮",
  qualityGuarantee: "品质保证",
  praise: "好评如潮",
  delicacySquare: "美味佳肴方章",
  traditionVertical: "传统文化竖章",
  chinaCuisine: "中国美味",
  ruyi: "如意",
  snowCuisine: "雪尖美食",
  traditionCircle: "传统文化圆章",
  delicacyWide: "美味佳肴横章",
  traditionWide: "传统文化横章",
  auspicious: "吉祥",
  exclusiveCertification: "专属认证齿章",
  soldOutPostal: "闲鱼卖掉了邮戳",
  quarantineQualified: "检疫合格圆章"
};

export function selectionStampCopy(style) {
  return {
    inspection: ["NO.01", "INSPECTED", "APPROVED"],
    approved: ["APPROVED", "APPROVED", "PASS"],
    pass: ["QUALITY", "PASS", "NO.02"],
    qa: ["QA 01", "QUALITY", "PASS"],
    audit: ["AUDIT", "AUDITED", "OK"],
    certified: ["100%", "CERTIFIED", "PASS"],
    verified: ["CHECK", "VERIFIED", "OK"],
    selected: ["PICK", "SELECTED", "✓"],
    quality: ["QA", "QUALITY", "100%"],
    accepted: ["REVIEW", "ACCEPTED", "PASS"],
    official: ["OFFICIAL", "OFFICIAL", "SEAL"],
    checked: ["CHECK", "CHECKED", "✓"],
    pure: ["100%", "PURE", "PASS"],
    crown: ["♛", "PREMIUM", "PASS"],
    inspectionDate: ["检验01", "2020.03.10", "合格"],
    inspectionReverse: ["合格", "2020.03.10", "检01"],
    passDate: ["PASS", "2020.03.10", "检02"],
    qaDate: ["QA01", "2020.03.10", "PASS"],
    reviewBadge: ["", "审核通过", ""],
    birthday: ["HAPPY BIRTHDAY", "生日快乐", "HAPPY BIRTHDAY"],
    organic: ["百分百", "原生态", "100% PURE"],
    silverCapital: ["♛", "官银资本", "OFFICIAL"],
    visa: ["", "VISA", ""],
    hotPick: ["爆款推荐", "HOT SALE", "爆款推荐"],
    soldOut: ["100%", "今日已售罄", "SOLD OUT"],
    hot: ["", "爆", ""],
    nationwideShipping: ["全国", "全国包邮", "包邮"],
    nationwideFlight: ["全国", "全国可飞", "可飞"],
    sfShipping: ["顺丰", "顺丰包邮", "包邮"],
    qualityGuarantee: ["品质", "品质保证", "保证"],
    praise: ["好评", "好评如潮", "如潮"],
    delicacySquare: ["", "美味\n佳肴", ""],
    traditionVertical: ["", "传\n统\n文\n化", ""],
    chinaCuisine: ["", "中国\n美味", ""],
    ruyi: ["", "如\n意", ""],
    snowCuisine: ["", "雪尖\n美食", ""],
    traditionCircle: ["", "传统\n文化", ""],
    delicacyWide: ["", "美味佳肴", ""],
    traditionWide: ["", "传统文化", ""],
    auspicious: ["", "吉\n祥", ""],
    exclusiveCertification: ["", "专属认证", ""],
    soldOutPostal: ["", "", ""],
    quarantineQualified: ["", "", ""],
  }[style] || ["NO.01", "INSPECTED", "APPROVED"];
}

function createSvg(html, className, viewBox) {
  if (typeof document !== "undefined" && typeof document.createElementNS === "function") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = html;
    return svg;
  }
  const e = el("svg", { class: className, viewBox, "aria-hidden": "true" });
  e.innerHTML = html;
  return e;
}

export function quarantineQualifiedArt() {
  return createSvg(
    '<g class="aa-gallery-stamp__quarantine-rings"><circle cx="32" cy="32" r="29"/><circle cx="32" cy="32" r="25"/></g><g class="aa-gallery-stamp__quarantine-copy"><text x="32" y="25">检疫</text><text x="32" y="45">合格</text></g>',
    'aa-gallery-stamp__quarantine',
    '0 0 64 64'
  );
}

export function soldOutPostalArt() {
  return createSvg(
    '<g class="aa-gallery-stamp__postal-ring"><circle cx="34" cy="36" r="27"/><circle cx="34" cy="36" r="22"/></g><g class="aa-gallery-stamp__postal-waves"><path d="M58 20c10-6 17 4 28-2 6-3 10-7 16-9"/><path d="M59 28c10-6 17 4 28-2 6-3 10-7 16-9"/><path d="M59 36c10-6 17 4 28-2 6-3 10-7 16-9"/><path d="M58 44c10-6 17 4 28-2 6-3 10-7 16-9"/></g><text class="aa-gallery-stamp__postal-xianyu" x="34" y="20">XIANYU</text><text class="aa-gallery-stamp__postal-sold" x="34" y="59">SOLD OUT</text><g class="aa-gallery-stamp__postal-board"><rect x="5" y="25" width="65" height="27" rx="3"/><rect x="8" y="28" width="59" height="21" rx="2"/><text x="37" y="44">卖掉了</text></g>',
    'aa-gallery-stamp__postal',
    '0 0 104 72'
  );
}

const TRADITIONAL_SEAL_SPECS = Object.freeze({
  delicacySquare: { shape: "square", lines: ["美味", "佳肴"] },
  traditionVertical: { shape: "vertical", lines: ["传", "统", "文", "化"] },
  chinaCuisine: { shape: "square", lines: ["中国", "美味"] },
  ruyi: { shape: "vertical", lines: ["如", "意"] },
  snowCuisine: { shape: "square", lines: ["雪尖", "美食"] },
  traditionCircle: { shape: "circle", lines: ["传统", "文化"] },
  delicacyWide: { shape: "wide", lines: ["美味佳肴"] },
  traditionWide: { shape: "wide", lines: ["传统文化"] },
  auspicious: { shape: "vertical", lines: ["吉", "祥"] },
});

export function traditionalSealArt(style) {
  const spec = TRADITIONAL_SEAL_SPECS[style];
  if (!spec) return null;
  const dimensions = spec.shape === "vertical" ? [40, 68] : spec.shape === "wide" ? [76, 42] : [64, 64];
  const [width, height] = dimensions;
  const outline = spec.shape === "circle"
    ? `<circle cx="32" cy="32" r="29"/><circle class="aa-gallery-stamp__traditional-inset" cx="32" cy="32" r="25"/>`
    : `<rect x="2" y="2" width="${width - 4}" height="${height - 4}" rx="${spec.shape === "wide" ? 5 : 7}"/><rect class="aa-gallery-stamp__traditional-inset" x="5" y="5" width="${width - 10}" height="${height - 10}" rx="${spec.shape === "wide" ? 3 : 5}"/>`;
  const fontSize = spec.shape === "vertical" ? (spec.lines.length === 4 ? 13 : 19) : spec.shape === "wide" ? 16 : 20;
  const lineHeight = spec.shape === "vertical" && spec.lines.length === 4 ? 14 : fontSize + 3;
  const totalHeight = (spec.lines.length - 1) * lineHeight;
  const firstY = height / 2 - totalHeight / 2;
  const text = spec.lines.map((line, index) => `<text x="${width / 2}" y="${firstY + index * lineHeight}" font-size="${fontSize}">${line}</text>`).join("");
  return createSvg(
    `<g class="aa-gallery-stamp__traditional-ink">${outline}${text}</g>`,
    "aa-gallery-stamp__traditional",
    `0 0 ${width} ${height}`
  );
}

const SELECTION_STAMP_ART = Object.freeze({
  soldOutPostal: soldOutPostalArt,
  quarantineQualified: quarantineQualifiedArt,
  ...Object.fromEntries(Object.keys(TRADITIONAL_SEAL_SPECS).map((style) => [style, () => traditionalSealArt(style)])),
});

export function createSelectionStamp(initialStyle, { preview = false } = {}) {
  const top = el("span", { class: "aa-gallery-stamp__top" });
  const main = el("span", { class: "aa-gallery-stamp__main" });
  const bottom = el("span", { class: "aa-gallery-stamp__bottom" });
  const art = el("span", { class: "aa-gallery-stamp__art" });

  const root = el("span", {
    class: `aa-gallery-card__selection${preview ? " is-preview" : ""}`,
    "aria-hidden": "true",
  });
  root.append(top, main, bottom, art);

  const setStyle = (value) => {
    const style = SELECTION_STAMPS.includes(value) ? value : "quarantineQualified";
    if (root.dataset) {
      root.dataset.stamp = style;
    } else {
      root.dataset = { stamp: style };
    }
    if (typeof root.setAttribute === "function") {
      root.setAttribute("data-stamp", style);
    }
    const copy = selectionStampCopy(style);
    top.textContent = copy[0] || "";
    main.textContent = copy[1] || "";
    bottom.textContent = copy[2] || "";

    if (typeof art.replaceChildren === "function") {
      art.replaceChildren();
    } else {
      art.innerHTML = "";
    }
    const artFn = SELECTION_STAMP_ART[style];
    if (artFn) {
      const artNode = artFn();
      if (artNode) art.append(artNode);
    }
  };

  setStyle(initialStyle || state.selectionStamp || "quarantineQualified");
  return { root, setStyle };
}

export function setSelectionStamp(style) {
  if (!SELECTION_STAMPS.includes(style)) return;
  state.selectionStamp = style;
  store.set("booru_selection_stamp", style);
  // 更新當前網格中所有選中卡片的印章
  $$(".booru-card.is-selected .booru-img-wrap", $("#booruGrid")).forEach((wrap) => {
    wrap.querySelector(".aa-gallery-card__selection")?.remove();
    wrap.append(createSelectionStamp(style).root);
  });
}

// 詳情快取：避免反覆請求相同的帖子
export const detailCache = new Map();

function mediaUrl(source, url) {
  if (!url) return "";
  return `${API}/media?source=${encodeURIComponent(source)}&url=${encodeURIComponent(url)}`;
}

export async function fetchSources() {
  try {
    const res = await fetch(`${API}/sources`);
    if (!res.ok) return [];
    const data = await res.json();
    state.sources = data.sources || [];
    renderSources();
    return state.sources;
  } catch (e) {
    console.warn("無法取得 Booru sources:", e);
    return [];
  }
}

function renderSources() {
  const sel = $("#booruSource");
  if (!sel || !state.sources.length) return;
  const cur = sel.value || state.source || "danbooru";
  sel.innerHTML = "";
  for (const s of state.sources) {
    const opt = el("option", { value: s.source }, `${s.displayName || s.source}`);
    sel.append(opt);
  }
  if (state.sources.some((s) => s.source === cur)) {
    sel.value = cur;
    state.source = cur;
  } else if (state.sources.some((s) => s.source === "danbooru")) {
    sel.value = "danbooru";
    state.source = "danbooru";
  } else if (state.sources.length) {
    sel.value = state.sources[0].source;
    state.source = state.sources[0].source;
  }
}

export async function searchPosts() {
  if (state.loading) return;
  state.loading = true;
  hideHoverTooltip();
  setStatus("搜尋中...");

  const grid = $("#booruGrid");
  if (grid) grid.classList.add("loading");

  try {
    let url;
    if (state.period) {
      url = `${API}/ranking?source=${encodeURIComponent(state.source)}&period=${encodeURIComponent(state.period)}&page=${state.page}&limit=${state.limit}`;
    } else {
      const p = new URLSearchParams({
        source: state.source,
        query: state.query || "",
        sort: state.sort || "latest",
        page: String(state.page),
        limit: String(state.limit),
        random: state.random ? "1" : "0",
      });
      if (state.rating) p.append("rating", state.rating);
      url = `${API}/search?${p.toString()}`;
    }

    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    state.posts = data.posts || [];
    renderGrid();
    renderPager(data.ended);
    setStatus(`第 ${state.page} 頁（共 ${state.posts.length} 張圖）`);
  } catch (e) {
    setStatus(`取得失敗: ${e.message}`, true);
    if (grid) {
      grid.innerHTML = `<div class="booru-empty-msg">取得圖片失敗：${e.message}<br><small>請確認 ComfyUI (8188) 已啟動並安裝了 ComfyUI-Aaalice-Nodes</small></div>`;
    }
  } finally {
    state.loading = false;
    if (grid) grid.classList.remove("loading");
  }
}

export async function getDetail(source, postId) {
  const key = `${source}:${postId}`;
  if (detailCache.has(key)) {
    return detailCache.get(key);
  }
  const promise = (async () => {
    const res = await fetch(`${API}/detail?source=${encodeURIComponent(source)}&postId=${encodeURIComponent(postId)}`);
    if (!res.ok) throw new Error("獲取詳情失敗");
    return await res.json();
  })();
  detailCache.set(key, promise);
  try {
    const data = await promise;
    detailCache.set(key, data);
    return data;
  } catch (e) {
    detailCache.delete(key);
    throw e;
  }
}

// 根據提示詞設定從 detail 物件中提取提示詞標籤
export function extractPromptTags(detail, cfg = promptConfig) {
  if (!detail || !detail.tags) return [];
  const groups = detail.tags;
  const categories = cfg?.categories || ["character", "copyright", "artist", "general"];
  const replaceUnderscores = Boolean(cfg?.replaceUnderscores);
  const escapeParentheses = Boolean(cfg?.escapeParentheses);

  const blacklistSet = new Set(
    (cfg?.blacklist || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)
  );

  const all = [];
  for (const cat of ["character", "copyright", "artist", "general", "meta"]) {
    if (!categories.includes(cat)) continue;
    const list = groups[cat] || [];
    for (const rawTag of list) {
      const t = String(rawTag || "").trim();
      if (!t || blacklistSet.has(t.toLowerCase())) continue;
      let rendered = replaceUnderscores ? t.replaceAll("_", " ") : t;
      if (escapeParentheses) rendered = rendered.replaceAll("(", "\\(").replaceAll(")", "\\)");
      all.push(rendered);
    }
  }

  return [...new Set(all)];
}

// 點選圖片：加入提示詞；再次點選：去除提示詞
export async function togglePostPrompt(post, card = null) {
  const key = `${post.source}:${post.postId}`;
  const isSelected = state.selectedPosts.has(key);

  if (isSelected) {
    // 已經選中：再次點擊 -> 去除提示詞
    const info = state.selectedPosts.get(key);
    state.selectedPosts.delete(key);

    if (info && info.tags) {
      removePrompt(info.tags);
    }

    if (card) {
      card.classList.remove("is-selected");
      card.querySelector(".aa-gallery-card__selection")?.remove();
      card.querySelector(".aa-gallery-card__selected-layer")?.remove();
      card.querySelector(".booru-selected-badge")?.remove();
    }
    updateSelectionUI();
    toast(`已從主體提示詞框移除該圖標籤`, "info");
    return;
  }

  // 未選中：點擊 -> 加入提示詞
  if (card) {
    card.classList.add("prompt-added");
    setTimeout(() => card.classList.remove("prompt-added"), 500);
  }

  let detail = null;
  const cached = detailCache.get(key);
  if (cached) {
    detail = cached instanceof Promise ? await cached : cached;
  }

  if (!detail || !detail.tags) {
    toast("正在讀取提示詞標籤...", "info");
    try {
      detail = await getDetail(post.source, post.postId);
    } catch (e) {
      return toast(`獲取標籤失敗: ${e.message}`, "err");
    }
  }

  const tags = extractPromptTags(detail, promptConfig);
  if (!tags.length) {
    return toast("該圖片未包含符合條件的可用標籤", "warn");
  }

  // 單選模式：切換選取時先移除上一張圖的標籤與印章
  if (state.selectionMode === "single") {
    for (const [prevKey, prevInfo] of state.selectedPosts.entries()) {
      if (prevInfo && prevInfo.tags) {
        removePrompt(prevInfo.tags);
      }
      const prevCard = $(`[data-card-key="${prevKey}"]`, $("#booruGrid"));
      if (prevCard) {
        prevCard.classList.remove("is-selected");
        prevCard.querySelector(".aa-gallery-card__selection")?.remove();
        prevCard.querySelector(".aa-gallery-card__selected-layer")?.remove();
        prevCard.querySelector(".booru-selected-badge")?.remove();
      }
    }
    state.selectedPosts.clear();
  }

  // 加入主體提示詞框
  const promptText = tags.join(", ");
  const mainPromptEl = $("#prompt");
  appendPrompt(promptText, mainPromptEl);

  // 登記至已選集合
  state.selectedPosts.set(key, { post, tags, promptText });

  if (card) {
    card.classList.add("is-selected");
    card.querySelector(".aa-gallery-card__selection")?.remove();
    card.querySelector(".aa-gallery-card__selected-layer")?.remove();
    card.querySelector(".booru-selected-badge")?.remove();

    const wrap = card.querySelector(".booru-img-wrap");
    if (wrap) {
      const selLayer = el("span", { class: "aa-gallery-card__selected-layer" });
      const stamp = createSelectionStamp(state.selectionStamp).root;
      wrap.append(selLayer, stamp);
    }
  }

  updateSelectionUI();
  toast(`已將 ${tags.length} 個標籤加入主體提示詞框`, "ok");
}

export const addPostPromptToMain = togglePostPrompt;

export function updateSelectionUI() {
  const countEl = $("#booruSelectedCount");
  const statusEl = $("#booruSelectionStatus");
  const count = state.selectedPosts.size;
  if (countEl) countEl.textContent = `已選 ${count} 張`;
  if (statusEl) statusEl.hidden = count === 0;

  const btnSingle = $("#booruModeSingle");
  const btnMulti = $("#booruModeMulti");
  if (btnSingle) btnSingle.classList.toggle("active", state.selectionMode === "single");
  if (btnMulti) btnMulti.classList.toggle("active", state.selectionMode === "multi");
}

export function clearSelection() {
  if (!state.selectedPosts.size) return;
  for (const [key, info] of state.selectedPosts.entries()) {
    if (info && info.tags) {
      removePrompt(info.tags);
    }
  }
  state.selectedPosts.clear();
  $$(".booru-card.is-selected", $("#booruGrid")).forEach((c) => {
    c.classList.remove("is-selected");
    c.querySelector(".aa-gallery-card__selection")?.remove();
    c.querySelector(".aa-gallery-card__selected-layer")?.remove();
    c.querySelector(".booru-selected-badge")?.remove();
  });
  updateSelectionUI();
  toast("已清空所有已選圖片及其提示詞", "info");
}

export function setSelectionMode(mode) {
  if (mode !== "single" && mode !== "multi") return;
  state.selectionMode = mode;
  store.set("booru_selection_mode", mode);

  // 切換至單選模式時，若已選多張，僅保留最後一張
  if (mode === "single" && state.selectedPosts.size > 1) {
    const entries = [...state.selectedPosts.entries()];
    const keep = entries[entries.length - 1];
    for (const [k, info] of entries.slice(0, entries.length - 1)) {
      if (info && info.tags) removePrompt(info.tags);
      state.selectedPosts.delete(k);
    }
    $$(".booru-card", $("#booruGrid")).forEach((card) => {
      const key = card.getAttribute("data-card-key");
      const isKept = key === keep[0];
      card.classList.toggle("is-selected", isKept);
      if (!isKept) {
        card.querySelector(".aa-gallery-card__selection")?.remove();
        card.querySelector(".aa-gallery-card__selected-layer")?.remove();
        card.querySelector(".booru-selected-badge")?.remove();
      }
    });
  }

  updateSelectionUI();
  toast(`已切換至${mode === "single" ? "單選模式（換圖自動替換）" : "多選模式（可連續累加）"}`);
}

function setStatus(text, isErr = false) {
  const el = $("#booruStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", isErr);
}

function renderPager(ended) {
  const prev = $("#booruPrevPage");
  const next = $("#booruNextPage");
  const info = $("#booruPageInfo");
  if (prev) prev.disabled = state.page <= 1;
  if (next) next.disabled = !!ended;
  if (info) info.textContent = `第 ${state.page} 頁`;
}

export function ratingBadge(rating) {
  const r = String(rating || "").toLowerCase();
  if (r === "g" || r === "general" || r === "safe") return { text: "SFW", cls: "sfw" };
  if (r === "s" || r === "sensitive") return { text: "Sens", cls: "sens" };
  if (r === "q" || r === "questionable") return { text: "R15", cls: "quest" };
  if (r === "e" || r === "explicit") return { text: "R18", cls: "nsfw" };
  return { text: r || "—", cls: "unknown" };
}

/* ================= 懸浮預覽提示詞卡片 (Hover Preview Tooltip) ================= */
let hoverTooltipEl = null;
let hoverTimer = null;
let hideTimer = null;
let currentHoverPost = null;

function ensureHoverTooltip() {
  if (hoverTooltipEl && document.body.contains(hoverTooltipEl)) return hoverTooltipEl;

  const tip = el("div", {
    id: "booruHoverTooltip",
    class: "booru-hover-tooltip",
    hidden: true,
  });

  const mediaWrap = el("div", { class: "booru-hover-media" });
  const hoverImg = el("img", { class: "booru-hover-img", alt: "" });
  const badgeBar = el("div", { class: "booru-hover-badges" });
  const badgeRating = el("span", { class: "booru-tag-badge", id: "booruHoverRating" }, "SFW");
  const badgeDim = el("span", { class: "booru-tag-badge dim", id: "booruHoverDim" }, "");
  const badgeScore = el("span", { class: "booru-tag-badge score", id: "booruHoverScore" }, "");
  badgeBar.append(badgeRating, badgeDim, badgeScore);
  mediaWrap.append(hoverImg, badgeBar);

  const body = el("div", { class: "booru-hover-content" });

  const head = el("div", { class: "booru-hover-head" });
  const title = el("span", { class: "booru-hover-title", id: "booruHoverTitle" }, "");
  const detailBtn = el("button", {
    class: "booru-hover-detail-btn",
    type: "button",
    title: "查看完整資訊與全部標籤分類",
  }, "🔍 完整詳情");
  head.append(title, detailBtn);

  const tagsWrap = el("div", { class: "booru-hover-tags", id: "booruHoverTags" });

  const promptWrap = el("div", { class: "booru-hover-prompt-wrap" });
  const promptLbl = el("span", { class: "booru-hover-prompt-lbl", id: "booruHoverPromptLbl" }, "提示詞預覽 (PROMPT)");
  const promptBox = el("div", { class: "booru-hover-prompt-box", id: "booruHoverPromptBox" });
  promptWrap.append(promptLbl, promptBox);

  const hint = el("div", { class: "booru-hover-hint" }, "💡 點選圖片直接填入／移除「主體提示詞框」");
  const actions = el("div", { class: "booru-hover-actions" });
  const initBtn = el("button", { class: "booru-hover-btn go", type: "button" }, "🖼️ 設為輸入圖");
  const copyBtn = el("button", { class: "booru-hover-btn", type: "button" }, "📋 複製提示詞");
  actions.append(initBtn, copyBtn);

  body.append(head, tagsWrap, promptWrap, hint, actions);
  tip.append(mediaWrap, body);

  tip.addEventListener("mouseenter", () => cancelHideHoverTooltip());
  tip.addEventListener("mouseleave", () => scheduleHideHoverTooltip());

  detailBtn.onclick = (e) => {
    e.stopPropagation();
    hideHoverTooltip();
    if (currentHoverPost) openDetailModal(currentHoverPost);
  };

  initBtn.onclick = (e) => {
    e.stopPropagation();
    if (currentHoverPost) setPostAsInput(currentHoverPost);
  };

  copyBtn.onclick = (e) => {
    e.stopPropagation();
    const txt = promptBox.textContent?.trim();
    if (txt && txt !== "載入提示詞中...") {
      navigator.clipboard.writeText(txt);
      toast("已複製提示詞到剪貼簿", "ok");
    }
  };

  document.body.append(tip);
  hoverTooltipEl = tip;
  return hoverTooltipEl;
}

function positionHoverTooltip(cardEl, tipEl) {
  if (!cardEl || !tipEl) return;
  const cardRect = cardEl.getBoundingClientRect();
  const tipWidth = tipEl.offsetWidth || 660;
  const tipHeight = tipEl.offsetHeight || 520;

  let left;
  if (cardRect.right + tipWidth + 16 <= window.innerWidth) {
    left = cardRect.right + 10;
  } else if (cardRect.left - tipWidth - 10 >= 0) {
    left = cardRect.left - tipWidth - 10;
  } else {
    left = Math.max(10, Math.min(window.innerWidth - tipWidth - 10, cardRect.left));
  }

  let top = cardRect.top;
  if (top + tipHeight > window.innerHeight - 10) {
    top = Math.max(10, window.innerHeight - tipHeight - 10);
  } else if (top < 10) {
    top = 10;
  }

  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}

export function showHoverTooltip(post, cardEl) {
  if (!state.tooltipEnabled) return;
  cancelHideHoverTooltip();
  if (hoverTimer) clearTimeout(hoverTimer);

  hoverTimer = setTimeout(async () => {
    currentHoverPost = post;
    const tip = ensureHoverTooltip();
    tip.hidden = false;

    const img = tip.querySelector(".booru-hover-img");
    const previewSrc = mediaUrl(post.source, post.previewUrl || post.sampleUrl);
    img.src = previewSrc;

    if (post.sampleUrl && post.sampleUrl !== post.previewUrl) {
      const sampleSrc = mediaUrl(post.source, post.sampleUrl);
      const preImg = new Image();
      preImg.onload = () => {
        if (currentHoverPost?.postId === post.postId) {
          img.src = sampleSrc;
        }
      };
      preImg.src = sampleSrc;
    }

    const title = tip.querySelector("#booruHoverTitle");
    title.textContent = `${post.source.toUpperCase()} #${post.postId}`;

    const rb = ratingBadge(post.rating);
    const rEl = tip.querySelector("#booruHoverRating");
    rEl.className = `booru-tag-badge ${rb.cls}`;
    rEl.textContent = rb.text;

    const dimEl = tip.querySelector("#booruHoverDim");
    dimEl.textContent = post.width && post.height ? `${post.width}×${post.height}` : "";
    dimEl.hidden = !dimEl.textContent;

    const scoreEl = tip.querySelector("#booruHoverScore");
    scoreEl.textContent = post.score ? `★${post.score}` : "";
    scoreEl.hidden = !scoreEl.textContent;

    const tagsCont = tip.querySelector("#booruHoverTags");
    const promptBox = tip.querySelector("#booruHoverPromptBox");
    const promptLbl = tip.querySelector("#booruHoverPromptLbl");

    positionHoverTooltip(cardEl, tip);

    const key = `${post.source}:${post.postId}`;
    let detail = detailCache.get(key);
    if (!detail) {
      tagsCont.innerHTML = '<span class="muted sm">載入標籤與提示詞中...</span>';
      promptBox.textContent = "載入提示詞中...";
      try {
        detail = await getDetail(post.source, post.postId);
      } catch (e) {
        if (currentHoverPost?.postId === post.postId) {
          tagsCont.innerHTML = `<span class="err sm">載入標籤失敗: ${e.message}</span>`;
          promptBox.textContent = "";
        }
        return;
      }
    } else if (detail instanceof Promise) {
      tagsCont.innerHTML = '<span class="muted sm">載入標籤與提示詞中...</span>';
      promptBox.textContent = "載入提示詞中...";
      try {
        detail = await detail;
      } catch (e) {
        if (currentHoverPost?.postId === post.postId) {
          tagsCont.innerHTML = `<span class="err sm">載入標籤失敗: ${e.message}</span>`;
          promptBox.textContent = "";
        }
        return;
      }
    }

    if (currentHoverPost?.postId !== post.postId) return;

    renderHoverTags(tagsCont, detail);

    const promptTags = extractPromptTags(detail, promptConfig);
    if (promptTags.length) {
      promptLbl.textContent = `提示詞預覽 (${promptTags.length} 個標籤)`;
      promptBox.textContent = promptTags.join(", ");
    } else {
      promptLbl.textContent = "提示詞預覽";
      promptBox.textContent = "未檢測到標籤";
    }

    positionHoverTooltip(cardEl, tip);
  }, 100);
}

function renderHoverTags(container, detail) {
  container.innerHTML = "";
  const groups = detail.tags || {};
  const hasChar = groups.character?.length;
  const hasCopy = groups.copyright?.length;
  const hasArt = groups.artist?.length;

  if (hasChar || hasCopy || hasArt) {
    const chipRow = el("div", { class: "booru-hover-chips" });
    if (hasChar) {
      for (const c of groups.character.slice(0, 3)) {
        chipRow.append(el("span", { class: "booru-pill sm cat-char" }, `🌸 ${c}`));
      }
    }
    if (hasCopy) {
      for (const cp of groups.copyright.slice(0, 2)) {
        chipRow.append(el("span", { class: "booru-pill sm cat-copy" }, `📚 ${cp}`));
      }
    }
    if (hasArt) {
      for (const a of groups.artist.slice(0, 2)) {
        chipRow.append(el("span", { class: "booru-pill sm cat-art" }, `🎨 ${a}`));
      }
    }
    container.append(chipRow);
  }
}

export function hideHoverTooltip() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (hoverTooltipEl) {
    hoverTooltipEl.hidden = true;
  }
  currentHoverPost = null;
}

export function scheduleHideHoverTooltip() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideHoverTooltip();
  }, 120);
}

export function cancelHideHoverTooltip() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

/* ================= 瀑布流版面核心 (Virtual Masonry Layout) ================= */
export function masonryColumnCount(width, { minCardWidth = 118, gap = 6, maxColumns = 6 } = {}) {
  return Math.max(1, Math.min(maxColumns, Math.floor((Math.max(1, width) + gap) / (minCardWidth + gap))));
}

export class VirtualMasonryLayout {
  constructor({ width = 1, minCardWidth = 118, gap = 6, maxColumns = 6 } = {}) {
    this.options = { minCardWidth, gap, maxColumns };
    this.items = [];
    this.placements = [];
    this.placementsByKey = new Map();
    this.columns = [];
    this.keys = new Set();
    this.itemsByKey = new Map();
    this.sizesByKey = new Map();
    this.revision = 0;
    this.configure(width);
  }

  configure(width) {
    const nextWidth = Math.max(1, Number(width) || 1);
    const nextColumns = masonryColumnCount(nextWidth, this.options);
    if (this.width === nextWidth && this.columnCount === nextColumns) return false;
    this.width = nextWidth;
    this.columnCount = nextColumns;
    this.cardWidth = (nextWidth - this.options.gap * (nextColumns - 1)) / nextColumns;
    this.reflow();
    return true;
  }

  append(items) {
    for (const item of items || []) this._place(item, this.items.length);
    return this;
  }

  setItems(items) {
    this.items = [];
    this.placements = [];
    this.placementsByKey = new Map();
    this.columns = Array.from({ length: this.columnCount }, () => []);
    this.heights = Array(this.columnCount).fill(0);
    this.keys = new Set();
    this.itemsByKey = new Map();
    this.sizesByKey = new Map();
    this.append(items);
    this.revision += 1;
    return this;
  }

  reflow() {
    const items = [...(this.items || [])];
    this.items = [];
    this.placements = [];
    this.placementsByKey = new Map();
    this.columns = Array.from({ length: this.columnCount }, () => []);
    this.heights = Array(this.columnCount).fill(0);
    this.keys = new Set();
    this.itemsByKey = new Map();
    this.sizesByKey = new Map();
    this.append(items);
    this.revision += 1;
    return this;
  }

  _place(item, index) {
    if (!this.columns.length) this.reflow();
    const key = `${item?.source}:${item?.postId}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.itemsByKey.set(key, item);
    this.sizesByKey.set(key, { width: item?.width, height: item?.height });
    let column = 0;
    for (let current = 1; current < this.columnCount; current += 1) {
      if (this.heights[current] < this.heights[column]) column = current;
    }
    const width = Math.max(1, Number(item?.width) || 1);
    const height = Math.max(1, Number(item?.height) || (item?.width ? item.width : 1.33));
    const displayHeight = Math.round(this.cardWidth * height / width);
    const y = this.heights[column];
    const x = Math.round(column * (this.cardWidth + this.options.gap));
    const placement = {
      index,
      item,
      key,
      column,
      x,
      y,
      width: Math.round(this.cardWidth),
      height: displayHeight,
      bottom: y + displayHeight,
    };
    this.items.push(item);
    this.placements.push(placement);
    this.placementsByKey.set(key, placement);
    this.columns[column].push(placement);
    this.heights[column] = placement.bottom + this.options.gap;
  }

  updateItemSize(key, width, height) {
    const item = this.itemsByKey.get(key);
    const placement = this.placementsByKey.get(key);
    const current = this.sizesByKey.get(key);
    if (!item || !placement || !(width > 0) || !(height > 0) || (current?.width === width && current?.height === height)) return false;
    this.sizesByKey.set(key, { width, height });
    item.width = width;
    item.height = height;
    return Math.abs(placement.height - this.cardWidth * height / width) > 1e-6;
  }

  get totalHeight() {
    return Math.max(0, ...(this.heights || [0])) - (this.items.length ? this.options.gap : 0);
  }

  viewportAnchor(scrollTop) {
    const top = Math.max(0, Number(scrollTop) || 0);
    let anchor = null;
    let distance = Infinity;
    for (const column of this.columns) {
      for (const placement of column) {
        const d = Math.abs(placement.y - top);
        if (d < distance) {
          anchor = placement;
          distance = d;
        }
      }
    }
    return anchor ? { key: anchor.key, offset: top - anchor.y, index: anchor.index } : null;
  }

  scrollTopForAnchor(anchor, viewportHeight = 0) {
    const placement = this.placementsByKey.get(String(anchor?.key || ""));
    const offset = Number(anchor?.offset);
    if (!placement || !Number.isFinite(offset)) return null;
    const maximum = Math.max(0, this.totalHeight - Math.max(0, Number(viewportHeight) || 0));
    return Math.min(maximum, Math.max(0, placement.y + offset));
  }
}

export function ratingKey(value) {
  const rating = String(value || "").trim().toLowerCase();
  return ({ g: "general", s: "sensitive", q: "questionable", e: "explicit" })[rating] || rating || "unknown";
}

export function ratingTone(value) {
  const rating = ratingKey(value);
  return ["general", "safe", "sensitive", "questionable", "explicit"].includes(rating) ? rating : "unknown";
}

export function ratingLabel(value) {
  const key = ratingKey(value);
  return ({ general: "全龄", safe: "全龄", sensitive: "敏感", questionable: "疑虑", explicit: "色情" })[key] || "—";
}

let currentMasonryLayout = null;
let currentMasonrySpacer = null;
let currentGridResizeObserver = null;
let reflowFrame = 0;

export function scheduleMasonryReflow() {
  if (reflowFrame) return;
  if (typeof requestAnimationFrame === "function") {
    reflowFrame = requestAnimationFrame(() => {
      reflowFrame = 0;
      reflowMasonryCards();
    });
  } else {
    reflowMasonryCards();
  }
}

export function reflowMasonryCards() {
  if (!currentMasonryLayout || !currentMasonrySpacer) return;
  currentMasonryLayout.reflow();
  currentMasonrySpacer.style.height = `${Math.ceil(currentMasonryLayout.totalHeight)}px`;
  const cards = currentMasonrySpacer.children || [];
  for (const card of cards) {
    const key = card.dataset?.cardKey;
    if (!key) continue;
    const placement = currentMasonryLayout.placementsByKey.get(key);
    if (placement) {
      card.style.width = `${placement.width}px`;
      card.style.height = `${placement.height}px`;
      card.style.transform = `translate3d(${placement.x}px, ${placement.y}px, 0)`;
    }
  }
}

/* ================= 瀑布流卡片列表渲染 ================= */
export function renderGrid() {
  const grid = $("#booruGrid");
  if (!grid) return;
  grid.innerHTML = "";
  hideHoverTooltip();

  if (!state.posts.length) {
    grid.innerHTML = '<div class="booru-empty-msg">查無相關圖片，請嘗試變更搜尋標籤或篩選條件</div>';
    currentMasonryLayout = null;
    currentMasonrySpacer = null;
    return;
  }

  const spacer = el("div", { class: "aa-virtual-masonry__spacer" });
  grid.append(spacer);
  currentMasonrySpacer = spacer;

  const containerWidth = Math.max(1, grid.clientWidth || 500);
  const layout = new VirtualMasonryLayout({ width: containerWidth, minCardWidth: 118, gap: 6, maxColumns: 6 });
  layout.setItems(state.posts);
  currentMasonryLayout = layout;

  spacer.style.height = `${Math.ceil(layout.totalHeight)}px`;

  for (const post of state.posts) {
    const key = `${post.source}:${post.postId}`;
    const isSelected = state.selectedPosts.has(key);
    const placement = layout.placementsByKey.get(key);

    const card = el("article", {
      class: "aa-gallery-card booru-card" + (isSelected ? " is-selected" : ""),
      "data-id": post.postId,
      "data-source": post.source,
      "data-card-key": key,
      tabindex: 0,
    });
    if (placement) {
      card.style.width = `${placement.width}px`;
      card.style.height = `${placement.height}px`;
      card.style.transform = `translate3d(${placement.x}px, ${placement.y}px, 0)`;
    }

    const imgWrap = el("div", { class: "aa-gallery-card__surface booru-img-wrap" });
    const img = el("img", {
      loading: "lazy",
      alt: post.postId,
      src: mediaUrl(post.source, post.previewUrl || post.sampleUrl),
    });

    img.onload = () => {
      img.classList.add("loaded");
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        if (layout.updateItemSize(key, img.naturalWidth, img.naturalHeight)) {
          scheduleMasonryReflow();
        }
      }
    };
    img.onerror = () => {
      img.alt = "載入失敗";
      imgWrap.classList.add("is-error");
    };
    imgWrap.append(img);

    // 載入 shimmer 動畫層
    const loadingLayer = el("div", { class: "aa-gallery-card__loading", "aria-hidden": "true" });
    imgWrap.append(loadingLayer);

    // 陰影漸變層
    const shadeLayer = el("div", { class: "aa-gallery-card__shade" });
    imgWrap.append(shadeLayer);

    // 分級標籤膠囊（右上方，符合原版設計：全齡、敏感、疑慮、色情）
    const tone = ratingTone(post.rating);
    const lbl = ratingLabel(post.rating);
    const ratingEl = el("span", {
      class: `aa-gallery-card__rating ${ratingBadge(post.rating).cls}`,
      "data-rating": tone,
    }, lbl);
    imgWrap.append(ratingEl);

    // 已選中印章與圖層 (符合原始畫廊設計：印章置中，無角落小標)
    if (isSelected) {
      const selLayer = el("span", { class: "aa-gallery-card__selected-layer" });
      const stamp = createSelectionStamp(state.selectionStamp).root;
      imgWrap.append(selLayer, stamp);
    }

    // 快捷懸浮操作列（懸浮時淡入取代分級標籤）
    const hoverBar = el("div", { class: "aa-gallery-card__actions booru-hover-bar" });
    const initBtn = el("button", {
      class: "aa-gallery-card-action booru-quick-btn is-edit",
      type: "button",
      title: "設為輸入圖（圖生圖）",
    }, "🖼️");
    initBtn.onclick = (e) => {
      e.stopPropagation();
      setPostAsInput(post);
    };

    const detailBtn = el("button", {
      class: "aa-gallery-card-action booru-quick-btn is-detail",
      type: "button",
      title: "查看詳細資訊與所有分類標籤",
    }, "🔍");
    detailBtn.onclick = (e) => {
      e.stopPropagation();
      openDetailModal(post);
    };

    hoverBar.append(initBtn, detailBtn);
    card.append(imgWrap, hoverBar);

    // 懸浮預覽圖片與提示詞
    card.addEventListener("mouseenter", () => showHoverTooltip(post, card));
    card.addEventListener("mouseleave", () => scheduleHideHoverTooltip());

    // 點擊卡片：加入或去除提示詞
    card.onclick = async (e) => {
      if (e.target.closest(".booru-quick-btn") || e.target.closest(".aa-gallery-card-action")) return;
      await togglePostPrompt(post, card);
    };

    // 雙擊開啟完整詳情彈窗
    card.ondblclick = () => openDetailModal(post);

    spacer.append(card);
  }

  // 設置容器 ResizeObserver 自動重排
  if (typeof ResizeObserver === "function" && !currentGridResizeObserver) {
    currentGridResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0 && currentMasonryLayout) {
          if (currentMasonryLayout.configure(w)) {
            scheduleMasonryReflow();
          }
        }
      }
    });
    currentGridResizeObserver.observe(grid);
  }

  updateSelectionUI();
}

export async function openDetailModal(post) {
  state.selectedPost = post;
  hideHoverTooltip();
  const modal = $("#booruModal");
  if (!modal) return;

  const modalImg = $("#booruModalImg");
  const modalTitle = $("#booruModalTitle");
  const modalMeta = $("#booruModalMeta");
  const extLink = $("#booruExternalLink");
  const tagsCont = $("#booruTagsContainer");

  modalTitle.textContent = `${post.source.toUpperCase()} #${post.postId}`;
  if (extLink) extLink.href = post.postUrl || "#";
  if (modalImg) {
    modalImg.src = mediaUrl(post.source, post.sampleUrl || post.previewUrl);
  }
  if (tagsCont) tagsCont.innerHTML = '<span class="muted sm">載入標籤與詳情中...</span>';
  if (modalMeta) {
    modalMeta.textContent = `${post.width}×${post.height} • 評分: ${post.score || 0} • 收藏: ${post.favCount || 0}`;
  }

  modal.hidden = false;

  try {
    const detail = await getDetail(post.source, post.postId);
    state.activeDetail = detail;

    if (modalImg && detail.sampleUrl) {
      modalImg.src = mediaUrl(detail.source, detail.sampleUrl);
    }

    if (modalMeta) {
      const rb = ratingBadge(detail.rating);
      modalMeta.innerHTML = `
        <span class="booru-tag-badge ${rb.cls}">${rb.text}</span>
        <span><b>尺寸:</b> ${detail.width}×${detail.height}</span>
        <span><b>評分:</b> ${detail.score || 0}</span>
        <span><b>格式:</b> ${detail.fileExt || "jpg"}</span>
      `;
    }

    renderDetailTags(detail);
  } catch (e) {
    if (tagsCont) tagsCont.innerHTML = `<span class="err sm">載入標籤失敗：${e.message}</span>`;
  }
}

function renderDetailTags(detail) {
  const cont = $("#booruTagsContainer");
  if (!cont) return;
  cont.innerHTML = "";

  const groups = detail.tags || {};
  const CATEGORIES = [
    { key: "character", label: "🌸 角色 (Character)", cls: "cat-char" },
    { key: "copyright", label: "📚 作品 (Copyright)", cls: "cat-copy" },
    { key: "artist", label: "🎨 畫師 (Artist)", cls: "cat-art" },
    { key: "general", label: "🏷️ 常規標籤 (General)", cls: "cat-gen" },
    { key: "meta", label: "⚙️ 元數據 (Meta)", cls: "cat-meta" },
  ];

  let hasAny = false;
  for (const cat of CATEGORIES) {
    const list = groups[cat.key];
    if (!list || !list.length) continue;
    hasAny = true;

    const grpEl = el("div", { class: "booru-tag-group" });
    grpEl.append(el("div", { class: "booru-tag-group-title" }, `${cat.label} (${list.length})`));

    const pillWrap = el("div", { class: "booru-pills-wrap" });
    for (const tag of list) {
      const pill = el("button", {
        class: `booru-pill ${cat.cls}`,
        type: "button",
        title: `點選插入主體提示詞: ${tag}`,
      }, tag);
      pill.onclick = () => {
        appendPrompt(tag, $("#prompt"));
        toast(`已填入主體提示詞: ${tag}`);
      };
      pillWrap.append(pill);
    }
    grpEl.append(pillWrap);
    cont.append(grpEl);
  }

  if (!hasAny) {
    cont.innerHTML = '<span class="muted sm">該帖子未記錄標籤</span>';
  }
}

// 設為輸入圖
export async function setPostAsInput(post) {
  const detail = state.activeDetail && state.activeDetail.postId === post.postId ? state.activeDetail : post;
  const targetUrl = detail.mediaUrl || detail.sampleUrl || detail.previewUrl;
  if (!targetUrl) return toast("找不到圖片連結", "err");

  toast("正在快取並設定為輸入圖...");
  try {
    const proxyUrl = mediaUrl(detail.source, targetUrl);
    const resp = await fetch(proxyUrl);
    if (!resp.ok) throw new Error(`圖片下載失敗 (HTTP ${resp.status})`);
    const blob = await resp.blob();

    const ext = detail.fileExt || "png";
    const file = new File([blob], `booru_${detail.source}_${detail.postId}.${ext}`, { type: blob.type || "image/png" });
    const uploaded = await uploadFile(file);

    setInit(uploaded);
    setMode("img2img");

    $("#booruModal").hidden = true;
    hideHoverTooltip();
    toast("已成功設定為輸入圖，並切換至圖生圖模式！", "ok");
  } catch (e) {
    toast(`設定輸入圖失敗: ${e.message}`, "err");
  }
}

// 加入多圖參考
export async function addPostAsRef(post) {
  const detail = state.activeDetail && state.activeDetail.postId === post.postId ? state.activeDetail : post;
  const targetUrl = detail.mediaUrl || detail.sampleUrl || detail.previewUrl;
  if (!targetUrl) return toast("找不到圖片連結", "err");

  toast("正在加入多圖參考...");
  try {
    const proxyUrl = mediaUrl(detail.source, targetUrl);
    const resp = await fetch(proxyUrl);
    if (!resp.ok) throw new Error("下載圖片失敗");
    const blob = await resp.blob();

    const ext = detail.fileExt || "png";
    const file = new File([blob], `booru_${detail.source}_${detail.postId}.${ext}`, { type: blob.type || "image/png" });
    const uploaded = await uploadFile(file);

    refs.add({
      name: uploaded.name,
      width: uploaded.width,
      height: uploaded.height,
      role: "person",
    });
    toast("已成功加入多圖參考！", "ok");
  } catch (e) {
    toast(`加入參考失敗: ${e.message}`, "err");
  }
}

// 全部標籤填入提示詞（填入主體提示詞框）
export function insertAllTags(detail) {
  const d = detail || state.activeDetail || state.selectedPost;
  if (!d || !d.tags) return toast("尚未取得標籤", "warn");
  const tags = extractPromptTags(d, promptConfig);

  if (!tags.length) return toast("沒有可用標籤", "warn");
  appendPrompt(tags.join(", "), $("#prompt"));
  toast(`已將 ${tags.length} 個標籤加入主體提示詞框`, "ok");
}

/* ================= 提示詞處理設定彈窗 ================= */
export function openPromptConfigDialog() {
  const modal = $("#booruPromptModal");
  if (!modal) return;

  const charCheck = $("#booruCatChar");
  const copyCheck = $("#booruCatCopy");
  const artCheck = $("#booruCatArt");
  const genCheck = $("#booruCatGen");
  const metaCheck = $("#booruCatMeta");
  const underCheck = $("#booruReplaceUnderscores");
  const parenCheck = $("#booruEscapeParentheses");
  const blText = $("#booruPromptBlacklist");

  if (charCheck) charCheck.checked = promptConfig.categories.includes("character");
  if (copyCheck) copyCheck.checked = promptConfig.categories.includes("copyright");
  if (artCheck) artCheck.checked = promptConfig.categories.includes("artist");
  if (genCheck) genCheck.checked = promptConfig.categories.includes("general");
  if (metaCheck) metaCheck.checked = promptConfig.categories.includes("meta");
  if (underCheck) underCheck.checked = !!promptConfig.replaceUnderscores;
  if (parenCheck) parenCheck.checked = !!promptConfig.escapeParentheses;
  if (blText) blText.value = (promptConfig.blacklist || []).join("\n");

  modal.hidden = false;
}

export function savePromptConfigFromDialog() {
  const categories = [];
  if ($("#booruCatChar")?.checked) categories.push("character");
  if ($("#booruCatCopy")?.checked) categories.push("copyright");
  if ($("#booruCatArt")?.checked) categories.push("artist");
  if ($("#booruCatGen")?.checked) categories.push("general");
  if ($("#booruCatMeta")?.checked) categories.push("meta");

  promptConfig.categories = categories.length ? categories : ["general"];
  promptConfig.replaceUnderscores = $("#booruReplaceUnderscores")?.checked ?? false;
  promptConfig.escapeParentheses = $("#booruEscapeParentheses")?.checked ?? false;

  const rawBl = $("#booruPromptBlacklist")?.value || "";
  promptConfig.blacklist = rawBl
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  store.set("booru_prompt_config", promptConfig);
  $("#booruPromptModal").hidden = true;
  toast("提示詞處理設定已儲存！", "ok");
}

export const GALLERY_CATEGORIES = ["character", "copyright", "artist", "general", "meta"];
export const CATEGORY_LABELS = {
  character: "🌸 角色",
  copyright: "📚 作品",
  artist: "🎨 画师",
  general: "🏷️ 常规",
  meta: "⚙️ 元数据",
};

let currentSettingsTab = "accounts";
let currentSettingsSource = "danbooru";
let currentSettingsCache = null;
const sourceInputsMap = {};
const sourceClearsSet = {};

export function parseTagLines(text) {
  if (!text) return [];
  return text
    .split(/[\r\n,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/* ================= 完整畫廊設定彈窗 (5 標籤) ================= */
export async function openSettingsDialog(targetTab = "accounts") {
  const modal = $("#booruSettingsModal");
  if (!modal) return;

  modal.hidden = false;
  currentSettingsTab = targetTab || "accounts";

  // 切換分頁導航
  const navButtons = $$(".aa-gallery-settings__nav-item", modal);
  const pages = $$(".aa-gallery-settings__page", modal);

  const setPage = (pageName) => {
    currentSettingsTab = pageName;
    navButtons.forEach((btn) => {
      const active = btn.getAttribute("data-page") === pageName;
      btn.classList.toggle("is-active", active);
    });
    pages.forEach((page) => {
      const active = page.getAttribute("data-page") === pageName;
      page.hidden = !active;
      page.classList.toggle("is-active", active);
    });
  };

  navButtons.forEach((btn) => {
    btn.onclick = () => setPage(btn.getAttribute("data-page"));
  });

  setPage(currentSettingsTab);

  // 嘗試取得後端最新配置
  let cfg = null;
  try {
    if (typeof fetch === "function") {
      const res = await fetch(`${API}/settings`);
      if (res.ok) cfg = await res.json();
    }
  } catch (e) {
    console.warn("無法取得 Booru 畫廊後端設定:", e);
  }
  currentSettingsCache = cfg || {};

  // 1. 賬戶 (Accounts)
  renderSettingsAccounts(currentSettingsCache);

  // 2. 瀏覽 (Browse)
  renderSettingsBrowse(currentSettingsCache);

  // 3. 內容黑名單 (Blacklist)
  renderSettingsBlacklist(currentSettingsCache);

  // 4. 提示詞 (Prompt)
  renderSettingsPrompt(currentSettingsCache);

  // 5. 存儲 (Storage / Performance)
  renderSettingsStorage(currentSettingsCache);
}

function renderSettingsAccounts(cfg) {
  const sourceList = $("#booruSettingsSourceList");
  const sourceDetail = $("#booruSettingsSourceDetail");
  const summaryEl = $("#booruAccountsSummary");
  if (!sourceList || !sourceDetail) return;

  sourceList.innerHTML = "";
  sourceDetail.innerHTML = "";

  const defaultSources = [
    {
      source: "danbooru",
      displayName: "Danbooru",
      authFields: ["username", "apiKey"],
      credentialsUrl: "https://danbooru.donmai.us/profile",
      favoriteRead: true,
      favoriteWrite: true,
      categorizedTags: true,
      rankingPeriods: ["day", "week", "month"],
    },
    {
      source: "gelbooru",
      displayName: "Gelbooru",
      authFields: ["userId", "apiKey"],
      credentialsUrl: "https://gelbooru.com/index.php?page=account&s=options",
      favoriteRead: true,
      favoriteWrite: false,
      categorizedTags: true,
      rankingPeriods: [],
    },
    {
      source: "safebooru",
      displayName: "Safebooru",
      authFields: [],
      credentialsUrl: "",
      favoriteRead: false,
      favoriteWrite: false,
      categorizedTags: true,
      rankingPeriods: [],
    },
    {
      source: "aitag",
      displayName: "AI TAG",
      authFields: [],
      credentialsUrl: "",
      favoriteRead: false,
      favoriteWrite: false,
      categorizedTags: true,
      rankingPeriods: [],
    },
  ];

  const caps = state.sources && state.sources.length ? state.sources : defaultSources;
  const credentialStatus = cfg?.credentialStatus || {};

  let configuredCount = 0;
  for (const cap of caps) {
    sourceInputsMap[cap.source] = sourceInputsMap[cap.source] || {};
    sourceClearsSet[cap.source] = sourceClearsSet[cap.source] || new Set();

    const authFields = cap.authFields || [];
    const isConfigured = authFields.length > 0 && authFields.every((f) => {
      const statusKey = `has${f[0].toUpperCase()}${f.slice(1)}`;
      return credentialStatus[cap.source]?.[statusKey];
    });
    if (isConfigured) configuredCount++;
  }

  if (summaryEl) {
    summaryEl.textContent = `${configuredCount} 个账户就绪`;
  }

  const renderActiveSourceDetail = (cap) => {
    sourceDetail.innerHTML = "";
    const authFields = cap.authFields || [];
    const isConfigured = authFields.length > 0 && authFields.every((f) => {
      const statusKey = `has${f[0].toUpperCase()}${f.slice(1)}`;
      return credentialStatus[cap.source]?.[statusKey];
    });

    const stateText = !authFields.length
      ? "公开访问"
      : isConfigured
      ? "已配置"
      : "未配置";

    const detailCard = el("div", {
      class: `aa-gallery-settings__source ${isConfigured ? "is-configured" : authFields.length ? "needs-setup" : "is-public"}`,
    });

    // 標題行
    const header = el("div", { class: "row between" });
    const identity = el("div", { class: "aa-gallery-settings__source-identity" });
    const mark = el("span", { class: "aa-gallery-settings__source-mark" }, isConfigured ? "✓" : authFields.length ? "🔒" : "🌐");
    const titleBox = el("div");
    titleBox.append(el("strong", null, cap.displayName || cap.source), el("small", null, ` (${cap.source})`));
    identity.append(mark, titleBox);

    const stateBadge = el("span", { class: "aa-gallery-settings__source-state" });
    stateBadge.append(el("i"), document.createTextNode(` ${stateText}`));
    header.append(identity, stateBadge);
    detailCard.append(header);

    // 能力標籤
    const capsBox = el("div", { class: "aa-gallery-settings__capabilities" });
    if (!authFields.length) {
      capsBox.append(el("span", null, "公开访问"));
    }
    if (cap.favoriteRead) capsBox.append(el("span", null, "可读取收藏"));
    if (cap.favoriteWrite) capsBox.append(el("span", null, "可修改收藏"));
    if (cap.categorizedTags) capsBox.append(el("span", null, "分类标签"));
    if ((cap.rankingPeriods || []).length) capsBox.append(el("span", null, "排行榜"));
    detailCard.append(capsBox);

    // 憑據輸入框
    if (authFields.length) {
      const credGrid = el("div", { class: "aa-gallery-settings__credentials" });
      for (const fieldName of authFields) {
        const credItem = el("div", { class: "aa-gallery-settings__credential" });
        const labelText = fieldName === "username" ? "用户名 (Username)"
          : fieldName === "userId" ? "用户 ID (User ID)"
          : fieldName === "apiKey" ? "API Key"
          : fieldName;
        const lbl = el("label", null, labelText);

        const row = el("div", { class: "aa-gallery-settings__credential-row" });
        const input = el("input", {
          type: fieldName.toLowerCase().includes("key") ? "password" : "text",
          class: "sm",
          placeholder: credentialStatus[cap.source]?.[`has${fieldName[0].toUpperCase()}${fieldName.slice(1)}`]
            ? "已保存；留空保持原值"
            : `请输入 ${labelText}`,
        });
        if (sourceInputsMap[cap.source][fieldName]?.value) {
          input.value = sourceInputsMap[cap.source][fieldName].value;
        }
        sourceInputsMap[cap.source][fieldName] = input;

        const clearBtn = el("button", {
          type: "button",
          class: "akey sm warn",
          title: "清除已保存值",
        }, "✕");
        clearBtn.onclick = () => {
          sourceClearsSet[cap.source].add(fieldName);
          input.value = "";
          input.placeholder = "保存后将清除此值";
          toast(`已标记清除 ${cap.displayName} 的 ${labelText}`, "info");
        };

        row.append(input, clearBtn);
        credItem.append(lbl, row);
        credGrid.append(credItem);
      }

      if (cap.credentialsUrl) {
        const link = el("a", {
          href: cap.credentialsUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "aa-gallery-settings__credentials-link",
        }, `前往 ${cap.displayName} 账户页面获取 API Key ↗`);
        credGrid.append(link);
      }
      detailCard.append(credGrid);
    } else {
      const note = el("p", { class: "sm muted" }, "此来源无需登录即可公开浏览。");
      detailCard.append(note);
    }

    // 底部測試操作
    const actions = el("div", { class: "aa-gallery-settings__actions" });
    const statusText = el("span", { class: "aa-gallery-settings__connection-status" });
    const testBtn = el("button", {
      type: "button",
      class: "akey sm",
    }, "测试连接");

    testBtn.onclick = async () => {
      testBtn.disabled = true;
      statusText.className = "aa-gallery-settings__connection-status";
      statusText.textContent = "正在测试连接…";
      const creds = {};
      for (const [k, inp] of Object.entries(sourceInputsMap[cap.source] || {})) {
        if (inp?.value) creds[k] = inp.value;
      }
      try {
        await testSourceConnection(cap.source, creds, statusText);
      } finally {
        testBtn.disabled = false;
      }
    };

    actions.append(testBtn, statusText);
    detailCard.append(actions);
    sourceDetail.append(detailCard);
  };

  caps.forEach((cap) => {
    const authFields = cap.authFields || [];
    const isConfigured = authFields.length > 0 && authFields.every((f) => {
      const statusKey = `has${f[0].toUpperCase()}${f.slice(1)}`;
      return credentialStatus[cap.source]?.[statusKey];
    });
    const stateText = !authFields.length ? "公开访问" : isConfigured ? "已配置" : "未配置";

    const tab = el("button", {
      type: "button",
      class: `aa-gallery-settings__source-tab ${cap.source === currentSettingsSource ? "is-active" : ""}`,
      "data-source": cap.source,
    });
    const nameSpan = el("span", { class: "aa-gallery-settings__source-tab-name" }, `${isConfigured ? "✓ " : authFields.length ? "🔒 " : "🌐 "}${cap.displayName || cap.source}`);
    const stateSpan = el("span", { class: "aa-gallery-settings__source-tab-state" }, stateText);
    tab.append(nameSpan, stateSpan);

    tab.onclick = () => {
      currentSettingsSource = cap.source;
      $$(".aa-gallery-settings__source-tab", sourceList).forEach((t) => {
        t.classList.toggle("is-active", t.getAttribute("data-source") === cap.source);
      });
      renderActiveSourceDetail(cap);
    };

    sourceList.append(tab);
  });

  const activeCap = caps.find((c) => c.source === currentSettingsSource) || caps[0];
  if (activeCap) renderActiveSourceDetail(activeCap);
}

function renderSettingsBrowse(cfg) {
  const defSourceSel = $("#booruSettingDefaultSource");
  if (defSourceSel) {
    const caps = state.sources && state.sources.length ? state.sources : [
      { source: "danbooru", displayName: "Danbooru" },
      { source: "gelbooru", displayName: "Gelbooru" },
      { source: "safebooru", displayName: "Safebooru" },
      { source: "aitag", displayName: "AI TAG" },
    ];
    defSourceSel.innerHTML = "";
    for (const c of caps) {
      defSourceSel.append(el("option", { value: c.source }, c.displayName || c.source));
    }
    defSourceSel.value = cfg?.defaultSource || state.source || "danbooru";
  }

  const tooltipCheck = $("#booruSettingTooltip");
  if (tooltipCheck) {
    tooltipCheck.checked = cfg?.tooltip ?? state.tooltipEnabled ?? true;
  }

  const picker = $("#booruStampPicker");
  if (picker) {
    picker.innerHTML = "";
    for (const style of SELECTION_STAMPS) {
      const opt = el("button", {
        type: "button",
        class: `aa-gallery-settings__stamp-option${style === state.selectionStamp ? " is-active" : ""}`,
        "data-stamp": style,
      });
      const preview = createSelectionStamp(style, { preview: true }).root;
      const label = el("span", null, STAMP_LABELS[style] || style);
      opt.append(preview, label);

      opt.onclick = () => {
        $$(".aa-gallery-settings__stamp-option", picker).forEach((o) => o.classList.remove("is-active"));
        opt.classList.add("is-active");
        setSelectionStamp(style);
        toast(`已选用印章：${STAMP_LABELS[style] || style}`, "info");
      };

      picker.append(opt);
    }
  }
}

function renderSettingsBlacklist(cfg) {
  const blInput = $("#booruBlacklistInput");
  const blCount = $("#booruBlacklistCount");
  if (!blInput) return;

  const currentList = cfg?.blacklist || promptConfig.blacklist || [];
  blInput.value = currentList.join("\n");

  const syncCount = () => {
    const count = parseTagLines(blInput.value).length;
    if (blCount) {
      blCount.textContent = `已屏蔽 ${count} 个标签`;
      blCount.classList.toggle("is-active", count > 0);
    }
  };

  blInput.oninput = syncCount;
  syncCount();
}

function renderSettingsPrompt(cfg) {
  const catCont = $("#booruPromptCategories");
  if (catCont) {
    catCont.innerHTML = "";
    const activeCats = new Set(cfg?.promptDefaults?.categories || promptConfig.categories || ["character", "copyright", "artist", "general"]);

    for (const cat of GALLERY_CATEGORIES) {
      const isSel = activeCats.has(cat);
      const pill = el("button", {
        type: "button",
        class: `aa-category-pill${isSel ? " is-selected" : ""}`,
        "data-cat": cat,
      }, CATEGORY_LABELS[cat] || cat);

      pill.onclick = () => {
        pill.classList.toggle("is-selected");
      };
      catCont.append(pill);
    }
  }

  const underCheck = $("#booruSettingUnderscores");
  if (underCheck) {
    underCheck.checked = !!(cfg?.promptDefaults?.replaceUnderscores ?? promptConfig.replaceUnderscores);
  }

  const parenCheck = $("#booruSettingParentheses");
  if (parenCheck) {
    parenCheck.checked = !!(cfg?.promptDefaults?.escapeParentheses ?? promptConfig.escapeParentheses);
  }

  const filterInput = $("#booruOutputFilterInput");
  const filterCount = $("#booruOutputFilterCount");
  if (filterInput) {
    filterInput.value = (cfg?.outputFilterTags || []).join("\n");
    const syncCount = () => {
      const count = parseTagLines(filterInput.value).length;
      if (filterCount) {
        filterCount.textContent = `输出过滤 ${count} 个标签`;
        filterCount.classList.toggle("is-active", count > 0);
      }
    };
    filterInput.oninput = syncCount;
    syncCount();
  }
}

function renderSettingsStorage(cfg) {
  const timeoutInp = $("#booruSettingTimeout");
  if (timeoutInp) timeoutInp.value = cfg?.timeout || 30;

  const budgetInp = $("#booruSettingBudget");
  if (budgetInp) budgetInp.value = cfg?.cacheBudgetMiB || 1024;

  const clearBtn = $("#booruSettingClearCacheBtn");
  if (clearBtn) clearBtn.onclick = () => clearBooruCache();
}

export async function testSourceConnection(source, creds, statusEl) {
  if (statusEl) {
    statusEl.textContent = "测试连接中...";
    statusEl.className = "aa-gallery-settings__connection-status";
  }
  try {
    const res = await fetch(`${API}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, credentials: creds }),
    });
    const result = await res.json();
    if (res.ok && result?.success !== false) {
      if (statusEl) {
        statusEl.textContent = "✓ 连接成功！";
        statusEl.className = "aa-gallery-settings__connection-status is-success";
      }
      toast(`[${source}] 连接成功！`, "ok");
    } else {
      throw new Error(result?.message || result?.error || "连接未通过");
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = `✕ 失败: ${e.message}`;
      statusEl.className = "aa-gallery-settings__connection-status is-error";
    }
    toast(`[${source}] 测试失败: ${e.message}`, "err");
  }
}

export async function clearBooruCache() {
  toast("正在清理画廊快取...");
  try {
    const res = await fetch(`${API}/cache/clear`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    detailCache.clear();
    toast("✓ 已成功清除本地画廊图片与中继資料快取！", "ok");
  } catch (e) {
    toast(`清除快取失敗: ${e.message}`, "err");
  }
}

export async function saveGallerySettings() {
  const saveBtn = $("#booruSettingsSaveBtn");
  const statusEl = $("#booruSettingsStatus");
  if (saveBtn) saveBtn.disabled = true;
  if (statusEl) statusEl.textContent = "正在保存更改…";

  const defaultSource = $("#booruSettingDefaultSource")?.value || "danbooru";
  const tooltipEnabled = $("#booruSettingTooltip")?.checked ?? true;
  const blacklist = parseTagLines($("#booruBlacklistInput")?.value || "");
  const outputFilterTags = parseTagLines($("#booruOutputFilterInput")?.value || "");

  const categories = [];
  $$(".aa-category-pill.is-selected", $("#booruPromptCategories")).forEach((pill) => {
    const c = pill.getAttribute("data-cat");
    if (c) categories.push(c);
  });

  const replaceUnderscores = $("#booruSettingUnderscores")?.checked ?? false;
  const escapeParentheses = $("#booruSettingParentheses")?.checked ?? false;
  const timeout = Number($("#booruSettingTimeout")?.value || 30);
  const cacheBudgetMiB = Number($("#booruSettingBudget")?.value || 1024);

  // 整理憑證與清除標記
  const credentials = {};
  for (const [source, fields] of Object.entries(sourceInputsMap)) {
    const cred = {};
    for (const [fieldName, inp] of Object.entries(fields)) {
      if (inp?.value?.trim()) cred[fieldName] = inp.value.trim();
    }
    if (Object.keys(cred).length) credentials[source] = cred;
  }

  const clearCredentials = {};
  for (const [source, set] of Object.entries(sourceClearsSet)) {
    if (set && set.size) clearCredentials[source] = [...set];
  }

  const payload = {
    defaultSource,
    blacklist,
    outputFilterTags,
    promptDefaults: {
      categories: categories.length ? categories : ["character", "copyright", "artist", "general"],
      replaceUnderscores,
      escapeParentheses,
    },
    tooltip: tooltipEnabled,
    selectionStamp: state.selectionStamp,
    timeout,
    cacheBudgetMiB,
    credentials,
    clearCredentials,
  };

  try {
    if (typeof fetch === "function") {
      const res = await fetch(`${API}/settings/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }
    }

    // 更新本地狀態與 store
    promptConfig.categories = payload.promptDefaults.categories;
    promptConfig.replaceUnderscores = replaceUnderscores;
    promptConfig.escapeParentheses = escapeParentheses;
    promptConfig.blacklist = blacklist;

    state.source = defaultSource;
    state.tooltipEnabled = tooltipEnabled;

    store.set("booru_source", defaultSource);
    store.set("booru_prompt_config", promptConfig);
    store.set("booru_tooltip_enabled", tooltipEnabled);
    store.set("booru_selection_stamp", state.selectionStamp);

    // 更新畫廊來源下拉選項與印章
    if ($("#booruSource")) $("#booruSource").value = defaultSource;
    setSelectionStamp(state.selectionStamp);

    $("#booruSettingsModal").hidden = true;
    toast("✓ 画廊设置已成功保存！", "ok");
  } catch (e) {
    if (statusEl) statusEl.textContent = `保存失败: ${e.message}`;
    toast(`保存设置失败: ${e.message}`, "err");
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

export function init() {
  if (state.initialized) return;
  state.initialized = true;

  // 載入本地持久化配置
  const savedPromptCfg = store.get("booru_prompt_config");
  if (savedPromptCfg && typeof savedPromptCfg === "object") {
    Object.assign(promptConfig, savedPromptCfg);
  }
  const savedMode = store.get("booru_selection_mode", "single");
  state.selectionMode = savedMode;
  state.tooltipEnabled = store.get("booru_tooltip_enabled", true);

  const savedSource = store.get("booru_source", "danbooru");
  state.source = savedSource;
  if ($("#booruSource")) $("#booruSource").value = savedSource;

  // 來源選擇
  $("#booruSource")?.addEventListener("change", (e) => {
    state.source = e.target.value;
    store.set("booru_source", e.target.value);
    state.page = 1;
    searchPosts();
  });

  // 分級選擇
  $("#booruRating")?.addEventListener("change", (e) => {
    state.rating = e.target.value;
    state.page = 1;
    searchPosts();
  });

  // 排序選擇
  $("#booruSort")?.addEventListener("change", (e) => {
    state.sort = e.target.value;
    state.period = "";
    if ($("#booruRanking")) $("#booruRanking").value = "";
    state.page = 1;
    searchPosts();
  });

  // 排行榜選擇
  $("#booruRanking")?.addEventListener("change", (e) => {
    state.period = e.target.value;
    state.page = 1;
    searchPosts();
  });

  // 隨機抽卡按鈕
  $("#booruRandomBtn")?.addEventListener("click", () => {
    state.random = !state.random;
    $("#booruRandomBtn")?.classList.toggle("on", state.random);
    state.page = 1;
    searchPosts();
    toast(state.random ? "🎲 抽卡模式已開啟" : "🎲 抽卡模式已關閉");
  });

  // 單選 / 多選切換按鈕
  $("#booruModeSingle")?.addEventListener("click", () => setSelectionMode("single"));
  $("#booruModeMulti")?.addEventListener("click", () => setSelectionMode("multi"));

  // 清空選取按鈕
  $("#booruClearSelectionBtn")?.addEventListener("click", () => clearSelection());

  // 提示詞處理按鈕 (打開畫廊設置的提示詞標籤頁)
  $("#booruPromptConfigBtn")?.addEventListener("click", () => openSettingsDialog("prompt"));
  $("#booruPromptSaveBtn")?.addEventListener("click", () => savePromptConfigFromDialog());
  $("#booruPromptResetBtn")?.addEventListener("click", () => {
    promptConfig.categories = ["character", "copyright", "artist", "general"];
    promptConfig.replaceUnderscores = false;
    promptConfig.escapeParentheses = false;
    promptConfig.blacklist = [
      "watermark", "signature", "username", "logo", "web_address",
      "commentary_request", "bad_id", "bad_pixiv_id", "translation_request",
    ];
    openPromptConfigDialog();
    toast("已重設為預設值");
  });

  // 設定按鈕
  $("#booruSettingsBtn")?.addEventListener("click", () => openSettingsDialog());
  $("#booruSettingsSaveBtn")?.addEventListener("click", () => saveGallerySettings());
  $("#danbooruTestBtn")?.addEventListener("click", () => {
    const username = $("#danbooruUsername")?.value?.trim();
    const apiKey = $("#danbooruApiKey")?.value?.trim();
    testSourceConnection("danbooru", { username, apiKey }, $("#danbooruAccountStatus"));
  });
  $("#gelbooruTestBtn")?.addEventListener("click", () => {
    const userId = $("#gelbooruUserId")?.value?.trim();
    const apiKey = $("#gelbooruApiKey")?.value?.trim();
    testSourceConnection("gelbooru", { userId, apiKey }, $("#gelbooruAccountStatus"));
  });
  $("#booruClearCacheBtn")?.addEventListener("click", () => clearBooruCache());

  // 搜尋列
  $("#booruSearchBtn")?.addEventListener("click", () => {
    state.query = $("#booruQuery")?.value?.trim() || "";
    state.page = 1;
    searchPosts();
  });
  $("#booruQuery")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      state.query = $("#booruQuery")?.value?.trim() || "";
      state.page = 1;
      searchPosts();
    }
  });

  // 分頁
  $("#booruPrevPage")?.addEventListener("click", () => {
    if (state.page > 1) {
      state.page--;
      searchPosts();
    }
  });
  $("#booruNextPage")?.addEventListener("click", () => {
    state.page++;
    searchPosts();
  });

  // 滾動時自動收起懸浮預覽
  $("#booruGrid")?.addEventListener("scroll", () => {
    hideHoverTooltip();
  }, { passive: true });

  // 詳情彈窗按鈕
  $("#booruSetInitBtn")?.addEventListener("click", () => {
    if (state.selectedPost) setPostAsInput(state.selectedPost);
  });
  $("#booruAddRefBtn")?.addEventListener("click", () => {
    if (state.selectedPost) addPostAsRef(state.selectedPost);
  });
  $("#booruAllTagsBtn")?.addEventListener("click", () => {
    insertAllTags(state.activeDetail || state.selectedPost);
  });
  $("#booruDownloadBtn")?.addEventListener("click", () => {
    const d = state.activeDetail || state.selectedPost;
    const url = d?.mediaUrl || d?.sampleUrl;
    if (url) window.open(url, "_blank");
  });

  // 面板控制（自由拉伸、最大化、關閉）
  initSplitter();

  $("#booruPanelClose")?.addEventListener("click", () => {
    hideHoverTooltip();
    setMode("txt2img");
  });

  $("#booruPanelExpand")?.addEventListener("click", () => {
    const panel = $("#booruPanel");
    if (!panel) return;
    panel.classList.toggle("maximized");
    const isMax = panel.classList.contains("maximized");
    const btn = $("#booruPanelExpand");
    if (btn) {
      btn.textContent = isMax ? "⧉" : "⛶";
      btn.title = isMax ? "還原視窗" : "最大化畫廊";
    }
  });

  updateSelectionUI();
  fetchSources();
}

export function initSplitter() {
  const splitter = $("#booruSplitter");
  const panel = $("#booruPanel");
  const stage = $("#dockMainStage");
  if (!splitter || !panel) return;

  const savedW = store.get("booru_width", 500);
  if (savedW) {
    document.documentElement.style.setProperty("--booru-w", `${savedW}px`);
  }

  let startX = 0;
  let startW = 0;
  let dragging = false;

  const onPointerMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const stageW = stage ? stage.clientWidth : window.innerWidth;
    const minW = 280;
    const maxW = Math.max(minW, stageW - 200);
    const newW = Math.min(maxW, Math.max(minW, startW + dx));
    document.documentElement.style.setProperty("--booru-w", `${Math.round(newW)}px`);
    store.set("booru_width", Math.round(newW));
    scheduleMasonryReflow();
  };

  const onPointerUp = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
    scheduleMasonryReflow();
  };

  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = panel.getBoundingClientRect().width;
    dragging = true;
    splitter.classList.add("dragging");
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  });

  // 雙擊重設預設寬度
  splitter.addEventListener("dblclick", () => {
    document.documentElement.style.setProperty("--booru-w", "500px");
    store.set("booru_width", 500);
    scheduleMasonryReflow();
  });
}

// 當使用者切換到畫廊模式時呼叫
export function onModeActive() {
  if (!state.initialized) init();
  const bp = $("#booruPanel");
  const bs = $("#booruSplitter");
  if (bp) bp.hidden = false;
  if (bs) bs.hidden = false;
  if (!state.posts.length && !state.loading) {
    searchPosts();
  }
}
