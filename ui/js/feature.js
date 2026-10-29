// 外掛功能：目前是「一鍵脫衣」的內容補丁。偵測裝了沒，裝了就填 UI 文案、顯示入口；沒裝就把入口全藏起來。
// 露骨提示詞和這些文案都在外部補丁檔（<資料>\plugins\strip\pack.json），公開版原始碼不含。
import { $, api, modeName } from "./util.js";

let stripUi = null;
export const stripOn = () => !!stripUi;

export async function initFeatures() {
  try {
    const r = await api("/api/features/strip");
    applyStrip(r.enabled ? r.ui : null);
  } catch {
    applyStrip(null);
  }
}

export function applyStrip(u) {
  stripUi = u;
  const on = !!u;
  for (const b of document.querySelectorAll('[data-mode="strip"]')) {
    b.hidden = !on;
    if (on) { b.textContent = u.button; b.title = u.button_title || ""; }
  }
  for (const b of document.querySelectorAll('[data-act="strip"]')) {
    b.hidden = !on;
    if (on) { b.textContent = u.button; b.title = u.send_title || ""; }
  }
  modeName.strip = on ? u.button : "改圖";
  if (!on) return;
  const t = (id, v) => { const e = $(id); if (e && v != null) e.textContent = v; };
  const ph = (id, v) => { const e = $(id); if (e && v != null) e.placeholder = v; };
  const opt = (id, val, v) => {
    const sel = $(id);
    const o = sel && [...sel.options].find((o) => o.value === val);
    if (o && v != null) o.textContent = v;
  };
  t("#stripLbl", u.label);
  t("#stripTargetLbl", u.target_label);
  t("#stripKeepLbl", u.keep_label);
  opt("#stripTarget", "female", u.targets?.female);
  opt("#stripTarget", "male", u.targets?.male);
  opt("#stripKeep", "all", u.keeps?.all);
  opt("#stripKeep", "shoes", u.keeps?.shoes);
  opt("#stripKeep", "underwear", u.keeps?.underwear);
  t("#stripRefineLbl", u.refine_label);
  t("#stripDenoiseLbl", u.denoise_label);
  t("#stripMergeLbl", u.merge_label);
  t("#stripTagsLbl", u.tags_label);
  t("#stripExtraLbl", u.extra_label);
  t("#stripNote", u.note);
  ph("#stripTags", u.tags_ph);
  ph("#stripExtra", u.extra_ph);
}
