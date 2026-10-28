// 加了外部模型資料夾、ComfyUI 還沒讀到：生成頁的提醒框（gen.js paintDirsPending）用到的元素都要在 index.html 裡
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
const gen = fs.readFileSync(path.join(__dirname, '../ui/js/gen.js'), 'utf8');

test('提醒框用到的 id 都有，且一開始是藏起來的', () => {
  const ids = [...new Set([...gen.matchAll(/F\("(dirsPending\w*)"\)/g)].map((m) => m[1]))];
  assert.ok(ids.length >= 4, `gen.js 該用到提醒框的各個元素：${ids}`);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `index.html 少了 #${id}`);
  assert.match(html, /id="dirsPending" hidden/);
  assert.match(html, /id="dirsPendingManual" hidden/);
});

test('「不要再提醒」只記這一組資料夾（之後又加新的會再提醒）', () => {
  assert.match(gen, /store\.set\("dirsPendingHide", dirsPendingSig\(/);
  assert.match(gen, /store\.get\("dirsPendingHide", ""\) === dirsPendingSig\(/);
});
