const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRefs(toast) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/refs.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const sandbox = {
    $: () => ({ innerHTML: '', textContent: '', append() {}, addEventListener() {}, classList: { add() {}, remove() {} } }),
    el: () => ({ addEventListener() {} }),
    api: async () => ({}),
    toast,
    uploadFile: async () => ({}),
    pickFromGallery: () => {},
  };
  vm.runInNewContext(`${source}\nglobalThis.__out = { set, check };`, sandbox);
  return sandbox.__out;
}

test('index.html 包含 MOSS 多圖參考版面選單與提示', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf-8');
  assert.match(html, /id="refMossRow"/);
  assert.match(html, /id="refMossFormat"/);
  assert.match(html, /value="Moss-Image-Edit"/);
  assert.match(html, /id="refMossMount"/);
  assert.match(html, /id="refFamilyWarn"[^>]*>多圖參考只支援 Qwen 2\.1、MOSS-Image 與 Krea 2 模型/);
});

test('gen.js 允許 MOSS 家族進行多圖參考且帶入 moss_edit 參數', () => {
  const genSrc = fs.readFileSync(path.join(__dirname, '../ui/js/gen.js'), 'utf-8');
  assert.match(genSrc, /const canRef = q \|\| fam\(\) === "moss" \|\| fam\(\) === "krea2";/);
  assert.match(genSrc, /if \(fam\(\) === "moss" && S\.mode === "multiref"\) p\.moss_edit = F\("refMossFormat"\)\?\.value \|\| "auto";/);
  assert.match(genSrc, /if \(fam\(\) !== "qwen21" && fam\(\) !== "moss" && fam\(\) !== "krea2"\)/);
  assert.match(genSrc, /"refMossFormat"/);
});

test('refs.check 同時相容 <imageN>、image N、Picture N 與中文圖N 標記', () => {
  const toasts = [];
  const mod = loadRefs((m) => toasts.push(m));
  assert.equal(typeof mod.check, 'function');
  mod.set([{ name: 'a.png' }, { name: 'b.png' }]);

  assert.equal(mod.check('Dress the person in <image1> in the outfit from <image2>.'), null);
  assert.equal(mod.check('Dress the person in image 1 in the outfit from image 2.'), null);
  assert.equal(mod.check('把图1的人换上Picture 2的衣服'), null);
  assert.equal(toasts.length, 0);

  // 超出張數應回報錯誤
  assert.match(mod.check('Dress image 3 on image 1'), /第 3 張圖沒有對應的參考圖/);
  assert.match(mod.check('Use <image3>'), /<image3> 沒有對應的參考圖/);

  // 兩張圖以上卻沒任何標記才提示
  assert.equal(mod.check('no reference markers at all'), null);
  assert.equal(toasts.length, 1);
});
