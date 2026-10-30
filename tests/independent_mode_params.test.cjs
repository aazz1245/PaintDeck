const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const genJsPath = path.resolve(__dirname, "../ui/js/gen.js");
const playJsPath = path.resolve(__dirname, "../ui/js/play.js");

test("gen.js 導出模式表單記憶相關函數", () => {
  const content = fs.readFileSync(genJsPath, "utf-8");
  assert.ok(content.includes("export function getModeForms"), "應導出 getModeForms");
  assert.ok(content.includes("export function saveModeForm"), "應導出 saveModeForm");
  assert.ok(content.includes("export function loadModeForm"), "應導出 loadModeForm");
  assert.ok(content.includes("export function initModeDefaults"), "應導出 initModeDefaults");
  assert.ok(content.includes("export function applyModeForm"), "應導出 applyModeForm");
  assert.ok(content.includes("export function setMode"), "應導出 setMode");
});

test("setMode 會在切換模式時自動儲存前一模式並加載目標模式參數", () => {
  const content = fs.readFileSync(genJsPath, "utf-8");
  assert.ok(content.includes("saveModeForm(prevMode)"), "切換模式時應保存前一個模式的表單");
  assert.ok(content.includes("loadModeForm(mode)"), "切換模式時應載入目標模式的表單");
});

test("save 會將當前表單同時同步至 store 的 modeForms[S.mode]", () => {
  const content = fs.readFileSync(genJsPath, "utf-8");
  assert.ok(content.includes('store.set("modeForms", mf)'), "save 應將表單記錄進 modeForms");
  assert.ok(content.includes("mf[S.mode] = currentForm"), "save 應以 S.mode 為鍵保存表單");
});

test("generate 與 sweep 會將 autoDetail 及 detailDenoise 紀錄至 S.pending 以支援異步完成時修臉", () => {
  const content = fs.readFileSync(genJsPath, "utf-8");
  const matches = content.match(/S\.pending\.set\(j\.job,\s*\{[^}]*autoDetail:[^}]*\}\)/g);
  assert.ok(matches && matches.length >= 2, "generate 與 sweep 都應在 S.pending 中記錄 autoDetail 與 detailDenoise");
});

test("play.js onImage 支援所有生成模式（包含放大 upscale）並讀取 job 專屬的 autoDetail 參數", () => {
  const content = fs.readFileSync(playJsPath, "utf-8");
  assert.ok(content.includes("pInfo?.autoDetail"), "onImage 應優先從 S.pending 的 pInfo 讀取 autoDetail");
  assert.ok(content.includes("![\"rembg\", \"xy\", \"video\", \"detail\"].includes(rec?.mode)"), "onImage 不應限制僅 txt2img/img2img，應支援 upscale 等生成模式自動修臉");
  assert.ok(content.includes("detail(rec, \"face\", true, denoise)"), "onImage 應呼叫 detail 執行修臉，並傳入模式專屬的 denoise 幅度");
});

test("模擬驗證各模式獨立保存與還原", () => {
  const storeData = {};
  const mockStore = {
    get: (k, def) => (storeData[k] !== undefined ? storeData[k] : def),
    set: (k, v) => { storeData[k] = v; },
  };

  let modeForms = null;
  function getModeForms() {
    if (!modeForms) modeForms = mockStore.get("modeForms", {}) || {};
    return modeForms;
  }

  const S = { mode: "txt2img" };
  const formState = {
    txt2img: { autoDetail: false, detailDenoise: 0.35, denoise: 0.6, width: 1024, height: 1536 },
    upscale: { autoDetail: true, detailDenoise: 0.5, upScale: "2", upDenoise: 0.3 },
  };

  let currentDOM = { ...formState.txt2img };

  function collectForm() {
    return { ...currentDOM, mode: S.mode };
  }

  function applyModeForm(f) {
    currentDOM = { ...f };
  }

  function saveModeForm(mode) {
    if (!mode) return;
    const mf = getModeForms();
    mf[mode] = collectForm();
    mockStore.set("modeForms", mf);
  }

  function loadModeForm(mode) {
    if (!mode) return;
    const mf = getModeForms();
    if (mf[mode]) {
      applyModeForm(mf[mode]);
    } else {
      currentDOM = { autoDetail: false, detailDenoise: 0.4 };
      mf[mode] = collectForm();
      mockStore.set("modeForms", mf);
    }
  }

  function setMode(mode) {
    const prevMode = S.mode;
    if (prevMode && prevMode !== mode) {
      saveModeForm(prevMode);
    }
    S.mode = mode;
    loadModeForm(mode);
  }

  // 1. 文生圖中關閉自動修臉
  saveModeForm("txt2img");
  assert.equal(currentDOM.autoDetail, false);

  // 2. 切換到放大 (upscale)，開啟自動修臉並設定幅度為 0.5
  setMode("upscale");
  currentDOM.autoDetail = true;
  currentDOM.detailDenoise = 0.5;
  saveModeForm("upscale");
  assert.equal(currentDOM.autoDetail, true);
  assert.equal(currentDOM.detailDenoise, 0.5);

  // 3. 切換回文生圖，確認文生圖仍為關閉狀態
  setMode("txt2img");
  assert.equal(currentDOM.autoDetail, false);
  assert.equal(currentDOM.detailDenoise, 0.35);

  // 4. 再切換回放大，確認放大模式下的自動修臉依然是開啟狀態
  setMode("upscale");
  assert.equal(currentDOM.autoDetail, true);
  assert.equal(currentDOM.detailDenoise, 0.5);
});
