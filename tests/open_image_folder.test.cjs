const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('deck.ICONS 包含 folder 圖標', () => {
  const deckSrc = fs.readFileSync(path.join(__dirname, '../ui/js/deck.js'), 'utf-8');
  assert.match(deckSrc, /folder:\s*['"]<path d="M3 5/);
});

test('ui/index.html 包含開啟資料夾按鈕 (viewActions 與 lbActions)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf-8');
  assert.match(html, /id="viewActions"[\s\S]*?data-act="open_folder"/);
  assert.match(html, /id="lbActions"[\s\S]*?data-act="open_folder"/);
});

test('gen.js 導出 getComfyOutputDir, resolveImageFilePath, openImageFolder, openImageContextMenu, closeImageMenu', () => {
  const genSrc = fs.readFileSync(path.join(__dirname, '../ui/js/gen.js'), 'utf-8');
  assert.match(genSrc, /export async function getComfyOutputDir/);
  assert.match(genSrc, /export async function resolveImageFilePath/);
  assert.match(genSrc, /export async function openImageFolder/);
  assert.match(genSrc, /export function openImageContextMenu/);
  assert.match(genSrc, /export function closeImageMenu/);
});

test('openImageFolder 實作徹底解耦 ComfyUI 狀態，預置路徑快取零延遲且靜默開窗無干擾', () => {
  const genSrc = fs.readFileSync(path.join(__dirname, '../ui/js/gen.js'), 'utf-8');
  // 1. 不再將開啟資料夾失敗歸咎於 ComfyUI 連線
  assert.doesNotMatch(genSrc, /無法連線至 ComfyUI/);
  // 2. 移除成功開啟時多餘的 Toast 提示（靜默開窗）
  assert.doesNotMatch(genSrc, /已在檔案總管開啟儲存資料夾/);
  // 3. 預置 cachedOutputDir，消除初次開窗等待 2000ms 超時延遲
  assert.match(genSrc, /let cachedOutputDir = "E:\\\\AI\\\\ComfyUI-aki\\\\ComfyUI-aki-v1.6\\\\ComfyUI\\\\output"/);
  // 4. 軌道 1：使用同源 /api/reveal 與 .paintdeck_folder.json 錨點秒開資料夾
  assert.match(genSrc, /\/api\/reveal/);
  assert.match(genSrc, /\.paintdeck_folder\.json/);
  // 5. 終極保底路徑複製
  assert.match(genSrc, /已複製圖片檔案路徑：/);
});

test('renderStrip 在幻燈片匣圖片上綁定右鍵選單與快捷鍵', () => {
  const genSrc = fs.readFileSync(path.join(__dirname, '../ui/js/gen.js'), 'utf-8');
  assert.match(genSrc, /oncontextmenu:\s*\(e\)\s*=>/);
  assert.match(genSrc, /openImageContextMenu\(e,\s*r\)/);
  assert.match(genSrc, /openImageFolder\(r\)/);
});

test('viewImg 與 viewVid 綁定預覽區右鍵選單', () => {
  const genSrc = fs.readFileSync(path.join(__dirname, '../ui/js/gen.js'), 'utf-8');
  assert.match(genSrc, /viewImg.*addEventListener\("contextmenu",\s*handlePreviewContextMenu\)/);
  assert.match(genSrc, /viewVid.*addEventListener\("contextmenu",\s*handlePreviewContextMenu\)/);
});

test('imageAction 支援 open_folder 動作', () => {
  const genSrc = fs.readFileSync(path.join(__dirname, '../ui/js/gen.js'), 'utf-8');
  assert.match(genSrc, /else if \(act === "open_folder"\)\s*\{\s*await openImageFolder\(rec\);/);
});

test('gallery.js 在燈箱與卡片上綁定右鍵選單', () => {
  const galSrc = fs.readFileSync(path.join(__dirname, '../ui/js/gallery.js'), 'utf-8');
  assert.match(galSrc, /lbImg.*addEventListener\("contextmenu",\s*handleLbContextMenu\)/);
  assert.match(galSrc, /t\.addEventListener\("contextmenu"/);
});

test('檔案路徑解析與開啟邏輯驗證', async () => {
  function mockResolveImageFilePath(rec, outputDir) {
    if (!rec || !rec.filename) return null;
    const sub = rec.subfolder ? `${rec.subfolder}\\` : '';
    return `${outputDir}\\${sub}${rec.filename}`.replace(/\\+/g, '\\');
  }

  const outDir = 'E:\\AI\\ComfyUI-aki\\ComfyUI-aki-v1.6\\ComfyUI\\output';
  const rec1 = { id: 392, filename: 'detail_00001_.png', subfolder: 'AnimaWeb' };
  const path1 = mockResolveImageFilePath(rec1, outDir);
  assert.strictEqual(path1, 'E:\\AI\\ComfyUI-aki\\ComfyUI-aki-v1.6\\ComfyUI\\output\\AnimaWeb\\detail_00001_.png');

  const rec2 = { id: 393, filename: 'txt2img_00001_.png', subfolder: '' };
  const path2 = mockResolveImageFilePath(rec2, outDir);
  assert.strictEqual(path2, 'E:\\AI\\ComfyUI-aki\\ComfyUI-aki-v1.6\\ComfyUI\\output\\txt2img_00001_.png');
});
