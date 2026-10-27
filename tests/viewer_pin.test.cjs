// node --test --test-isolation=none tests/viewer_pin.test.cjs
// 生成頁看圖框（#win）的防呆：2026-10-26 朋友回報「圖片會飄、位置不對、換尺寸也不恢復，介面縮放或拉寬時觸發」。
// 圖片是貼著 #win 絕對定位的，#win 只要被捲動過，圖就整張歪掉；所以 #win 不能捲、等待動畫自己捲，變大小或被捲到時歸零。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/deck.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const store = { get: (_k, d) => d, set() {} };
  const context = vm.createContext({ console, store, $: () => null, $$: () => [], modeName: {}, api() {}, toast() {}, play() {} });
  vm.runInContext(source + '\nglobalThis.subject = { pinView };', context, { filename: 'deck.js' });
  return context.subject;
}

function fakeWin() {
  const on = {};
  return { scrollTop: 0, scrollLeft: 0, on, addEventListener: (k, f) => (on[k] = f) };
}

test('pinView：一開始、被捲到、變大小時都把捲動歸零', () => {
  const { pinView } = load();
  const win = fakeWin();
  win.scrollTop = 40; win.scrollLeft = 7;
  let observed = null, cb = null;
  class RO { constructor(f) { cb = f; } observe(el) { observed = el; } }
  pinView(win, RO);
  assert.deepEqual([win.scrollTop, win.scrollLeft], [0, 0], '一開始就歸零');
  assert.equal(observed, win, '要盯著 #win 自己的大小');
  win.scrollTop = 123;
  win.on.scroll();
  assert.equal(win.scrollTop, 0, '被捲到（選字拖曳、focus）馬上拉回來');
  win.scrollLeft = 9;
  cb();
  assert.equal(win.scrollLeft, 0, '視窗或版面變大小時歸零');
});

test('pinView：沒有 ResizeObserver 的舊環境也不會壞', () => {
  const { pinView } = load();
  const win = fakeWin();
  win.scrollTop = 5;
  pinView(win, undefined);
  assert.equal(win.scrollTop, 0);
  assert.equal(typeof win.on.scroll, 'function');
});

test('CSS：#win 不能當捲動容器、等待動畫在自己裡面捲', () => {
  const css = fs.readFileSync(path.join(__dirname, '../ui/css/app.css'), 'utf8');
  const rule = (sel) => (css.match(new RegExp(`^${sel.replace(/[.*]/g, '\\$&')} \\{([^}]*)\\}`, 'm')) || [])[1] || '';
  assert.match(rule('.win'), /overflow: clip/, '.win 要 overflow: clip（連程式都捲不動）');
  assert.match(rule('.boot'), /overflow: auto/, '.boot 內容太高時在自己裡面捲，不要撐開 #win');
  assert.match(rule('.boot'), /place-content: safe center/, '捲的時候上半部不能被切掉');
});
