// node --test tests/library_thumb_upload.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(tag, attrs = {}, ...children) {
  const el = Object.assign({
    tag, value: '', checked: false, disabled: false, children, hidden: false,
    style: {},
    options: [],
    classList: { add() {}, remove() {}, toggle() {} }, focus() {}, select() {}, remove() {},
    append(...kids) {
      this.children.push(...kids);
      for (const k of kids) {
        if (k.tag === 'option') this.options.push(k);
        if (k.options) this.options.push(...k.options);
      }
    },
    replaceChildren(...kids) { this.children = kids; this.options = []; },
    addEventListener(evt, fn) { this['on' + evt] = fn; },
    dispatchEvent() {}, querySelectorAll() { return []; },
    closest() { return null; }
  }, attrs);
  return el;
}

function moduleContext(file, globals, exposed) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ structuredClone, console, Event, ...globals });
  vm.runInContext(source + `\nglobalThis.subject = {${exposed}};`, context, { filename: file });
  return context.subject;
}

test('index.html: 包含從電腦上傳按鈕 leThumbUp', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  assert.ok(html.includes('id="leThumbUp"'), '提示詞庫編輯對話框應包含 id="leThumbUp" 按鈕');
  assert.ok(html.includes('從電腦上傳'), '按鈕文字應為「從電腦上傳」');
});

test('library.js: 點擊 leThumbUp 可從電腦選圖並上傳設置為預覽圖，且為空時自動填入檔名', async () => {
  const nodes = new Map();
  const node = (rawId) => {
    const id = String(rawId).replace(/^#/, '');
    if (!nodes.has(id)) nodes.set(id, element('div', { id }));
    return nodes.get(id);
  };

  const apiCalls = [];
  const toastMsgs = [];
  let filePicked = { name: 'super_waifu.png' };

  const sub = moduleContext('library.js', {
    api: (url, opts) => {
      apiCalls.push({ url, opts });
      if (url === '/api/play/save_grid') {
        return Promise.resolve({ id: 555, filename: 'xy_waifu.png' });
      }
      if (url === '/api/lib') {
        return Promise.resolve({ id: 888, ...opts.json, has_thumb: 1 });
      }
      return Promise.resolve([]);
    },
    pickFile: () => Promise.resolve(filePicked),
    makeDrop: (zone, fn) => { zone.ondrop_fn = fn; },
    toast: (msg, type) => toastMsgs.push({ msg, type }),
    store: { get: () => ({}), set() {} },
    openModal() {}, closeModal() {}, debounce: (fn) => fn,
    pickFromGallery() {},
    app: { state: { models: {} } },
    $: node, $$: () => [], el: element,
    document: {
      documentElement: { lang: 'zh-CN' },
      addEventListener() {},
      dispatchEvent() {},
      getElementById: node,
      body: element('body')
    },
    FormData: class {
      constructor() { this.fields = {}; }
      append(k, v) { this.fields[k] = v; }
    }
  }, 'init, saveDialog, saveEdit: () => saveEdit(), state: () => ({ E, items })');

  const mockCtx = {
    current: () => null,
    collect: () => ({}),
    family: () => 'any',
    famOf: () => 'any',
  };

  sub.init(mockCtx);
  sub.saveDialog({ kind: 'snippet', data: { text: '1girl, blonde hair' } });

  // 初始狀態沒有縮圖
  const thumbEl = node('leThumb');
  assert.equal(thumbEl.style.backgroundImage || '', '');

  // 清空名稱測試自動命名
  node('leName').value = '';

  // 點擊「從電腦上傳」
  const thumbUpBtn = node('leThumbUp');
  assert.ok(typeof thumbUpBtn.onclick === 'function', 'leThumbUp 應綁定 onclick 處理器');
  await thumbUpBtn.onclick();

  // 驗證上傳呼叫
  const uploadCall = apiCalls.find((c) => c.url === '/api/play/save_grid');
  assert.ok(uploadCall, '應調用 /api/play/save_grid 上傳本機圖片');
  assert.equal(uploadCall.opts.method, 'POST');

  // 驗證名稱自動填入（如果原名稱為空）
  assert.equal(node('leName').value, 'super_waifu', '若名稱未填寫，應自動填入檔名');

  // 驗證預覽圖已更新為 /thumb/555
  assert.equal(thumbEl.style.backgroundImage, 'url("/thumb/555")', '預覽區應即時更新為新上傳圖片的縮圖');

  // 驗證保存時傳入 image_id
  await sub.saveEdit();
  const saveCall = apiCalls.find((c) => c.url === '/api/lib' && c.opts?.json?.kind === 'snippet');
  assert.ok(saveCall, '應調用 /api/lib 保存片段');
  assert.equal(saveCall.opts.json.image_id, 555, '保存 payload 應包含已上傳圖片的 image_id');
});

test('library.js: 支援將本機圖片直接拖放至縮圖預覽框', async () => {
  const nodes = new Map();
  const node = (rawId) => {
    const id = String(rawId).replace(/^#/, '');
    if (!nodes.has(id)) nodes.set(id, element('div', { id }));
    return nodes.get(id);
  };

  const apiCalls = [];
  const sub = moduleContext('library.js', {
    api: (url, opts) => {
      apiCalls.push({ url, opts });
      if (url === '/api/play/save_grid') {
        return Promise.resolve({ id: 777 });
      }
      return Promise.resolve([]);
    },
    pickFile: () => Promise.resolve(null),
    makeDrop: (zone, fn) => { zone.ondrop_fn = fn; },
    toast: () => {},
    store: { get: () => ({}), set() {} },
    openModal() {}, closeModal() {}, debounce: (fn) => fn,
    pickFromGallery() {},
    app: { state: { models: {} } },
    $: node, $$: () => [], el: element,
    document: {
      documentElement: { lang: 'zh-CN' },
      addEventListener() {},
      dispatchEvent() {},
      getElementById: node,
      body: element('body')
    },
    FormData: class {
      constructor() { this.fields = {}; }
      append(k, v) { this.fields[k] = v; }
    }
  }, 'init, saveDialog, state: () => ({ E, items })');

  sub.init({ current: () => null, collect: () => ({}), family: () => 'any', famOf: () => 'any' });
  sub.saveDialog({ kind: 'snippet', data: { text: 'test drag drop' } });

  const thumbBox = node('leThumb');
  assert.ok(typeof thumbBox.ondrop_fn === 'function', '縮圖預覽框應支援 makeDrop 拖放圖片');

  await thumbBox.ondrop_fn({ name: 'drop_image.jpg' });

  const uploadCall = apiCalls.find((c) => c.url === '/api/play/save_grid');
  assert.ok(uploadCall, '拖放後應調用 /api/play/save_grid');
  assert.equal(thumbBox.style.backgroundImage, 'url("/thumb/777")');
});
