// node --test --test-isolation=none tests/comic_layout.test.cjs
// 漫畫台排版工作台（2026-10-27 使用者：「他的[自訂]功能，能夠更加智能，可以自由堆疊，也更直覺，不要單純按鈕點一點」）：
// 切、併、拉格線、疊小格的純函式；閱讀順序要跟後端 src-tauri/src/comic.rs 的 free_cells 一模一樣（不然格子內容會配錯格），
// 切完已經寫好的格子內容要跟著格子走。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NAMES = ['MAX_PANELS', 'MAX_INSETS', 'isFree', 'blank', 'rowsToTree', 'presetCustom', 'geometry', 'readingIds', 'count', 'nextId', 'snapAt',
  'splitCell', 'removeCell', 'setCut', 'parentCut', 'nextSlant', 'toggleBrk', 'insetBox', 'addInset', 'moveInset', 'remap', 'knife', 'inPoly', 'insetPoly'];

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/comiclayout.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ console, el: () => null, toast: () => {} });
  vm.runInContext(`${source}\nglobalThis.subject = { ${NAMES.join(', ')} };`, context, { filename: 'comiclayout.js' });
  // vm 裡的物件原型不同，deepEqual 前先轉成本地的
  return Object.fromEntries(Object.entries(context.subject).map(([k, f]) => [k, typeof f === 'function' ? (...a) => JSON.parse(JSON.stringify(f(...a)) ?? 'null') : f]));
}
const L = load();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≠ ${b}`);
const free = (tree, insets = []) => ({ v: 2, tree, insets });

test('閱讀順序跟後端一樣：直刀先讀右邊、橫刀先讀上面、小格接在底下那格後面', () => {
  // 跟 comic.rs 的 free_tall_left_and_three_right_read_right_to_left 同一個版面
  const tall = free({ split: 'col', at: 0.42, a: { id: 'big' },
    b: { split: 'row', at: 0.33, a: { id: 'r1' }, b: { split: 'row', at: 0.5, a: { id: 'r2' }, b: { id: 'r3' } } } });
  assert.deepEqual(L.readingIds(tall), ['r1', 'r2', 'r3', 'big']);
  // 跟 free_inset_sits_after_its_host_and_is_named 同一個
  const ins = free({ split: 'row', at: 0.3, a: { id: 'top' }, b: { id: 'main' } }, [{ id: 'ins', x0: 0.62, y0: 0.72, x1: 0.95, y1: 0.95 }]);
  assert.deepEqual(L.readingIds(ins), ['top', 'main', 'ins']);
  // 小格疊在上面那格：排在上面那格後面、下面那格前面
  const up = free({ split: 'row', at: 0.5, a: { id: 'a' }, b: { id: 'b' } }, [{ id: 's', x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.3 }]);
  assert.deepEqual(L.readingIds(up), ['a', 's', 'b']);
});

test('舊的列／格版面轉成樹：閱讀順序、格數、比例都不變', () => {
  const t = L.rowsToTree([{ h: 2, cells: [1, 1] }, { h: 1, cells: [1] }]);
  assert.equal(L.isFree(t), true);
  assert.deepEqual(L.readingIds(t), ['p1', 'p2', 'p3']);
  const g = L.geometry(t).cells;
  near(g[0].rect[0], 0.5, '第 1 格在右上');
  near(g[0].rect[3], 0.667, '高度比例 2:1（存到小數三位）');
  near(g[1].rect[2], 0.5, '第 2 格在左上');
  // 一列三格、右邊寬
  const t3 = L.rowsToTree([{ h: 1, cells: [1, 1, 2] }]);
  assert.deepEqual(L.readingIds(t3), ['p1', 'p2', 'p3']);
  const c3 = L.geometry(t3).cells;
  assert.ok(Math.abs(c3[0].rect[2] - c3[0].rect[0] - 0.5) < 1e-3, '最右格是一半寬');
  near(c3[2].rect[0], 0, '最後讀的是最左格');
  assert.deepEqual(L.readingIds(L.rowsToTree([])), ['p1', 'p2', 'p3'], '空的給預設');
  assert.equal(L.isFree({ rows: [] }), false);
  assert.equal(L.isFree(null), false);
});

test('預設版型轉過來：格子編號照閱讀順序，所以已經寫好的內容照順序就對得上', () => {
  const want = { L3: 3, L4: 4, L4w: 4, L5: 5, L6: 6, K4: 4, ONE: 1 };
  for (const [id, k] of Object.entries(want)) {
    const c = L.presetCustom(id);
    assert.deepEqual(L.readingIds(c), Array.from({ length: k }, (_, i) => `p${i + 1}`), id);
  }
  const l3 = L.geometry(L.presetCustom('L3')).cells;
  assert.deepEqual(l3[0].rect.map((v) => +v.toFixed(3)), [0.5, 0, 1, 1], 'L3 第 1 格是右邊直長');
  const l4 = L.geometry(L.presetCustom('L4')).cells;
  assert.equal(l4[3].inset, true, 'L4 第 4 格是疊在大格上的小格');
  assert.equal(L.presetCustom('nope'), null);
});

test('切格：橫切原本的留上面、直切原本的留右邊；寫好的內容跟著格子走', () => {
  const b = L.blank();                      // 上：p2｜p1，下：p3
  const c = L.splitCell(b, 'p1', 'col', 0.5);
  assert.deepEqual(L.readingIds(c), ['p1', 'p4', 'p2', 'p3']);
  const blankPanel = () => ({ what: '' });
  const panels = [{ what: 'A' }, { what: 'B' }, { what: 'C' }, { what: 'hidden' }];
  assert.deepEqual(L.remap(L.readingIds(b), L.readingIds(c), panels, blankPanel).map((p) => p.what), ['A', '', 'B', 'C', 'hidden']);
  const r = L.splitCell(b, 'p3', 'row', 0.4);
  assert.deepEqual(L.readingIds(r), ['p1', 'p2', 'p3', 'p4'], '橫切：新的一格在下面、後讀');
  assert.equal(L.splitCell(b, 'zzz', 'row', 0.5), null, '找不到那格');
  // 位置夾在 15%～85%
  near(L.splitCell(b, 'p3', 'row', 0.01).tree.b.at, 0.15);
});

test('併格：空間讓給同一刀另一邊；只剩一格不能再併；小格直接刪', () => {
  const c = L.splitCell(L.blank(), 'p1', 'col', 0.5);
  assert.deepEqual(L.readingIds(L.removeCell(c, 'p4')), ['p1', 'p2', 'p3']);
  assert.deepEqual(L.readingIds(L.removeCell(L.blank(), 'p3')), ['p1', 'p2'], '下面那格拿掉，上面兩格長滿整頁');
  assert.equal(L.removeCell(L.presetCustom('ONE'), 'p1'), null);
  const l4 = L.presetCustom('L4');
  assert.deepEqual(L.readingIds(L.removeCell(l4, 'p4')), ['p1', 'p2', 'p3']);
  assert.equal(L.removeCell(l4, 'nope'), null);
});

test('上限：一頁最多 8 格（小格也算）、小格最多 2 個', () => {
  let c = L.presetCustom('ONE');
  for (let i = 0; i < 7; i++) c = L.splitCell(c, L.readingIds(c)[0], i % 2 ? 'row' : 'col', 0.5);
  assert.equal(L.count(c), 8);
  assert.equal(L.splitCell(c, 'p1', 'row', 0.5), null);
  assert.equal(L.addInset(c, [0.1, 0.1, 0.4, 0.4]), null);
  let d = L.presetCustom('L6');
  d = L.addInset(d, [0.1, 0.1, 0.4, 0.3]);
  assert.equal(L.count(d), 7);
  assert.equal(d.insets[0].id, 'p7');
  assert.equal(L.addInset(d, [0.6, 0.6, 0.9, 0.9]).insets.length, 2);
  assert.equal(L.addInset(L.addInset(L.presetCustom('L3'), [0.1, 0.1, 0.4, 0.3]), [0.6, 0.1, 0.9, 0.3]).insets.length, 2);
  assert.equal(L.addInset(L.addInset(L.addInset(L.presetCustom('L3'), [0.1, 0.1, 0.4, 0.3]), [0.6, 0.1, 0.9, 0.3]), [0.6, 0.6, 0.9, 0.9]), null);
  // 編號不重複
  const ids = L.readingIds(d);
  assert.equal(new Set(ids).size, ids.length);
});

test('小格的框：拉反了、太小、跑出頁面都會修好（後端擋 8%×6% 以下、70% 以上）', () => {
  assert.deepEqual(L.insetBox([0.9, 0.9, 0.5, 0.6]), { x0: 0.5, y0: 0.6, x1: 0.9, y1: 0.9 });
  const tiny = L.insetBox([0.5, 0.5, 0.51, 0.505]);
  assert.ok(tiny.x1 - tiny.x0 >= 0.1 - 1e-9 && tiny.y1 - tiny.y0 >= 0.08 - 1e-9, JSON.stringify(tiny));
  const edge = L.insetBox([0.97, 0.97, 0.99, 0.99]);
  assert.ok(edge.x1 <= 1 && edge.y1 <= 1, JSON.stringify(edge));
  const big = L.insetBox([0, 0, 1, 1]);
  assert.ok(big.x1 - big.x0 <= 0.7 + 1e-9 && big.y1 - big.y0 <= 0.7 + 1e-9, JSON.stringify(big));
  const moved = L.moveInset(L.presetCustom('L4'), 'p4', [0.1, 0.1, 0.3, 0.3]);
  assert.deepEqual(moved.insets[0], { id: 'p4', x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3, brk: false });
});

test('拉格線：吸到 1/3、1/2、2/3，夾在 15%～85%', () => {
  assert.equal(L.snapAt(0.49), 0.5);
  assert.equal(L.snapAt(0.31), 0.333);
  assert.equal(L.snapAt(0.69), 0.667);
  assert.equal(L.snapAt(0.42), 0.42);
  assert.equal(L.snapAt(0.02), 0.15);
  assert.equal(L.snapAt(0.99), 0.85);
  const c = L.setCut(L.blank(), [], { at: 0.7 });
  assert.equal(c.tree.at, 0.7);
  assert.equal(L.setCut(L.blank(), ['a'], { slant: 0.5 }).tree.a.slant, 0.2, '斜度最多 0.2');
  assert.equal(L.setCut(L.blank(), ['a'], { slant: 0.004 }).tree.a.slant, 0, '幾乎沒斜就是直的');
});

test('拖線切：偏水平＝橫切、偏垂直＝直切、斜著拖＝斜切、太短不切', () => {
  const r = [0, 0, 1, 1];
  const h = L.knife(r, [0.1, 0.5], [0.9, 0.51]);
  assert.equal(h.split, 'row');
  assert.equal(h.slant, 0, '差一點點還是直的');
  assert.equal(h.long, true);
  near(h.at, 0.505);
  const v = L.knife(r, [0.4, 0.1], [0.4, 0.8]);
  assert.equal(v.split, 'col');
  near(v.at, 0.4);
  const s = L.knife(r, [0.1, 0.4], [0.9, 0.6]);
  assert.equal(s.split, 'row');
  assert.ok(s.slant > 0, `往右下斜：${s.slant}`);
  assert.equal(L.knife(r, [0.4, 0.5], [0.5, 0.5]).long, false);
  // 在一小格裡切：位置照那一格算
  const sub = L.knife([0.5, 0, 1, 0.6], [0.55, 0.3], [0.95, 0.3]);
  near(sub.at, 0.5);
});

test('斜切：只有那一刀斜，格子形狀跟著變；斜切按鈕輪流 ／ ＼ 直', () => {
  const c = L.setCut(L.blank(), [], { slant: 0.1 });
  const g = L.geometry(c);
  assert.deepEqual(g.cells.map((k) => k.id), ['p1', 'p2', 'p3'], '斜了閱讀順序不變');
  const low = g.cells[2].poly;
  assert.ok(L.inPoly(low, 0.02, 0.56), '左邊刀比較高：(0.02, 0.56) 在下面那格');
  assert.ok(!L.inPoly(low, 0.98, 0.64), '右邊刀比較低：(0.98, 0.64) 不在下面那格');
  assert.equal(L.nextSlant(0), 0.08);
  assert.equal(L.nextSlant(0.08), -0.08);
  assert.equal(L.nextSlant(-0.08), 0);
  assert.deepEqual(L.parentCut(L.blank(), 'p1'), ['a']);
  assert.equal(L.parentCut(L.presetCustom('ONE'), 'p1'), null);
});

test('破格開關：一般格和小格都可以', () => {
  const a = L.toggleBrk(L.presetCustom('L4'), 'p3');
  assert.equal(L.geometry(a).cells[2].brk, true);
  const b = L.toggleBrk(a, 'p4');
  assert.equal(b.insets[0].brk, true);
  assert.equal(L.toggleBrk(b, 'p3').tree.b.brk, false);
});

test('格子之間的白縫：每一邊往內縮一樣寬，斜的格子也是', () => {
  const sq = L.insetPoly([[0, 0], [1, 0], [1, 1], [0, 1]], 10);
  near(sq[0][0], 0.01); near(sq[0][1], 10 / 1500);
  near(sq[2][0], 0.99); near(sq[2][1], 1 - 10 / 1500);
  // 往外擴（小格外圈白邊）
  const out = L.insetPoly([[0.5, 0.5], [0.6, 0.5], [0.6, 0.6], [0.5, 0.6]], -10);
  near(out[0][0], 0.49);
  // 有重複點也不會壞
  const dup = L.insetPoly([[0, 0], [0, 0], [1, 0], [1, 1], [0, 1]], 10);
  assert.equal(dup.length, 4);
});

test('nextId 不撞號：刪掉中間的格子再切，新格拿最大號＋1', () => {
  const c = L.removeCell(L.presetCustom('L5'), 'p3');
  assert.equal(L.nextId(c), 'p6');
  assert.equal(L.nextId(free({ id: 'big' })), 'p1');
});
