// 繪匣原生外掛 UI 宿主橋接：模擬 ComfyUI scripts/api.js
function normalizeUrl(path) {
  const s = String(path || "");
  if (/^https?:\/\//i.test(s)) return s;
  return s.startsWith("/") ? s : "/" + s;
}

export const api = {
  apiURL(path) {
    return normalizeUrl(path);
  },
  async fetchApi(path, options) {
    const url = normalizeUrl(path);
    const resp = await window.fetch(url, options);
    try {
      const isWardrobeRoll = url.includes("/anima-wardrobe-v6/roll");
      const isK2Build = url.includes("/k2ed/build");
      if (resp.ok && (isWardrobeRoll || isK2Build)) {
        resp.clone().json().then((data) => {
          if (data && typeof data.text === "string" && data.text.trim()) {
            window.__pdOnPluginPrompt?.(data.text, isK2Build ? "krea2" : "anima", data);
          }
        }).catch(() => {});
      }
    } catch { /* ignore clone/parse errors */ }
    return resp;
  },
};

window.__pdComfyApi = api;
