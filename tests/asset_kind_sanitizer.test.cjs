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

test('assets.js: KINDS 僅包含 10 種標準資產類型，少女/蘿莉等為 SNIPPET_FOLDERS（片段子選項）', () => {
  const sub = moduleContext('assets.js', {
    api: () => {}, el: element, $: () => element('div'), $$: () => [], toast: () => {},
    library: {}, document: { getElementById: () => element('div'), addEventListener() {}, body: element('body') },
  }, 'KINDS, SNIPPET_FOLDERS, VALID_BACKEND_KINDS, VALID_MEDIA_KINDS');

  const kindsKeys = sub.KINDS.map(([k]) => k).sort();
  const expectedKinds = ['char', 'frame', 'fx', 'outfit', 'prop', 'scene', 'set', 'shot', 'snippet', 'sound'].sort();
  assert.equal(JSON.stringify(kindsKeys), JSON.stringify(expectedKinds), '頂層 KINDS 應純粹為 10 種資產類型');

  const snippetFolderKeys = sub.SNIPPET_FOLDERS.map(([k]) => k);
  assert.ok(snippetFolderKeys.includes('少女'));
  assert.ok(snippetFolderKeys.includes('萝莉'));
  assert.ok(snippetFolderKeys.includes('假小子'));
  assert.ok(snippetFolderKeys.includes('肉感'));
  assert.ok(snippetFolderKeys.includes('厚涂'));
  assert.ok(snippetFolderKeys.includes('强烈质感设计'));
  assert.ok(snippetFolderKeys.includes('后缀'));
  assert.ok(snippetFolderKeys.includes('anima'));
});

test('assets.js: 提示詞片段（snippet）點選時，產生片段子選項晶片（全部片段、少女、蘿莉…）', () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element('input'));
    return nodes.get(id);
  };
  const mockItems = [
    { id: 1, kind: 'snippet', name: 'A', folder: '少女' },
    { id: 2, kind: 'snippet', name: 'B', folder: '萝莉' },
    { id: 3, kind: 'char', name: 'C', folder: '' }
  ];
  const sub = moduleContext('assets.js', {
    api: () => Promise.resolve(mockItems), el: element, $: node, $$: () => [], toast: () => {},
    library: {}, document: { getElementById: node, addEventListener() {}, body: element('body') },
  }, 'paintKinds: () => paintKinds(), setKind: (k) => { kind = k; }, setItems: (it) => { items = it; }');

  sub.setItems(mockItems);
  sub.setKind('snippet');
  sub.paintKinds();

  const asKindsBox = node('asKinds');
  assert.equal(asKindsBox.children.length, 2, '應包含主選項列與子選項列');
  const subKindsRow = asKindsBox.children[1];
  assert.ok(subKindsRow.children.length > 2, '子選項列應包含全部片段以及對應資料夾按鈕');
});

test('assets.js: 在提示詞片段子選項下點「+ 新增」，調用 library.saveDialog 存成片段，不被當作資產保存', () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element('input'));
    return nodes.get(id);
  };
  let saveDialogArgs = null;
  const sub = moduleContext('assets.js', {
    api: () => Promise.resolve([]), el: element, $: node, $$: () => [], toast: () => {},
    library: { saveDialog: (args) => { saveDialogArgs = args; } },
    document: { getElementById: node, addEventListener() {}, body: element('body') },
  }, 'newOne, setKind: (k) => { kind = k; }, setSnippetFolder: (f) => { snippetFolder = f; }, current: () => cur');

  sub.setKind('snippet');
  sub.setSnippetFolder('少女');
  sub.newOne();

  assert.ok(saveDialogArgs, '應調用提示詞庫的 saveDialog 彈窗');
  assert.equal(saveDialogArgs.kind, 'snippet');
  assert.equal(saveDialogArgs.folder, '少女');
  assert.equal(sub.current(), null, '不應建立媒體資產編輯實例');
});

test('assets.js: 新增資產未輸入名字時點「+ 從電腦」，自動以圖檔名命名，不跳「資產要有名字」錯誤', async () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element('input'));
    return nodes.get(id);
  };
  node('asForm').querySelectorAll = () => [...nodes.values()].filter((e) => e !== node('asForm'));

  const savedCalls = [];
  const toastErrors = [];
  const sub = moduleContext('assets.js', {
    api: (url, opts) => {
      if (url === '/api/lib') {
        savedCalls.push(opts.json);
        return Promise.resolve({ id: 101, ...opts.json });
      }
      if (url.includes('/file')) {
        return Promise.resolve({ id: 101, ...savedCalls[0], data: { images: [{ file: '101_1.png', role: 'src' }] } });
      }
      return Promise.resolve({});
    },
    pickFile: () => Promise.resolve({ name: 'cute_girl.png' }),
    uploadFile: () => Promise.resolve({ name: 'cute_girl.png' }),
    toast: (msg, type) => { if (type === 'err') toastErrors.push(msg); },
    el: element, $: node, $$: () => [],
    library: {}, document: { getElementById: node, addEventListener() {}, body: element('body') },
  }, 'init, newOne, current: () => cur');

  sub.init();
  sub.newOne();
  assert.equal(node('asName').value, '');

  await node('asImgUp').onclick();

  assert.equal(toastErrors.length, 0, '不應彈出「資產要有名字」的錯誤訊息');
  assert.equal(node('asName').value, 'cute_girl', '應自動從檔名取得並填入資產名字');
  assert.equal(savedCalls.length, 1);
  assert.equal(savedCalls[0].name, 'cute_girl');
});
