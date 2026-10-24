// 網路：代理（梯子）和下載來源。設定頁「網路」和安裝精靈第一頁共用；後端 net.rs、setup.rs 的 /api/setup/net*
import { api as baseApi } from "./util.js";

// /api/setup/* 要帶這個標頭（後端用來擋別的網站送來的請求）
const api = (path, opts = {}) => baseApi(path, { ...opts, headers: { ...(opts.headers || {}), "X-Anima-Setup": "1" } });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** 在 box 裡畫出網路設定；autoTest＝一打開就測一次連線（精靈用） */
export async function mountNet(box, { autoTest = false } = {}) {
  box.innerHTML = `
    <div class="net-now"><span class="muted sm">目前：</span><span id="netNow" class="sm">讀取中…</span></div>
    <div class="grid2">
      <div><span class="sub">代理（梯子）</span><select id="netProxy">
        <option value="auto">自動：跟著系統代理、PAC、環境變數（建議）</option>
        <option value="off">不用代理（一律直連）</option>
        <option value="manual">手動填代理</option></select></div>
      <div><span class="sub">Hugging Face 下載來源</span><select id="netHf">
        <option value="auto">自動：連不上就改用 hf-mirror.com</option>
        <option value="hf">只用官方 huggingface.co</option>
        <option value="mirror">只用鏡像 hf-mirror.com</option></select></div>
    </div>
    <div id="netManualRow" hidden><span class="sub">代理網址</span><input type="text" id="netUrl" placeholder="例如 127.0.0.1:7890（Clash）、127.0.0.1:10809（v2rayN）、socks5://127.0.0.1:7891" spellcheck="false"></div>
    <div class="muted sm">梯子開「系統代理」或「PAC」：選自動就好。開 TUN（虛擬網卡）模式：直連也會被接走，選自動也能通。梯子關掉但系統代理沒關的話，生圖站會自動改成直連。</div>
    <div class="row gap wrap"><button class="akey sm" id="netSave" type="button">儲存</button><button class="akey sm" id="netTest" type="button">測試連線</button><span class="muted sm" id="netMsg"></span></div>
    <div id="netResults"></div>`;
  const $ = (id) => box.querySelector("#" + id);
  const show = (st) => {
    $("netNow").textContent = st.text + (st.hf_mirror ? "・Hugging Face 用 hf-mirror.com 鏡像" : "");
    $("netNow").className = "sm " + (st.dead ? "st-no" : "");
  };
  const fill = (st) => {
    $("netProxy").value = st.cfg.proxy;
    $("netHf").value = st.cfg.hf;
    $("netUrl").value = st.cfg.proxy_url || "";
    $("netManualRow").hidden = st.cfg.proxy !== "manual";
    show(st);
  };
  let st;
  try { st = await api("/api/setup/net"); fill(st); }
  catch (e) { $("netNow").textContent = e.message; return; }
  $("netProxy").onchange = () => { $("netManualRow").hidden = $("netProxy").value !== "manual"; };
  $("netSave").onclick = async () => {
    $("netMsg").textContent = "";
    try {
      st = await api("/api/setup/net", { json: { proxy: $("netProxy").value, proxy_url: $("netUrl").value, hf: $("netHf").value } });
      fill(st);
      $("netMsg").textContent = "已儲存（ComfyUI 下次啟動時也會照這個設定）";
    } catch (e) { $("netMsg").textContent = e.message; }
  };
  $("netTest").onclick = () => test();
  async function test() {
    $("netTest").disabled = true;
    $("netResults").innerHTML = `<div class="muted sm">測試中…（最多約 15 秒）</div>`;
    try {
      const r = await api("/api/setup/net/test", { method: "POST", timeout: 60000 });
      show(r.status);
      $("netResults").innerHTML = `<table class="tbl net-tbl">${r.results.map((x) => `<tr><td>${esc(x.label)}</td><td>${x.ok
        ? `<span class="st-ok">✓ 連得到</span> <span class="muted sm">${x.ms} ms</span>`
        : `<span class="st-err">✗ 連不到</span><div class="muted sm">${esc(x.error || `HTTP ${x.code}`)}</div>`}</td></tr>`).join("")}</table>` + advice(r.results);
    } catch (e) { $("netResults").innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
    $("netTest").disabled = false;
  }
  if (autoTest) test();
}

// 測試結果 → 一句話建議
function advice(rs) {
  const ok = (id) => rs.find((x) => x.id === id)?.ok;
  const tips = [];
  if (!ok("hf") && ok("hf_mirror")) tips.push("Hugging Face 連不到，但鏡像 hf-mirror.com 可以：Hugging Face 上的模型會自動改從鏡像下載。");
  if (!ok("hf") && !ok("hf_mirror")) tips.push("Hugging Face 和鏡像都連不到：大部分模型下載不了。請開梯子（系統代理、PAC 或 TUN 模式），或在上面手動填代理。");
  if (!ok("github")) tips.push("GitHub 連不到：沒有 ComfyUI 的話下載不了 ComfyUI；AI 改寫的 llama.cpp、剪輯台的 ffmpeg 也下載不了。請開梯子再試。");
  if (!ok("civitai")) tips.push("Civitai 連不到：Noct Q 和常用 LoRA 裡來自 Civitai 的那些會下載失敗，其他照常。");
  if (!ok("node") && ok("node_mirror")) tips.push("nodejs.org 連不到，剪輯台的 Node.js 會自動改從 npmmirror 下載。");
  if (!tips.length) return `<div class="sm st-ok">✓ 全部連得到，可以直接下載。</div>`;
  return tips.map((t) => `<div class="warnbox sm">${esc(t)}</div>`).join("");
}
