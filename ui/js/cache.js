import { $, api, el, fmtBytes } from "./util.js";

let snapshot = null, working = false;
function controls() {
  $("#cacheScan").disabled = working;
  $("#cacheClear").disabled = working || !snapshot || snapshot.cleaning || !snapshot.bytes;
}
async function scan() {
  if (working) return;
  working = true; controls();
  $("#cacheSummary").textContent = "正在計算快取大小…";
  try {
    snapshot = await api("/api/cache");
    $("#cacheSummary").textContent = `可清理快取：${fmtBytes(snapshot.bytes)}`;
    $("#cacheGroups").replaceChildren(...snapshot.groups.map(g => el("div", {class:"row gap sm"},
      el("span", {class:"grow"}, g.label), el("span", {}, fmtBytes(g.bytes)))));
  } catch (e) {
    snapshot = null;
    $("#cacheSummary").textContent = "無法讀取快取大小：" + e.message;
  } finally { working = false; controls(); }
}
async function clear() {
  if (working || !snapshot || snapshot.cleaning || !snapshot.bytes) return;
  if (!confirm(`清理 ${fmtBytes(snapshot.bytes)} 的可重建快取？未完成的安裝下載需要重新下載，縮圖會在瀏覽時重建。`)) return;
  working = true; controls();
  $("#cacheResult").textContent = "正在清理快取…";
  try {
    const result = await api("/api/cache/clear", {json:{confirm:true}, timeout:0});
    $("#cacheResult").textContent = `已釋放 ${fmtBytes(result.freed_bytes)}；略過 ${result.skipped} 個無法清理的項目。`
      + (result.warnings?.length ? " " + result.warnings.join("；") : "");
  } catch (e) {
    $("#cacheResult").textContent = "清理未完成：" + e.message;
  } finally { working = false; await scan(); }
}
export function init() {
  if (!$("#cacheScan")) return;
  $("#cacheScan").onclick = scan;
  $("#cacheClear").onclick = clear;
}
