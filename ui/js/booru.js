// Booru 畫廊：整合 ComfyUI-Aaalice-Nodes 的 BooruGalleryNode 服務
// 支援 Danbooru / Gelbooru / Safebooru / AI TAG 瀑布流檢索、抽卡、標籤提取與圖生圖聯動
// 支援懸浮預覽大圖與提示詞，點擊圖片直接加入「主體提示詞框」

import { $, $$, el, toast, uploadFile, store } from "./util.js";
import { appendPrompt, setInit, setMode, refs, S } from "./gen.js";

const COMFY_URL = "http://127.0.0.1:8188";
const API = `${COMFY_URL}/aaalice/booru-gallery`;

export const state = {
  source: "safebooru",
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
};

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
  const cur = sel.value || state.source;
  sel.innerHTML = "";
  for (const s of state.sources) {
    const opt = el("option", { value: s.source }, `${s.displayName || s.source}`);
    sel.append(opt);
  }
  if (state.sources.some((s) => s.source === cur)) {
    sel.value = cur;
    state.source = cur;
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

// 從 detail 物件中提取提示詞標籤，排除噪音與無關標籤
export function extractPromptTags(detail) {
  if (!detail || !detail.tags) return [];
  const groups = detail.tags;
  const character = groups.character || [];
  const copyright = groups.copyright || [];
  const artist = groups.artist || [];
  const general = groups.general || [];

  const exclude = new Set([
    "watermark", "signature", "username", "logo", "web_address",
    "commentary_request", "bad_id", "bad_pixiv_id", "translation_request",
  ]);

  const all = [...character, ...copyright, ...artist, ...general]
    .map((t) => String(t || "").trim())
    .filter((t) => Boolean(t) && !exclude.has(t.toLowerCase()));

  return [...new Set(all)];
}

// 點選圖片直接將提示詞填入「主體提示詞框」
export async function addPostPromptToMain(post, card = null) {
  if (card) {
    card.classList.add("prompt-added");
    setTimeout(() => card.classList.remove("prompt-added"), 600);
  }

  let detail = null;
  const key = `${post.source}:${post.postId}`;
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

  const tags = extractPromptTags(detail);
  if (!tags.length) {
    return toast("該圖片未包含可用標籤", "warn");
  }

  const promptText = tags.join(", ");
  const mainPromptEl = $("#prompt");
  appendPrompt(promptText, mainPromptEl);
  toast(`已將 ${tags.length} 個標籤加入主體提示詞框`, "ok");
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

  // 頂部大圖預覽
  const mediaWrap = el("div", { class: "booru-hover-media" });
  const hoverImg = el("img", { class: "booru-hover-img", alt: "" });
  const badgeBar = el("div", { class: "booru-hover-badges" });
  const badgeRating = el("span", { class: "booru-tag-badge", id: "booruHoverRating" }, "SFW");
  const badgeDim = el("span", { class: "booru-tag-badge dim", id: "booruHoverDim" }, "");
  const badgeScore = el("span", { class: "booru-tag-badge score", id: "booruHoverScore" }, "");
  badgeBar.append(badgeRating, badgeDim, badgeScore);
  mediaWrap.append(hoverImg, badgeBar);

  // 內容區
  const body = el("div", { class: "booru-hover-content" });

  const head = el("div", { class: "booru-hover-head" });
  const title = el("span", { class: "booru-hover-title", id: "booruHoverTitle" }, "");
  const detailBtn = el("button", {
    class: "booru-hover-detail-btn",
    type: "button",
    title: "查看完整資訊與全部標籤分類",
  }, "🔍 完整詳情");
  head.append(title, detailBtn);

  // 分類標籤（角色、作品、畫師）
  const tagsWrap = el("div", { class: "booru-hover-tags", id: "booruHoverTags" });

  // 提示詞文字預覽框
  const promptWrap = el("div", { class: "booru-hover-prompt-wrap" });
  const promptLbl = el("span", { class: "booru-hover-prompt-lbl", id: "booruHoverPromptLbl" }, "提示詞預覽 (PROMPT)");
  const promptBox = el("div", { class: "booru-hover-prompt-box", id: "booruHoverPromptBox" });
  promptWrap.append(promptLbl, promptBox);

  // 底部提示與操作列
  const hint = el("div", { class: "booru-hover-hint" }, "💡 點選圖片直接填入「主體提示詞框」");
  const actions = el("div", { class: "booru-hover-actions" });
  const initBtn = el("button", { class: "booru-hover-btn go", type: "button" }, "🖼️ 設為輸入圖");
  const copyBtn = el("button", { class: "booru-hover-btn", type: "button" }, "📋 複製提示詞");
  actions.append(initBtn, copyBtn);

  body.append(head, tagsWrap, promptWrap, hint, actions);
  tip.append(mediaWrap, body);

  // 懸浮保持事件
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
  const tipWidth = 330;
  const tipHeight = tipEl.offsetHeight || 400;

  let left;
  // 優先顯示於卡片右側
  if (cardRect.right + tipWidth + 16 <= window.innerWidth) {
    left = cardRect.right + 10;
  } else if (cardRect.left - tipWidth - 10 >= 0) {
    // 右側空間不足則顯示於卡片左側
    left = cardRect.left - tipWidth - 10;
  } else {
    // 兩側均不足時置中限制
    left = Math.max(10, Math.min(window.innerWidth - tipWidth - 10, cardRect.left));
  }

  // 垂直位置對齊卡片頂部，並限制於視窗內
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
  cancelHideHoverTooltip();
  if (hoverTimer) clearTimeout(hoverTimer);

  hoverTimer = setTimeout(async () => {
    currentHoverPost = post;
    const tip = ensureHoverTooltip();
    tip.hidden = false;

    // 圖片預覽：先顯示縮略圖，後台加載高清 sample 圖升級
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

    // 標題與數值
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

    // 標籤與提示詞框重設
    const tagsCont = tip.querySelector("#booruHoverTags");
    const promptBox = tip.querySelector("#booruHoverPromptBox");
    const promptLbl = tip.querySelector("#booruHoverPromptLbl");

    // 初始位置定位
    positionHoverTooltip(cardEl, tip);

    // 取得或讀取詳情快取
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

    // 渲染高頻分類標籤 (角色/作品/畫師)
    renderHoverTags(tagsCont, detail);

    // 渲染提示詞純文字預覽
    const promptTags = extractPromptTags(detail);
    if (promptTags.length) {
      promptLbl.textContent = `提示詞預覽 (${promptTags.length} 個標籤)`;
      promptBox.textContent = promptTags.join(", ");
    } else {
      promptLbl.textContent = "提示詞預覽";
      promptBox.textContent = "未檢測到標籤";
    }

    // 內容膨脹後更新貼齊位置
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

/* ================= 瀑布流卡片列表渲染 ================= */
function renderGrid() {
  const grid = $("#booruGrid");
  if (!grid) return;
  grid.innerHTML = "";
  hideHoverTooltip();

  if (!state.posts.length) {
    grid.innerHTML = '<div class="booru-empty-msg">查無相關圖片，請嘗試變更搜尋標籤或篩選條件</div>';
    return;
  }

  for (const post of state.posts) {
    const card = el("div", {
      class: "booru-card",
      "data-id": post.postId,
      "data-source": post.source,
    });

    const imgWrap = el("div", { class: "booru-img-wrap" });
    const img = el("img", {
      loading: "lazy",
      alt: post.postId,
      src: mediaUrl(post.source, post.previewUrl || post.sampleUrl),
    });
    img.onerror = () => {
      img.alt = "載入失敗";
      img.style.opacity = "0.4";
    };
    imgWrap.append(img);

    // Badges 標籤 (分級、解析度、評分)
    const badgeBar = el("div", { class: "booru-badge-bar" });
    const rb = ratingBadge(post.rating);
    badgeBar.append(el("span", { class: `booru-tag-badge ${rb.cls}` }, rb.text));
    if (post.width && post.height) {
      badgeBar.append(el("span", { class: "booru-tag-badge dim" }, `${post.width}×${post.height}`));
    }
    if (post.score) {
      badgeBar.append(el("span", { class: "booru-tag-badge score" }, `★${post.score}`));
    }
    imgWrap.append(badgeBar);

    // 快捷懸浮操作列
    const hoverBar = el("div", { class: "booru-hover-bar" });
    const initBtn = el("button", {
      class: "booru-quick-btn",
      type: "button",
      title: "設為輸入圖（圖生圖）",
    }, "🖼️ 輸入圖");
    initBtn.onclick = (e) => {
      e.stopPropagation();
      setPostAsInput(post);
    };

    const detailBtn = el("button", {
      class: "booru-quick-btn",
      type: "button",
      title: "查看詳細資訊與所有分類標籤",
    }, "🔍 詳情");
    detailBtn.onclick = (e) => {
      e.stopPropagation();
      openDetailModal(post);
    };

    hoverBar.append(initBtn, detailBtn);
    imgWrap.append(hoverBar);
    card.append(imgWrap);

    // 懸浮預覽圖片與提示詞
    card.addEventListener("mouseenter", () => showHoverTooltip(post, card));
    card.addEventListener("mouseleave", () => scheduleHideHoverTooltip());

    // 點擊卡片：直接將提示詞加入「主體提示詞框」
    card.onclick = async (e) => {
      if (e.target.closest(".booru-quick-btn")) return;
      await addPostPromptToMain(post, card);
    };

    // 雙擊開啟完整詳情彈窗
    card.ondblclick = () => openDetailModal(post);

    grid.append(card);
  }
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
  const tags = extractPromptTags(d);

  if (!tags.length) return toast("沒有可用標籤", "warn");
  appendPrompt(tags.join(", "), $("#prompt"));
  toast(`已將 ${tags.length} 個標籤加入主體提示詞框`, "ok");
}

export function init() {
  if (state.initialized) return;
  state.initialized = true;

  // 來源選擇
  $("#booruSource")?.addEventListener("change", (e) => {
    state.source = e.target.value;
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
  };

  const onPointerUp = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
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
