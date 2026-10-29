// Booru 畫廊：整合 ComfyUI-Aaalice-Nodes 的 BooruGalleryNode 服務
// 支援 Danbooru / Gelbooru / Safebooru / AI TAG 瀑布流檢索、抽卡、標籤提取與圖生圖聯動

import { $, $$, el, toast, uploadFile } from "./util.js";
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
  const res = await fetch(`${API}/detail?source=${encodeURIComponent(source)}&postId=${encodeURIComponent(postId)}`);
  if (!res.ok) throw new Error("獲取詳情失敗");
  return res.json();
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

function ratingBadge(rating) {
  const r = String(rating || "").toLowerCase();
  if (r === "g" || r === "general" || r === "safe") return { text: "SFW", cls: "sfw" };
  if (r === "s" || r === "sensitive") return { text: "Sens", cls: "sens" };
  if (r === "q" || r === "questionable") return { text: "R15", cls: "quest" };
  if (r === "e" || r === "explicit") return { text: "R18", cls: "nsfw" };
  return { text: r || "—", cls: "unknown" };
}

function renderGrid() {
  const grid = $("#booruGrid");
  if (!grid) return;
  grid.innerHTML = "";

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

    // Badges
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

    // Quick hover actions
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
    hoverBar.append(initBtn);
    imgWrap.append(hoverBar);

    card.append(imgWrap);

    // Card click -> View full detail modal
    card.onclick = () => openDetailModal(post);

    grid.append(card);
  }
}

export async function openDetailModal(post) {
  state.selectedPost = post;
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
        title: `點選插入提示詞: ${tag}`,
      }, tag);
      pill.onclick = () => {
        appendPrompt(tag);
        toast(`已填入: ${tag}`);
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

// 全部標籤填入提示詞
export function insertAllTags(detail) {
  const d = detail || state.activeDetail || state.selectedPost;
  if (!d || !d.tags) return toast("尚未取得標籤", "warn");
  const tags = [
    ...(d.tags.character || []),
    ...(d.tags.copyright || []),
    ...(d.tags.general || []),
  ].filter((t) => !["watermark", "signature", "username", "logo"].includes(t));

  if (!tags.length) return toast("沒有可用標籤", "warn");
  appendPrompt(tags.join(", "));
  toast(`已將 ${tags.length} 個標籤填入提示詞`, "ok");
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

  // 大視圖展開
  $("#booruExpandBtn")?.addEventListener("click", () => {
    const box = $("#booruBox");
    if (!box) return;
    box.classList.toggle("booru-expanded");
    $("#booruExpandBtn").textContent = box.classList.contains("booru-expanded") ? "✕" : "⛶";
  });

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

  fetchSources();
}

// 當使用者切換到畫廊模式時呼叫
export function onModeActive() {
  if (!state.initialized) init();
  if (!state.posts.length && !state.loading) {
    searchPosts();
  }
}
