// 使用者主動挑選指定鏡頭的接續畫面；選幀與上一鏡裁切出點一起保存。
import { api, el, toast } from "./util.js";

export async function pickTail({ id, seg, onDone }) {
  let data;
  try { data = await api("/api/director/tail/candidates", { json: { id, seg } }); }
  catch (e) { toast(e.message, "err"); return; }
  const modal = el("dialog", { class: "modal video-review" });
  const grid = el("div", { class: "video-review-grid" });
  const note = el("div", { class: "muted sm", role: "status" }, "選較早的畫面時，合片會一起裁掉後面的片尾，避免動作倒退。確認後需重新拍攝依賴這一鏡的後續鏡頭，舊版本會保留。");
  let pending = false;
  for (const c of data.candidates || []) {
    const button = el("button", { type: "button", class: "video-review-frame akey", onclick: async () => {
      if (pending) return;
      pending = true;
      for (const b of grid.querySelectorAll("button")) b.disabled = true;
      try {
        const p = await api("/api/director/tail/select", { json: { id, seg, video_id: data.video_id, frame: c.frame, expected_take: data.selected_take } });
        modal.close();
        await onDone?.(p);
      } catch (e) { toast(e.message, "err"); pending = false; for (const b of grid.querySelectorAll("button")) b.disabled = false; }
    } }, el("img", { src: c.url, alt: `第 ${c.frame + 1} 格`, loading: "lazy" }),
      el("span", {}, `${Number(c.time).toFixed(3)} 秒${c.last ? "（最後一格）" : ""}`));
    grid.append(button);
  }
  modal.append(el("div", { class: "row gap" }, el("b", {}, "選接續畫面"), el("span", { class: "grow" }),
    el("button", { type: "button", class: "akey sm", onclick: () => modal.close() }, "關閉")), note, grid);
  modal.addEventListener("close", () => modal.remove(), { once: true });
  document.body.append(modal);
  modal.showModal();
}
