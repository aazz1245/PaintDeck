// node --test --test-isolation=none tests/dock_layout.test.cjs
// 自由版面（2026-10-26 使用者：「所有版面都可以自由收起／打開、自由分配位置與拉伸調整視窗大小」，
// 試拉後改要「貼邊隱藏/吸附，自動會貼著看圖區的四周邊緣。，自由拖拽，縮放大小，然後把那個看圖區釘選/置頂」）：
// 版面資料存在 localStorage，讀回來一定要能用（舊版、壞掉、少面板、多面板都不能當掉）；吸附、浮動、隱藏三種狀態互斥；看圖區不能被擠掉。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/dock.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const store = { get: (_k, d) => d, set() {} };
  const context = vm.createContext({ console, store, el: () => null, $: () => null, $$: () => [] });
  vm.runInContext(source + '\nglobalThis.subject = { DOCK_V, defaultLayout, normalizeLayout, movePanel, floatPanel, hidePanel, whereIs, clampSize, fitSizes, clampFloat, snapRect, avoidRect, dropTarget };', context, { filename: 'dock.js' });
  // vm 裡的物件原型不同，deepEqual 前先轉成本地的
  return Object.fromEntries(Object.entries(context.subject).map(([k, f]) => [k, typeof f === 'function' ? (...a) => JSON.parse(JSON.stringify(f(...a)) ?? 'null') : f]));
}

const SPEC = {
  panels: [
    { id: 'params', zone: 'left' }, { id: 'prompt', zone: 'left' }, { id: 'lora', zone: 'left' }, { id: 'extra', zone: 'left' },
    { id: 'recent', zone: 'right' },
  ],
  sizes: { top: 160, left: 350, right: 118, bottom: 220 },
};

test('defaultLayout：照每塊面板的預設區排好，看圖區預設釘選', () => {
  const { defaultLayout, DOCK_V } = load();
  const L = defaultLayout(SPEC);
  assert.equal(L.v, DOCK_V);
  assert.equal(DOCK_V, 2);
  assert.deepEqual(L.zones.left.ids, ['params', 'prompt', 'lora', 'extra']);
  assert.deepEqual(L.zones.right.ids, ['recent']);
  assert.deepEqual(L.zones.top.ids, []);
  assert.deepEqual(L.zones.bottom.ids, []);
  assert.equal(L.zones.left.size, 350);
  assert.equal(L.zones.top.size, 160);
  assert.equal(L.zones.left.active, 'params');
  assert.equal(L.zones.bottom.active, null);
  assert.deepEqual(L.float, {});
  assert.deepEqual(L.hide, {});
  assert.deepEqual(L.folded, []);
  assert.equal(L.pinned, true);
});

test('normalizeLayout：沒存檔、亂碼、舊版本（含第 1 版停靠區）都用預設', () => {
  const { defaultLayout, normalizeLayout } = load();
  const D = defaultLayout(SPEC);
  assert.deepEqual(normalizeLayout(null, SPEC), D);
  assert.deepEqual(normalizeLayout('亂碼', SPEC), D);
  assert.deepEqual(normalizeLayout({ v: 1, zones: { left: { ids: ['recent'] } } }, SPEC), D);
  assert.deepEqual(normalizeLayout({ v: 2 }, SPEC), D, '有版本號但沒有區');
});

test('normalizeLayout：未知面板丟掉、少的補回預設區、同一塊在好幾個地方只留一個（區＞浮動＞隱藏）', () => {
  const { defaultLayout, normalizeLayout } = load();
  const saved = defaultLayout(SPEC);
  saved.zones.left.ids = ['params', 'ghost', 'prompt'];        // 少了 lora、extra，多了 ghost
  saved.zones.bottom.ids = ['prompt', 'recent'];                // prompt 重複
  saved.zones.right.ids = [];
  saved.float = { prompt: { x: 1, y: 2, w: 300, h: 200 }, lora: { x: 10, y: 20, w: 300, h: 200 }, ghost: { x: 0, y: 0, w: 1, h: 1 } };
  saved.hide = { lora: { edge: 'left', at: 0.5, w: 300, h: 300 }, extra: { edge: 'nowhere', at: 0.5, w: 300, h: 300 } };
  const L = normalizeLayout(saved, SPEC);
  assert.deepEqual(L.zones.left.ids, ['params', 'prompt', 'extra'], 'extra 的隱藏邊不對 → 回預設區');
  assert.deepEqual(L.zones.bottom.ids, ['recent']);
  assert.deepEqual(Object.keys(L.float), ['lora']);
  assert.deepEqual(L.hide, {}, 'lora 已經在浮動，隱藏那份丟掉');
});

test('normalizeLayout：active、folded、size、浮動尺寸、pinned 不合理就修好', () => {
  const { defaultLayout, normalizeLayout } = load();
  const saved = defaultLayout(SPEC);
  saved.zones.left.active = 'recent';
  saved.zones.left.size = 'wide';
  saved.zones.bottom.active = 'params';
  saved.folded = ['lora', 'ghost'];
  saved.zones.right.ids = [];
  saved.float = { recent: { x: 'a', y: 5, w: -3, h: 200 } };
  saved.pinned = 'yes';
  const L = normalizeLayout(saved, SPEC);
  assert.equal(L.zones.left.active, 'params');
  assert.equal(L.zones.left.size, 350);
  assert.equal(L.zones.bottom.active, null);
  assert.deepEqual(L.folded, ['lora']);
  assert.deepEqual(L.float, {}, '浮動尺寸壞掉 → 回預設區');
  assert.deepEqual(L.zones.right.ids, ['recent']);
  assert.equal(L.pinned, true);
});

test('movePanel／floatPanel／hidePanel：三種狀態互斥，而且不改原本的版面', () => {
  const { defaultLayout, movePanel, floatPanel, hidePanel, whereIs } = load();
  const L = defaultLayout(SPEC);
  const before = JSON.parse(JSON.stringify(L));
  const A = movePanel(L, 'prompt', 'right', 0);
  assert.deepEqual(A.zones.right.ids, ['prompt', 'recent']);
  assert.deepEqual(A.zones.left.ids, ['params', 'lora', 'extra']);
  assert.equal(A.zones.right.active, 'prompt', '搬進來的那塊變成目前分頁');
  assert.deepEqual(L, before, '原本的版面沒被改到');
  const B = movePanel(L, 'lora', 'left', 0);
  assert.deepEqual(B.zones.left.ids, ['lora', 'params', 'prompt', 'extra']);
  const C = movePanel(L, 'params', 'top', 99);
  assert.deepEqual(C.zones.top.ids, ['params'], 'index 超出範圍放最後');
  assert.equal(C.zones.left.active, 'prompt', '搬走的是目前分頁，改成剩下的第一個');
  assert.deepEqual(movePanel(L, 'ghost', 'left', 0), before, '未知面板原樣回傳');

  const F = floatPanel(L, 'prompt', { x: 10.4, y: 20.6, w: 300, h: 200 });
  assert.deepEqual(F.float.prompt, { x: 10, y: 21, w: 300, h: 200 });
  assert.ok(!F.zones.left.ids.includes('prompt'));
  assert.deepEqual(whereIs(F, 'prompt'), { kind: 'float' });
  const H = hidePanel(F, 'prompt', 'right', 0.3, { w: 300, h: 400 });
  assert.deepEqual(H.hide.prompt, { edge: 'right', at: 0.3, w: 300, h: 400 });
  assert.deepEqual(H.float, {}, '藏起來就不再浮動');
  assert.deepEqual(whereIs(H, 'prompt'), { kind: 'hide', edge: 'right' });
  const Z = movePanel(H, 'prompt', 'bottom', 0);
  assert.deepEqual(Z.hide, {}, '吸回去就不再藏');
  assert.deepEqual(whereIs(Z, 'prompt'), { kind: 'zone', zone: 'bottom' });
  assert.equal(whereIs(Z, 'ghost'), null);
});

test('clampSize：每區有最小值，最大不超過可用空間的一定比例', () => {
  const { clampSize } = load();
  assert.equal(clampSize('left', 100, 1600), 260);
  assert.equal(clampSize('left', 2000, 1600), 800);
  assert.equal(clampSize('right', 50, 1600), 100);
  assert.equal(clampSize('bottom', 50, 900), 100);
  assert.equal(clampSize('bottom', 900, 900), 450);
  assert.equal(clampSize('top', 900, 900), 450);
  assert.equal(clampSize('left', 400, 1600), 400);
});

test('fitSizes：視窗變小時各區按比例縮，看圖區至少留 420×320', () => {
  const { defaultLayout, fitSizes } = load();
  const L = defaultLayout(SPEC);
  L.zones.left.size = 800; L.zones.right.size = 400;
  const s = fitSizes(L, 1500, 900);
  assert.ok(s.left + s.right + 420 + 20 <= 1500, `左右加主區超出：${JSON.stringify(s)}`);
  assert.ok(Math.abs(s.left / s.right - 2) < 0.05, '按原本比例縮');
  assert.equal(fitSizes(defaultLayout(SPEC), 1600, 900).left, 350, '夠寬就不動');

  const C = defaultLayout(SPEC); C.zones.left.collapsed = true;
  assert.equal(fitSizes(C, 1600, 900).left, 28, '收起剩直條');
  assert.equal(fitSizes(C, 1600, 900).bottom, 0, '沒有面板的區不佔位置');

  const B = defaultLayout(SPEC); B.zones.bottom.ids = ['recent']; B.zones.top.ids = ['lora']; B.zones.right.ids = [];
  B.zones.bottom.size = 400; B.zones.top.size = 400;
  const t = fitSizes(B, 1600, 800);
  assert.ok(t.top + t.bottom + 320 + 20 <= 800, `上下太高：${JSON.stringify(t)}`);
  assert.equal(t.top, t.bottom, '上下按比例縮');
});

test('clampFloat：浮動面板一定在容器裡、不會小到抓不到', () => {
  const { clampFloat } = load();
  assert.deepEqual(clampFloat({ x: -50, y: -10, w: 300, h: 200 }, 1000, 800), { x: 0, y: 0, w: 300, h: 200 });
  assert.deepEqual(clampFloat({ x: 900, y: 700, w: 300, h: 200 }, 1000, 800), { x: 700, y: 600, w: 300, h: 200 });
  assert.deepEqual(clampFloat({ x: 0, y: 0, w: 50, h: 10 }, 1000, 800), { x: 0, y: 0, w: 200, h: 80 });
  assert.deepEqual(clampFloat({ x: 0, y: 0, w: 5000, h: 5000 }, 1000, 800), { x: 0, y: 0, w: 1000, h: 800 });
});

test('snapRect：靠近別塊面板或容器的邊就吸過去（10px 內）', () => {
  const { snapRect } = load();
  const others = [{ x: 0, y: 0, w: 100, h: 100 }];
  assert.deepEqual(snapRect({ x: 106, y: 50, w: 200, h: 100 }, others, 1000, 800), { x: 100, y: 50, w: 200, h: 100 }, '左邊貼到別塊的右邊');
  assert.deepEqual(snapRect({ x: 300, y: 4, w: 200, h: 100 }, others, 1000, 800), { x: 300, y: 0, w: 200, h: 100 }, '上邊貼到容器頂');
  assert.deepEqual(snapRect({ x: 795, y: 300, w: 200, h: 100 }, others, 1000, 800), { x: 800, y: 300, w: 200, h: 100 }, '右邊貼到容器右緣');
  assert.deepEqual(snapRect({ x: 300, y: 300, w: 200, h: 100 }, others, 1000, 800), { x: 300, y: 300, w: 200, h: 100 }, '離得遠就不動');
});

test('dropTarget：最外緣＝貼邊隱藏、看圖區四邊附近＝吸附、其他地方＝浮動', () => {
  const { dropTarget } = load();
  const host = { left: 0, top: 0, right: 1600, bottom: 900 };
  const main = { left: 360, top: 0, right: 1470, bottom: 900 };
  assert.deepEqual(dropTarget(5, 400, host, main), { kind: 'hide', edge: 'left', at: 400 / 900 });
  assert.deepEqual(dropTarget(1596, 450, host, main), { kind: 'hide', edge: 'right', at: 0.5 });
  assert.deepEqual(dropTarget(380, 400, host, main), { kind: 'zone', zone: 'left' }, '看圖區左邊裡面一點點');
  assert.deepEqual(dropTarget(1450, 400, host, main), { kind: 'zone', zone: 'right' });
  assert.deepEqual(dropTarget(900, 870, host, main), { kind: 'zone', zone: 'bottom' });
  assert.deepEqual(dropTarget(900, 30, host, main), { kind: 'zone', zone: 'top' });
  assert.deepEqual(dropTarget(900, 450, host, main), { kind: 'float' }, '看圖區正中間');
  assert.deepEqual(dropTarget(200, 450, host, main), { kind: 'float' }, '左區那邊的空地（左區沒面板時）');
});

test('avoidRect：看圖區釘選時，疊到看圖區上的浮動面板被推到旁邊最近的空位', () => {
  const { avoidRect } = load();
  const m = { x: 400, y: 0, w: 800, h: 900 };
  assert.deepEqual(avoidRect({ x: 450, y: 100, w: 300, h: 200 }, m, 1600, 900), { x: 100, y: 100, w: 300, h: 200 }, '靠左 → 推到看圖區左邊');
  assert.deepEqual(avoidRect({ x: 1000, y: 100, w: 300, h: 200 }, m, 1600, 900), { x: 1200, y: 100, w: 300, h: 200 }, '靠右 → 推到右邊');
  assert.deepEqual(avoidRect({ x: 50, y: 100, w: 300, h: 200 }, m, 1600, 900), { x: 50, y: 100, w: 300, h: 200 }, '沒疊到不動');
  const full = { x: 0, y: 0, w: 1600, h: 900 };
  assert.deepEqual(avoidRect({ x: 50, y: 100, w: 300, h: 200 }, full, 1600, 900), { x: 50, y: 100, w: 300, h: 200 }, '四邊都放不下就不動');
});
