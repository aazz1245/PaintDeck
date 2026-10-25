// 安裝精靈的選擇規則；有多份資料時不以圖庫大小替使用者決定。
export const cleanPath = value => String(value || "").trim().replace(/^"(.*)"$/, "$1").trim();
export const samePath = (a, b) => cleanPath(a).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
  cleanPath(b).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function reuseDefaults(scan) {
  const current = scan.current;
  const legacy = scan.installations?.some(x => x.legacy);
  const existing = !!current || scan.data.length > 0 || legacy;
  const selected = current?.data_root || (scan.data.length === 1 && scan.data[0].valid ? scan.data[0].path : scan.data.length ? "" : legacy ? "manual" : "new");
  const sibling = scan.data.find(d => samePath(d.path, selected))?.comfy;
  const comfy = current?.comfy_dir || sibling || (scan.comfy.length === 1 ? scan.comfy[0].path : scan.comfy.length || existing ? "manual" : "new");
  return { data: selected, comfy };
}

export function locationRequest(pick) {
  return {
    data_root: cleanPath(pick.data === "new" ? pick.dataNew : pick.data === "manual" ? pick.dataManual : pick.data),
    data_mode: pick.data === "new" ? "new" : "reuse",
    comfy_dir: cleanPath(pick.comfy === "new" ? pick.comfyNew : pick.comfy === "manual" ? pick.comfyManual : pick.comfy),
  };
}
