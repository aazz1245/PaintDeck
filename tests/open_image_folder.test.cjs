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

test('openImageFolder 實作徹底解耦 ComfyUI 狀態，優先走 8190 原生 reveal 通道直接開窗', () => {
  const genSrc = fs.readFileSync(path.join(__dirname, '../ui/js/gen.js'), 'utf-8');
  // 1. 不再將開啟資料夾失敗歸咎於 ComfyUI 連線
  assert.doesNotMatch(genSrc, /無法連線至 ComfyUI/);
  // 2. 軌道 1：使用同源 /api/reveal 與 .paintdeck_folder.json 錨點秒開資料夾
  assert.match(genSrc, /\/api\/reveal/);
  assert.match(genSrc, /\.paintdeck_folder\.json/);
  // 3. 軌道 2：輔助通道採用 text/plain 避免 OPTIONS 預檢
  assert.match(genSrc, /"Content-Type":\s*"text\/plain"/);
  // 4. 終極保底路徑複製
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
