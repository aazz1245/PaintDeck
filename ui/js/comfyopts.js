// 設定頁「ComfyUI 啟動方式」：額外啟動參數、我自己開 ComfyUI、用 CPU 跑。後端 gpu.rs 的 comfy.json、setup.rs 的 /api/setup/comfy_opts；
// 生圖站開 ComfyUI 時照這些設定（launcher.rs）
import { api as baseApi } from "./util.js";

// /api/setup/* 要帶這個標頭（後端用來擋別的網站送來的請求）
const api = (path, opts = {}) => baseApi(path, { ...opts, headers: { ...(opts.headers || {}), "X-Anima-Setup": "1" } });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const KIND = { cuda: "NVIDIA 版（CUDA）", rocm: "AMD 版（ROCm）", xpu: "Intel 版（XPU）", cpu: "CPU 版", zluda: "ZLUDA 版（A 卡）", directml: "DirectML 版", other: "其他版本" };

/** 在 box 裡畫出 ComfyUI 啟動方式的設定 */
export async function mountComfyOpts(box) {
  box.innerHTML = `
    <div class="sm"><span class="muted">這份 ComfyUI：</span><span id="coKind">讀取中…</span></div>
    <div id="coNote" class="muted sm"></div>
    <div id="coOld" class="warnbox sm" hidden></div>
    <label class="check"><input type="checkbox" id="coExternal"> 我自己開 ComfyUI，生圖站只連過去（不自動開、結束時也不會關）</label>
    <label class="check"><input type="checkbox" id="coCpu"> 用 CPU 跑（沒有能用的顯示卡時；非常慢）</label>
    <div><span class="sub">ComfyUI 額外啟動參數</span><input type="text" id="coArgs" placeholder="例如 --lowvram　--use-pytorch-cross-attention　--reserve-vram 1" spellcheck="false"></div>
    <div class="muted sm">接在生圖站自己的參數後面；--port、--output-directory 這些由生圖站設定，不能放。改了要重開 ComfyUI 才生效。</div>
    <div><span class="sub">Python 位置（自動找不到時才填）</span><input type="text" id="coPython" placeholder="例如 D:\\conda\\envs\\comfy\\python.exe" spellcheck="false"></div>
    <div class="muted sm">conda、放在 ComfyUI 外面的 venv、系統 Python 這類生圖站自己找不到的，填它的 python.exe；空白＝自動找。現在用的：<span id="coPyNow" class="path" translate="no">—</span></div>
    <div><span class="sub">ComfyUI 的連接埠</span><input type="text" id="coPort" placeholder="空白＝自動（8188）" inputmode="numeric" spellcheck="false" style="max-width:160px"></div>
    <div class="muted sm">空白＝自動：用 8188，被另一份 ComfyUI 占走時生圖站自己這份會換一個空的。「我自己開」又不是開在 8188 的（SwarmUI、改過連接埠的整合包）填它的連接埠。改了要重開生圖站才生效。</div>
    <div class="row gap wrap"><button class="akey sm" id="coSave" type="button">儲存</button><button class="akey sm" id="coRestart" type="button">儲存並重開 ComfyUI</button><span class="muted sm" id="coMsg"></span></div>`;
  const $ = (id) => box.querySelector("#" + id);
  const fill = (v) => {
    $("coKind").innerHTML = v.backend ? `${esc(KIND[v.backend] || v.backend)}${v.torch ? ` <span class="muted" translate="no">（PyTorch +${esc(v.torch)}）</span>` : ""}` : "找不到 PyTorch";
    $("coNote").innerHTML = v.backend === "zluda"
      ? (v.zluda_exe ? `生圖站會照它的 bat 用 zluda.exe 開：<span class="path" translate="no">${esc(v.zluda_exe)}</span>` : "找不到 zluda.exe：請用它自己的啟動器開 ComfyUI，並勾下面的「我自己開 ComfyUI」")
      : v.backend === "directml" ? "生圖站開 ComfyUI 時會自動加 --directml。" : "";
    if (v.version) $("coKind").innerHTML += ` <span class="muted">・版本 ${esc(v.version)}</span>`;
    $("coOld").hidden = !v.old;
    if (v.old) $("coOld").textContent = `這份 ComfyUI 是 ${v.version} 版，比生圖站測過的 ${v.min_version} 舊：有些內建功能會缺節點。建議到「安裝與修復…」改用自動下載的新版，或自己更新 ComfyUI。`;
    $("coExternal").checked = v.prefs.external;
    $("coCpu").checked = v.prefs.cpu;
    $("coArgs").value = v.prefs.extra_args || "";
    $("coPython").value = v.prefs.python || "";
    $("coPyNow").textContent = v.python || "找不到";
    $("coPort").value = v.prefs.port ? String(v.prefs.port) : "";
  };
  try { fill(await api("/api/setup/comfy_opts")); }
  catch (e) { $("coKind").textContent = e.message; return; }
  const save = async () => {
    const v = await api("/api/setup/comfy_opts", { json: { external: $("coExternal").checked, cpu: $("coCpu").checked, extra_args: $("coArgs").value,
      python: $("coPython").value, port: $("coPort").value } });
    fill(v);
  };
  $("coSave").onclick = async () => {
    try { await save(); $("coMsg").textContent = "已儲存，下次開 ComfyUI 生效"; }
    catch (e) { $("coMsg").textContent = e.message; }
  };
  $("coRestart").onclick = async () => {
    try {
      await save();
      await api("/api/models/restart_comfy", { json: {} });
      $("coMsg").textContent = "已儲存，ComfyUI 重開中…";
    } catch (e) { $("coMsg").textContent = e.message; }
  };
}
