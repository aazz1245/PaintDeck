// node --test --test-isolation=none tests/shotsheet_ui.test.cjs
// 拍攝單（ui/js/shotsheet.js）的規則：在隔離的 VM 跑實際模組，API、confirm、對話框都換成假的。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// VM 裡做出來的陣列原型不同，比對前先轉成這邊的普通物件
const plain = (x) => JSON.parse(JSON.stringify(x));

function element(tag, attrs = {}, ...children) {
  return Object.assign({ tag, value: '', checked: false, disabled: false, children, hidden: false, dataset: {}, style: {},
    classList: { add() {}, toggle() {}, remove() {} }, focus() {}, remove() {}, setAttribute() {},
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {}, dispatchEvent() {}, querySelectorAll() { return []; }, querySelector() { return null; },
  }, attrs);
}
function sheetModule({ api, confirmAnswer = true, extras = {} } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/shotsheet.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const asked = [], opened = [];
  const saved = {};
  const context = vm.createContext({
    structuredClone, console, Event, setTimeout, clearTimeout,
    api, el: element, $: () => null, $$: () => [], toast() {},
    store: { get: (k, d) => (k in saved ? saved[k] : d), set: (k, v) => { saved[k] = v; } },
    debounce: () => () => {},
    confirm: (msg) => { asked.push(msg); return typeof confirmAnswer === 'function' ? confirmAnswer(msg) : confirmAnswer; },
    studio: { openVideo: (sub) => opened.push(sub) },
    assets: { list: async () => [] },
    openModal() {}, closeModal() {}, pickFromGallery() {}, uploadFile() {}, pickFile() {},
    document: { getElementById: () => null, addEventListener() {}, body: element('body') },
    ...extras,
  });
  vm.runInContext(source + `
globalThis.subject = { load, current: () => S, composeNow, setSegCount, addCast, removeCast, precheck, applyTo, setAsk: (f) => { ask = f; } };`,
  context, { filename: 'shotsheet.js' });
  return { s: context.subject, asked, opened, saved };
}

test('compose_asks_before_overwriting_manual', async () => {
  const api = async (url) => {
    assert.equal(url, '/api/shotsheet/compose');
    return { segments: [{ prompt: 'new1', mirror: 'm1' }, { prompt: 'new2', mirror: 'm2' }], estimate: [] };
  };
  const m = sheetModule({ api, confirmAnswer: false });
  m.s.load({ segments: [{ secs: 10, prompt: 'old1' }, { secs: 10, prompt: '手改的', manual: true }] });
  await m.s.composeNow({ ask: true });
  const segs = m.s.current().segments;
  assert.equal(segs[0].prompt, 'new1');
  assert.equal(segs[0].mirror, 'm1');
  assert.equal(segs[1].prompt, '手改的');
  assert.equal(segs[1].manual, true);
  assert.equal(m.asked.length, 1);
  assert.match(m.asked[0], /第 2 段/);
  // 答應就全部重組、手改標記拿掉
  const m2 = sheetModule({ api, confirmAnswer: true });
  m2.s.load({ segments: [{ prompt: 'old1' }, { prompt: '手改的', manual: true }] });
  await m2.s.composeNow({ ask: true });
  assert.equal(m2.s.current().segments[1].prompt, 'new2');
  assert.equal(m2.s.current().segments[1].manual, false);
  // 自動重組（打字時）不問、也不蓋手改的
  const m3 = sheetModule({ api, confirmAnswer: true });
  m3.s.load({ segments: [{ prompt: 'old1' }, { prompt: '手改的', manual: true }] });
  await m3.s.composeNow();
  assert.equal(m3.asked.length, 0);
  assert.equal(m3.s.current().segments[1].prompt, '手改的');
});

test('shrink_asks_when_segments_have_content', async () => {
  const m = sheetModule({ api: async () => ({ segments: [], estimate: [] }), confirmAnswer: false });
  m.s.load({ segments: [{}, {}, { beats: [{ from: 2, to: 4, action: '', line: '再見' }] }] });
  assert.equal(m.s.setSegCount(2), false);
  assert.equal(m.s.current().segments.length, 3);
  assert.match(m.asked[0], /第 3 段/);
  // 空的段直接拿掉、不問
  m.s.load({ segments: [{}, {}, {}] });
  assert.equal(m.s.setSegCount(1), true);
  assert.equal(m.s.current().segments.length, 1);
  assert.equal(m.asked.length, 1);
  assert.deepEqual(m.opened, ['short']);
  assert.equal(m.s.setSegCount(4), true);
  assert.equal(m.s.current().segments.length, 4);
  assert.equal(m.opened.at(-1), 'long');
  assert.equal(m.s.setSegCount(99), true);
  assert.equal(m.s.current().segments.length, 30);
});

test('precheck_lets_user_send_anyway', async () => {
  let reply = { issues: [{ seg: 0, rule: 1, level: 'warn', word: 'dreamy', msg: 'x' }] };
  const calls = [];
  const m = sheetModule({ api: async (url, opts) => { calls.push([url, opts.json]); return reply; } });
  const shown = [];
  m.s.setAsk(async (issues) => { shown.push(issues); return true; });
  assert.equal(await m.s.precheck(['a dreamy girl']), true);
  assert.equal(calls[0][0], '/api/shotsheet/check');
  assert.deepEqual(plain(calls[0][1].prompts), ['a dreamy girl']);
  m.s.setAsk(async (issues) => { shown.push(issues); return false; });
  assert.equal(await m.s.precheck(['a dreamy girl']), false);
  assert.equal(shown.length, 2);
  reply = { issues: [] };
  assert.equal(await m.s.precheck(['ok']), true);
  assert.equal(shown.length, 2, '沒問題不開對話框');
});

test('cast_gets_speakers_in_order', async () => {
  const api = async (url) => {
    const id = Number(url.match(/assets\/(\d+)/)[1]);
    return { text: `外觀${id}`, voice: `聲音${id}`, lang: 'ja', images: [], warn: [] };
  };
  const m = sheetModule({ api });
  m.s.load({ segments: [{ beats: [{ from: 0, to: 2, action: 'x', who: 'S2' }, { from: 2, to: 4, action: 'y', who: 'S1' }] }],
             refs: { on: true, items: [{ file: 'r.png', who: 'S3' }] } });
  for (const id of [1, 2, 3]) await m.s.addCast({ id, name: `角色${id}`, kind: 'char', data: { look_en: `look${id}` } });
  const cast = m.s.current().cast;
  assert.deepEqual(plain(cast.map((c) => c.speaker)), ['S1', 'S2', 'S3']);
  assert.equal(cast[1].look_zh, '外觀2');
  assert.equal(cast[1].look_en, 'look2');
  assert.equal(cast[1].voice, '聲音2');
  assert.equal(cast[1].asset_id, 2);
  m.s.removeCast(0);
  const after = m.s.current();
  assert.deepEqual(plain(after.cast.map((c) => [c.speaker, c.name])), [['S1', '角色2'], ['S2', '角色3']]);
  assert.deepEqual(plain(after.segments[0].beats.map((b) => b.who)), ['S1', '']);
  assert.equal(after.refs.items[0].who, 'S2');
  // 最多 4 個
  for (const id of [4, 5, 6]) await m.s.addCast({ id, name: `角色${id}`, kind: 'char', data: {} });
  assert.equal(m.s.current().cast.length, 4);
});

test('locked_cast_uses_spec_and_binds_portrait_sheet_refs', async () => {
  const toInput = [];
  const api = async (url, opts) => {
    const id = Number(url.match(/assets\/(\d+)/)[1]);
    if (url.endsWith('/to_input')) { toInput.push(opts.json.file); return { name: `aw_${opts.json.file}`, width: 512, height: 768 }; }
    if (id === 7) return { text: 'TAGS', locked: true, spec: { zh: '女性，橘髮。', en: 'female, orange hair.', tags: '1girl' }, images: ['7_1.png', '7_2.png'], voice: 'v', lang: 'ja', warn: [], refmod: 'paintdeck/pd_char_7' };
    return { text: '外觀8', images: ['8_1.png'], voice: '', lang: '', warn: [], locked: false };
  };
  const m = sheetModule({ api });
  m.s.load({ segments: [{}], refs: { on: false, items: [{ file: 'mine.png', who: '' }] } });
  await m.s.addCast({ id: 8, name: '乙', kind: 'char', data: { look_en: 'a man' } });
  await m.s.addCast({ id: 7, name: '甲', kind: 'char', data: { look_en: 'OLD' } });
  const S = m.s.current();
  assert.deepEqual(plain(S.cast.map((c) => [c.speaker, c.locked, c.look_zh, c.look_en])),
    [['S1', false, '外觀8', 'a man'], ['S2', true, '女性，橘髮。', 'female, orange hair.']]);
  assert.equal(S.refs.on, true, '鎖定角色的圖一定要送');
  assert.deepEqual(plain(S.cast.map((c) => c.refmod)), ['', 'paintdeck/pd_char_7'], '只有鎖定角色記 RefMod');
  assert.deepEqual(plain(S.refs.items), [{ file: 'mine.png', asset_id: null, who: '' },
    { file: 'aw_7_1.png', asset_id: 7, who: 'S2' }, { file: 'aw_7_2.png', asset_id: 7, who: 'S2' }]);
  assert.deepEqual(toInput, ['7_1.png', '7_2.png'], '沒鎖的角色不自動放圖');
  // 拿掉鎖定角色：它自動放的參考圖一起拿掉，別人的留著
  m.s.removeCast(1);
  assert.deepEqual(plain(m.s.current().refs.items.map((r) => r.file)), ['mine.png']);
  // 參考圖快滿：放得下幾張放幾張
  const m2 = sheetModule({ api });
  m2.s.load({ segments: [{}], refs: { on: true, items: Array.from({ length: 7 }, (_, k) => ({ file: `r${k}.png` })) } });
  await m2.s.addCast({ id: 7, name: '甲', kind: 'char', data: {} });
  assert.equal(m2.s.current().refs.items.length, 8);
  assert.equal(m2.s.current().refs.items[7].file, 'aw_7_1.png');
  // 存檔再讀回：locked 留著
  m2.s.load(plain(m2.s.current()));
  assert.equal(m2.s.current().cast[0].locked, true);
});

test('compose_puts_locked_head_back_into_manual_prompts', async () => {
  const api = async () => ({ segments: [{ prompt: 'new1', mirror: 'm1', kept: 'HEAD 手改的', kept_mirror: 'HEAD mine' }], estimate: [] });
  const m = sheetModule({ api });
  m.s.load({ segments: [{ prompt: '手改的', mirror: 'mine', manual: true }] });
  await m.s.composeNow();
  const seg = m.s.current().segments[0];
  assert.deepEqual([seg.prompt, seg.mirror, seg.manual], ['HEAD 手改的', 'HEAD mine', true]);
});

test('framepick_ignores_other_jobs', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/framepick.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const nodes = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, element('div')); return nodes.get(id); };
  const calls = [];
  const api = async (url, opts) => {
    calls.push([url, opts.json]);
    if (url === '/api/generate') return { jobs: [{ job: 'a' }, { job: 'b' }] };
    if (url === '/api/to_input') return { name: 'picked.png', width: 832, height: 1216 };
    throw new Error(url);
  };
  const toasts = [];
  const context = vm.createContext({ structuredClone, console, api, el: element, toast: (m) => toasts.push(m), openModal() {}, closeModal() {},
    gen: { collectParams: () => ({ mode: 'img2img', seed: 123, width: 832, height: 1216, prompt: 'x' }) },
    document: { getElementById: node, addEventListener() {} } });
  vm.runInContext(source + '\nglobalThis.subject = { pick, onImage, choose: (k) => choose(run.recs[k]) };', context, { filename: 'framepick.js' });
  const fp = context.subject;
  const picking = fp.pick({ count: 9 });
  await new Promise(setImmediate);
  assert.equal(calls[0][0], '/api/generate');
  assert.equal(calls[0][1].count, 8, '最多 8 張');
  assert.equal(calls[0][1].params.mode, 'txt2img');
  assert.equal(calls[0][1].params.seed, -1);
  fp.onImage('zzz', { id: 9 });
  assert.equal(node('fpGrid').children.length, 0);
  fp.onImage('a', { id: 1 });
  fp.onImage('b', { id: 2 });
  const cells = node('fpGrid').children;
  assert.equal(cells.length, 2);
  assert.deepEqual(cells.map((c) => c.children[0].children[0]), ['1', '2']);
  await fp.choose(1);
  const r = await picking;
  assert.equal(r.name, 'picked.png');
  assert.equal(r.gallery_id, 2);
  assert.deepEqual(plain(calls[1]), ['/api/to_input', { id: 2 }]);
  // 沒連線：toast、回 null
  const bad = vm.createContext({ ...context, api: async () => { throw new Error('ComfyUI 沒連線'); } });
  vm.runInContext(source + '\nglobalThis.subject = { pick };', bad, { filename: 'framepick.js' });
  assert.equal(await bad.subject.pick({}), null);
  assert.ok(toasts.some((m) => m.includes('沒連線')));
});

function chainModule({ api, confirmAnswer }) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/h3chain.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const asked = [];
  const context = vm.createContext({ structuredClone, console, setTimeout, clearTimeout, api, el: element, toast() {},
    store: { get: (k, d) => d, set() {} }, pickFromGallery() {}, openLightboxRecord() {},
    confirm: (m) => { asked.push(m); return confirmAnswer; },
    document: { getElementById: () => element('div'), addEventListener() {} } });
  vm.runInContext(source + '\nglobalThis.subject = { applySheet, setChain: (c) => { chain = c; } };', context, { filename: 'h3chain.js' });
  context.loadList = async () => {};  // 畫面重讀不在這裡測
  return { c: context.subject, asked };
}
const sheet3 = { title: '三段測試', segments: [{ secs: 10 }, { secs: 8 }, { secs: 12 }] };

test('apply_long_keeps_shot_chain_safe', async () => {
  const calls = [];
  const m = chainModule({ api: async (url, o) => { calls.push([url, o?.json]); return { id: 'new' }; }, confirmAnswer: false });
  m.c.setChain({ id: 'old', title: '拍過的', segments: [{ status: 'done', text: 'a' }, { status: 'todo', text: 'b' }] });
  assert.equal(await m.c.applySheet({ sheet: sheet3, prompts: ['p1', 'p2', 'p3'], first: 'f.png', refs: [] }), false);
  assert.equal(calls.length, 0, '答不要就不存');
  assert.match(m.asked[0], /拍好/);
  // 答要：另存一條新的（不帶舊 id）
  const m2 = chainModule({ api: async (url, o) => { calls.push([url, o?.json]); return { id: 'new' }; }, confirmAnswer: true });
  m2.c.setChain({ id: 'old', title: '拍過的', segments: [{ status: 'done', text: 'a' }] });
  assert.equal(await m2.c.applySheet({ sheet: sheet3, prompts: ['p1', 'p2', 'p3'] }), true);
  assert.equal(calls[0][0], '/api/h3/chain/save');
  assert.equal(calls[0][1].chain.id, undefined);
});

test('apply_long_writes_text_and_sheet', async () => {
  const calls = [];
  const m = chainModule({ api: async (url, o) => { calls.push([url, o?.json]); return { id: 'c1' }; }, confirmAnswer: true });
  m.c.setChain({ id: 'c1', title: '空的', look: 'old look', scene: 'old', ref: 'old.png', segments: [{ status: 'todo', text: '' }] });
  assert.equal(await m.c.applySheet({ sheet: sheet3, prompts: ['p1', 'p2', 'p3'], first: 'f.png', refs: ['r1.png'] }), true);
  assert.equal(m.asked.length, 0, '沒拍過的不問');
  const [url, body] = calls[0];
  assert.equal(url, '/api/h3/chain/save');
  const c = body.chain;
  assert.equal(c.id, 'c1');
  assert.deepEqual(plain(c.segments.map((s) => [s.text, s.secs])), [['p1', 10], ['p2', 8], ['p3', 12]]);
  assert.equal(c.segments[1].lines.length, 0);
  assert.equal(c.sheet.title, '三段測試');
  assert.equal(c.first, 'f.png');
  assert.deepEqual(plain(c.refs), ['r1.png']);
  assert.equal(c.look, '');
  assert.equal(c.scene, '');
  assert.equal(c.ref, null);
});


test('late compose cannot overwrite a loaded draft', async () => {
  let finish;
  const m = sheetModule({api: () => new Promise(r => finish = r)});
  m.s.load({segments:[{prompt:'A'}]});
  const pending = m.s.composeNow();
  m.s.load({segments:[{prompt:'B'}]});
  finish({segments:[{prompt:'late A',mirror:''}]});
  await pending;
  assert.equal(m.s.current().segments[0].prompt,'B');
});
test('sound-only segment requires confirmation before removal', () => {
  const m = sheetModule({confirmAnswer:false});
  m.s.load({segments:[{}, {beats:[{from:0,to:2,sfx:'door'}]}]});
  assert.equal(m.s.setSegCount(1),false);
});
test('precheck uses the supplied applied sheet', async () => {
  let sent;
  const m = sheetModule({api:async (url,opts) => {sent=opts.json;return {issues:[]};}});
  m.s.load({title:'draft'});
  await m.s.precheck(['text'], {title:'applied',segments:[{}]});
  assert.equal(sent.sheet.title,'applied');
});

test('shrink_does_not_ask_for_auto_composed_prompts', async () => {
  // 程式自己組的提示詞（沒手改）隨時能重組，不算使用者寫的東西
  const api = async () => ({ segments: [{ prompt: 'p1', mirror: 'm1' }, { prompt: 'p2', mirror: 'm2' }, { prompt: 'p3', mirror: 'm3' }], estimate: [] });
  const m = sheetModule({ api, confirmAnswer: false });
  m.s.load({ segments: [{}, {}, {}] });
  await m.s.composeNow();
  assert.equal(m.s.current().segments[2].prompt, 'p3');
  assert.equal(m.s.setSegCount(2), true);
  assert.equal(m.asked.length, 0);
  assert.equal(m.s.current().segments.length, 2);
});

test('segment_ref_off_reaches_long_film_and_short', async () => {
  const api = async () => ({ segments: [{ prompt: 'p1', mirror: 'm1' }, { prompt: 'p2', mirror: 'm2' }], estimate: [] });
  let got = null;
  const h3chain = { applySheet: async (o) => { got = o; return true; } };
  const m = sheetModule({ api, extras: { h3chain } });
  m.s.load({ engine: 'h3', refs: { on: true, items: [{ file: 'r1.png', who: 'S1' }, { file: 'r2.png', who: 'S2' }] },
    segments: [{ secs: 10, ref_off: ['r1.png', 7] }, { secs: 10 }] });
  assert.deepEqual(plain(m.s.current().segments.map((x) => x.ref_off)), [['r1.png'], []], '不是字串的丟掉；舊草稿沒有就是空的');
  await m.s.applyTo();
  assert.deepEqual(plain(got.refs), ['r1.png', 'r2.png'], '整條照舊帶全部');
  assert.deepEqual(plain(got.segRefs), [['r2.png'], null], '有關掉的段才帶自己的，沒關的照用整條的');
  // 單段：送去短片的就是這段實際要送的
  let short = null;
  const m2 = sheetModule({ api: async () => ({ segments: [{ prompt: 'p1', mirror: 'm1' }], estimate: [] }), extras: { h3: { applySheet: async (o) => { short = o; } } } });
  m2.s.load({ engine: 'h3', refs: { on: true, items: [{ file: 'r1.png' }, { file: 'r2.png' }] }, segments: [{ secs: 10, ref_off: ['r2.png'] }] });
  await m2.s.applyTo();
  assert.deepEqual(plain(short.refs), ['r1.png']);
});

test('apply_long_writes_segment_refs_only_where_picked', async () => {
  const calls = [];
  const m = chainModule({ api: async (url, o) => { calls.push([url, o?.json]); return { id: 'c1' }; }, confirmAnswer: true });
  m.c.setChain({ id: 'c1', title: '空的', segments: [{ status: 'todo', text: '' }] });
  assert.equal(await m.c.applySheet({ sheet: sheet3, prompts: ['p1', 'p2', 'p3'], refs: ['r1.png', 'r2.png'], segRefs: [null, ['r2.png'], []] }), true);
  const segs = calls[0][1].chain.segments;
  assert.equal('refs' in segs[0], false);
  assert.deepEqual(plain(segs[1].refs), ['r2.png']);
  assert.deepEqual(plain(segs[2].refs), []);
});
