// node --test tests/asset_kind_sanitizer.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(tag, attrs = {}, ...children) {
  return Object.assign({
    tag, value: '', checked: false, disabled: false, children, hidden: false,
    classList: { add() {}, toggle() {} }, focus() {}, remove() {},
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener() {}, dispatchEvent() {}, querySelectorAll() { return []; },
  }, attrs);
}

function moduleContext(file, globals, exposed) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ structuredClone, console, Event, ...globals });
  vm.runInContext(source + `\nglobalThis.subject = {${exposed}};`, context, { filename: file });
  return context.subject;
}

test('assets.js: VALID_BACKEND_KINDS 和 VALID_MEDIA_KINDS 定義正確，且不包含非標準分類', () => {
  const sub = moduleContext('assets.js', {
    api: () => {}, el: element, $: () => element('div'), $$: () => [], toast: () => {},
    library: {}, document: { getElementById: () => element('div'), addEventListener() {}, body: element('body') },
  }, 'VALID_BACKEND_KINDS, VALID_MEDIA_KINDS, KINDS');

  const backendKinds = Array.from(sub.VALID_BACKEND_KINDS).sort();
  const mediaKinds = sub.VALID_MEDIA_KINDS;

  // 驗證後端白名單只有 Rust 允許的 10 種
  const expectedBackend = ['char', 'frame', 'fx', 'outfit', 'prop', 'scene', 'set', 'shot', 'snippet', 'sound'].sort();
  assert.deepEqual(backendKinds, expectedBackend);

  // 驗證自定義資料夾如「少女」、「萝莉」不在 VALID_BACKEND_KINDS 和 VALID_MEDIA_KINDS 中
  assert.equal(sub.VALID_BACKEND_KINDS.has('少女'), false);
  assert.equal(sub.VALID_BACKEND_KINDS.has('萝莉'), false);
  assert.equal(mediaKinds.has('少女'), false);
  assert.equal(mediaKinds.has('萝莉'), false);
});

test('assets.js: init() 產生的 asKind 下拉選單只包含有效的媒體類型', () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element('input'));
    return nodes.get(id);
  };
  const sub = moduleContext('assets.js', {
    api: () => {}, el: element, $: node, $$: () => [], toast: () => {},
    library: {}, document: { getElementById: node, addEventListener() {}, body: element('body') },
  }, 'init, VALID_MEDIA_KINDS');

  sub.init();
  const options = node('asKind').children;
  assert.ok(options.length > 0);
  for (const opt of options) {
    assert.equal(sub.VALID_MEDIA_KINDS.has(opt.value), true, `選項 ${opt.value} 應該在 VALID_MEDIA_KINDS 中`);
  }
});

test('assets.js: 在自訂分類（如「少女」）下 newOne()，預設 kind 為 char 且 folder 為「少女」', () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element('input'));
    return nodes.get(id);
  };
  const sub = moduleContext('assets.js', {
    api: () => {}, el: element, $: node, $$: () => [], toast: () => {},
    library: {}, document: { getElementById: node, addEventListener() {}, body: element('body') },
  }, 'newOne, fill, current: () => cur, setKind: (k) => { kind = k; }');

  sub.setKind('少女');
  sub.newOne();
  const cur = sub.current();
  assert.equal(cur.kind, 'char');
  assert.equal(cur.folder, '少女');
  assert.equal(node('asKind').value, 'char');
  assert.equal(node('asFolder').value, '少女');
});

test('assets.js: collect() 自動過濾非標準 kind，轉為 char 並保全 folder', async () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element('input'));
    return nodes.get(id);
  };
  node('asForm').querySelectorAll = () => [...nodes.values()].filter((e) => e !== node('asForm'));

  let sentPayload = null;
  const sub = moduleContext('assets.js', {
    api: (url, opts) => { sentPayload = opts.json; return Promise.resolve({ id: 99, ...opts.json }); },
    el: element, $: node, $$: () => [], toast: () => {},
    library: {}, document: { getElementById: node, addEventListener() {}, body: element('body') },
  }, 'save, newOne, current: () => cur, setKind: (k) => { kind = k; }');

  sub.setKind('少女');
  sub.newOne();
  node('asName').value = '野生的大魔王';
  // 假設前端意外帶了非法 kind
  node('asKind').value = '少女';
  node('asFolder').value = '';
  node('asAnima').value = '@yahako';

  await sub.save();

  assert.ok(sentPayload);
  assert.equal(sentPayload.kind, 'char', '非法 kind「少女」必須被自動清洗為合法的「char」');
  assert.equal(sentPayload.folder, '少女', '原本的「少女」必須被保留在 folder 欄位');
  assert.equal(sentPayload.name, '野生的大魔王');
});
