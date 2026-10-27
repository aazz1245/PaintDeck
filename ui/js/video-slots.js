// Named media inputs for imported video workflows. Values are ComfyUI input basenames.
import { el, uploadFile, pickFile, toast } from "./util.js";

export const MEDIA_ROLES = { first: "首幀", last: "尾幀", character: "角色", scene: "場景", motion: "動作參考", voice: "聲音參考", reference: "一般參考" };
const EXTENSIONS = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif"],
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi"],
  audio: ["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac"],
};

export function mediaSlots(engine) {
  const slots = engine?.media_slots ?? engine?.info?.media_slots ?? [];
  if (!Array.isArray(slots)) return [];
  return slots.filter((s) => s && typeof s.key === "string" && EXTENSIONS[s.kind]).map((s) => ({ ...s }));
}

export function mediaBasename(value, kind) {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 240 || value.startsWith(".")
      || value.includes("..") || /[\x00-\x1f\x7f/\\:<>"|?*]/.test(value)) return false;
  return !!EXTENSIONS[kind]?.includes(value.split(".").pop().toLowerCase());
}

export function mediaSlotParams(slots, values = {}) {
  const result = {}, keys = new Set(), targets = new Set();
  for (const slot of slots) {
    const target = `${slot.node}.${slot.input}`;
    if (keys.has(slot.key) || targets.has(target)) throw new Error("素材槽代號或工作流欄位重複，請先修改「對應與參數」");
    keys.add(slot.key); targets.add(target);
    const value = values[slot.key];
    if (value === "" || value === undefined || value === null) continue;
    if (!mediaBasename(value, slot.kind)) throw new Error(`「${slot.label || slot.key}」要填已上傳的 ${slot.kind} 檔名，不能填路徑或網址`);
    result[slot.key] = value;
  }
  return result;
}

/** Each row owns its upload. A late result never changes another workflow or reopened dialog. */
export function mediaSlotsControl({ engine, values = {}, onchange = () => {}, isCurrent = () => true }) {
  const slots = mediaSlots(engine), chosen = { ...values };
  let pending = 0;
  const body = el("div", { class: "vm-sec", hidden: !slots.length },
    el("b", {}, "本次影片素材"),
    el("div", { class: "muted sm" }, "各槽分別選檔，或填已上傳的檔名。留空沿用工作流；首幀留空使用目前這張圖。用途與角色可在「設定 → 影片模型 → 對應與參數」修改。"));
  for (const slot of slots) {
    const ctl = el("input", { type: "text", value: chosen[slot.key] || "", spellcheck: "false", placeholder: "已上傳檔名（可留空）", "aria-label": slot.label || slot.key });
    const note = el("span", { class: "muted sm" });
    ctl.onchange = () => { chosen[slot.key] = ctl.value.trim(); onchange({ ...chosen }); };
    const pick = el("button", { type: "button", class: "btn sm" }, "選檔上傳…");
    pick.onclick = async () => {
      if (pending) return toast("請等目前素材上傳完成", "err");
      const file = await pickFile(EXTENSIONS[slot.kind].map((ext) => "." + ext).join(","));
      if (!file || !isCurrent()) return;
      pending++; pick.disabled = true; note.textContent = "上傳中…";
      try {
        const result = await uploadFile(file, slot.kind);
        if (!isCurrent()) return;
        if (!mediaBasename(result.name, slot.kind)) throw new Error("上傳沒有回傳可用的素材檔名");
        chosen[slot.key] = result.name; ctl.value = result.name; note.textContent = "已上傳"; onchange({ ...chosen });
      } catch (error) { if (isCurrent()) { note.textContent = "上傳失敗"; toast(error.message, "err"); } }
      finally { pending--; pick.disabled = false; }
    };
    const clear = el("button", { type: "button", class: "link", onclick: () => { chosen[slot.key] = ""; ctl.value = ""; onchange({ ...chosen }); } }, "沿用");
    body.append(el("div", { class: "wf-f full" },
      el("label", { class: "sub", title: `#${slot.node} · ${slot.input}` }, `${slot.label || slot.key} · ${MEDIA_ROLES[slot.role] || slot.kind}${slot.who ? " · " + slot.who : ""}`),
      el("div", { class: "row" }, ctl, pick, clear), note));
  }
  return { element: body, read() { if (pending) throw new Error("素材仍在上傳，請等上傳完成再生成"); return mediaSlotParams(slots, chosen); } };
}
