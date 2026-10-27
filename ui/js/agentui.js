// 生圖助手「讓我看」（2026-10-27）：助手用工具做事時，伺服器送 {type:"agent_ui", op:"goto"|"show", page, tool, params?, ids?}，
// 主視窗切到那一頁、把實際送出的生成參數填進生成頁、把頁籤和生成鍵框起來閃一下，看得到它在做什麼。
// 真的去做的是伺服器（同一套 API），這裡只負責讓你看見；助手視窗（?solo=agent）自己不處理。
import { $ } from "./util.js";
import { app } from "./state.js";
import * as gen from "./gen.js";

// 跟 src-tauri/src/agent_tools.rs 的 PAGES 一樣
export const PAGES = ["gen", "gallery", "assets", "loras", "civitai", "director", "comic", "settings"];

/** 伺服器送來的訊息 → 要切到哪一頁（不認得的一律不動） */
export function uiTarget(m) {
  return m && typeof m.page === "string" && PAGES.includes(m.page) ? m.page : null;
}

/** 這次要不要把參數填進生成頁：做完（show）、在生成頁、有參數物件 */
export function shouldFill(m) {
  return m?.op === "show" && uiTarget(m) === "gen" && !!m.params && typeof m.params === "object" && !Array.isArray(m.params);
}

function flash(node) {
  if (!node) return;
  node.classList.remove("ag-flash");
  void node.offsetWidth; // 重新觸發動畫
  node.classList.add("ag-flash");
  setTimeout(() => node.classList.remove("ag-flash"), 1300);
}

/** 只寫詞的「填入生成頁」：只填提示詞、負面詞、尺寸（空的不動），其他設定（模型、LoRA、模式）保持原樣 */
export function fillValues(f) {
  if (!f || typeof f !== "object") return [];
  const out = [];
  for (const k of ["prompt", "negative", "width", "height"]) {
    const v = f[k];
    if (v === undefined || v === null || v === "") continue;
    if ((k === "width" || k === "height") && !(Number.isFinite(+v) && +v >= 64)) continue;
    out.push([k, String(v)]);
  }
  return out;
}

export function onAgentUi(m) {
  if (document.documentElement.classList.contains("solo")) return;
  const page = uiTarget(m);
  if (!page) return;
  app.showPage?.(page);
  flash($(`#tabs button[data-page="${page}"]`));
  if (m.op === "fill" && page === "gen") {
    for (const [k, v] of fillValues(m.fill)) {
      const node = document.getElementById(k);
      if (!node) continue;
      node.value = v;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
    flash(document.getElementById("prompt"));
    return;
  }
  if (shouldFill(m)) {
    try {
      gen.applyParams(m.params);
      flash($("#genBtn"));
    } catch (e) {
      console.warn("讓我看：填不進生成頁", e);
    }
  }
}
