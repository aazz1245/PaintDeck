// 本體更新。Release 說明只當文字顯示，不執行遠端 HTML。
import { $, api, toast, openModal } from "./util.js";

let state = null, timer = null;
const F = (id) => $("#" + id);

export function displayVersion(version) {
  const p = String(version || "1.1").split(".").map(Number);
  if (p.length === 3 && p[0] >= 24) {
    const month = p[1] >= 101 ? Math.floor(p[1] / 100) : p[1];
    const day = p[1] >= 101 ? p[1] % 100 : p[2];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return `V${p[0]}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
  }
  return "V" + String(version || "1.1").split(".").slice(0, 2).join(".");
}

export function canInstall(s) {
  return !!s?.enabled && s.channel === "public" && !!s.update && !s.busy_reason
    && !["checking", "downloading", "installing"].includes(s.phase);
}

function paint(s) {
  state = s;
  F("updateVersion").textContent = s.current_version;
  F("updateAuto").checked = s.enabled && s.auto_check;
  F("updateAuto").disabled = !s.enabled;
  F("updateCheck").disabled = !s.enabled || ["checking", "downloading", "installing"].includes(s.phase);
  const privateBuild = s.channel !== "public";
  F("updateHint").textContent = privateBuild ? "私人版維持手動更新，請使用私人安裝檔。"
    : !s.enabled ? "請用桌面版檢查更新。"
    : s.phase === "offline" ? "暫時連不到 GitHub，稍後可再檢查。"
    : s.phase === "checking" ? "正在檢查更新…"
    : s.phase === "current" ? "目前已是最新版。"
    : s.update ? "有新版可用，查看更新說明後再決定是否安裝。" : "開啟程式時會在背景檢查，每 12 小時再檢查一次。";
  F("updateDetails").hidden = !s.update || privateBuild;
  F("updateNotice").hidden = !s.update || privateBuild;
  if (s.update) {
    F("updateNotice").textContent = `有新版 ${s.update.version}`;
    F("updateTarget").textContent = s.update.version;
    F("updateNotes").textContent = s.update.notes || "此版本未提供更新說明。";
  }
  F("updateReason").textContent = s.busy_reason || "安裝會關閉程式，完成後重新開啟。";
  F("updateInstall").disabled = !canInstall(s);
  F("updateProgress").textContent = s.phase === "installing" ? "正在安裝，完成後會重新開啟…"
    : s.phase === "downloading" ? `下載更新：${Math.round(s.done / 1048576)} / ${s.total ? Math.round(s.total / 1048576) : "?"} MB` : "";
}

async function refresh() {
  try { paint(await api("/api/app/update")); } catch { /* 離線或更新重開時保持安靜 */ }
}

async function check() {
  F("updateCheck").disabled = true;
  try { paint(await api("/api/app/update/check", { json: {}, timeout: 30000 })); }
  catch {
    if (state) paint(state);
    F("updateHint").textContent = "暫時連不到 GitHub，稍後可再檢查。";
  }
}

function details() { openModal("#updateModal"); refresh(); }

export function init() {
  if (!F("updateCheck")) return;
  F("updateCheck").onclick = check;
  F("updateDetails").onclick = details;
  F("updateNotice").onclick = details;
  F("updateAuto").onchange = async () => {
    try { paint(await api("/api/app/update/preferences", { json: { auto_check: F("updateAuto").checked } })); }
    catch (e) { if (state) paint(state); toast(e.message, "err"); }
  };
  F("updateInstall").onclick = async () => {
    if (!canInstall(state)) return;
    const version = state.update.version;
    if (!confirm(`下載並安裝 ${version}？完成後會重新開啟程式。`)) return;
    F("updateInstall").disabled = true;
    try {
      await api("/api/app/update/install", { json: { version, confirm: true }, timeout: 0 });
    } catch (e) {
      if (state?.phase !== "installing") toast(e.message, "err");
    } finally { refresh(); }
  };
  refresh();
  if (!timer) timer = setInterval(refresh, 5000);
}
