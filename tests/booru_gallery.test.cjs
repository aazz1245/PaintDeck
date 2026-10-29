const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const el = () => ({
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange() {},
    focus() {},
    dispatchEvent() {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
  });

  const mainPromptEl = el();
  mainPromptEl.id = 'prompt';

  const prefixPromptEl = el();
  prefixPromptEl.id = 'promptPrefix';

  const suffixPromptEl = el();
  suffixPromptEl.id = 'promptSuffix';

  const nodes = {
    '#prompt': mainPromptEl,
    '#promptPrefix': prefixPromptEl,
    '#promptSuffix': suffixPromptEl,
    '#booruSource': { value: 'safebooru', append() {}, innerHTML: '' },
    '#booruStatus': { textContent: '', classList: { toggle() {} } },
    '#booruGrid': { innerHTML: '', append() {}, classList: { add() {}, remove() {} } },
  };

  const toasts = [];
  const appendCalls = [];

  const utilMock = {
    $: (sel) => nodes[sel] || null,
    $$: () => [],
    el: (tag, attrs = {}, ...kids) => ({
      tag,
      attrs,
      kids,
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      append() {},
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 200, bottom: 200, width: 100, height: 100 }),
    }),
    toast: (msg, type) => { toasts.push({ msg, type }); },
    uploadFile: async () => ({ name: 'test.png', width: 512, height: 512 }),
    store: { get: () => 500, set: () => {} },
  };

  const genMock = {
    appendPrompt: (text, targetTa) => {
      appendCalls.push({ text, targetTa });
      if (targetTa) {
        targetTa.value = targetTa.value ? `${targetTa.value}, ${text}` : text;
      }
      return true;
    },
    setInit: () => {},
    setMode: () => {},
    refs: { add: () => {} },
    S: {},
  };

  const documentMock = {
    body: {
      append() {},
      contains: () => true,
    },
    documentElement: { style: { setProperty() {} } },
    addEventListener() {},
    removeEventListener() {},
  };

  const windowMock = {
    innerWidth: 1920,
    innerHeight: 1080,
    open() {},
    navigator: { clipboard: { writeText: async () => {} } },
  };

  const source = fs.readFileSync(path.join(__dirname, '../ui/js/booru.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '');

  const context = vm.createContext({
    ...utilMock,
    ...genMock,
    document: documentMock,
    window: windowMock,
    Image: class { constructor() { setTimeout(() => this.onload?.(), 10); } },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: () => {},
  });
  context.globalThis = context;

  vm.runInContext(source + '\nglobalThis.subject = { extractPromptTags, ratingBadge, addPostPromptToMain, detailCache };', context, { filename: 'booru.js' });
  return { ...context.subject, mainPromptEl, appendCalls, toasts };
}

test('extractPromptTags：按角色、作品、畫師、常規標籤順序提取並排除浮水印等噪音', () => {
  const h = harness();
  const detail = {
    tags: {
      character: ['frieren', 'fern'],
      copyright: ['frieren_(series)'],
      artist: ['artist_name'],
      general: ['1girl', 'solo', 'white_hair', 'watermark', 'signature'],
      meta: ['highres', 'absurdres'],
    },
  };

  const tags = h.extractPromptTags(detail);
  assert.deepEqual([...tags], [
    'frieren',
    'fern',
    'frieren_(series)',
    'artist_name',
    '1girl',
    'solo',
    'white_hair',
  ]);
  assert.equal(tags.includes('watermark'), false);
  assert.equal(tags.includes('signature'), false);
});

test('ratingBadge：正確回傳全年齡、微澀、R15與R18樣式級別', () => {
  const h = harness();
  assert.deepEqual({ ...h.ratingBadge('general') }, { text: 'SFW', cls: 'sfw' });
  assert.deepEqual({ ...h.ratingBadge('sensitive') }, { text: 'Sens', cls: 'sens' });
  assert.deepEqual({ ...h.ratingBadge('questionable') }, { text: 'R15', cls: 'quest' });
  assert.deepEqual({ ...h.ratingBadge('explicit') }, { text: 'R18', cls: 'nsfw' });
});

test('addPostPromptToMain：點選圖片直接將標籤填入主體提示詞框（#prompt）', async () => {
  const h = harness();
  const post = { source: 'safebooru', postId: '12345' };
  const detail = {
    tags: {
      character: ['rem_(re:zero)'],
      copyright: ['re:zero'],
      artist: [],
      general: ['1girl', 'blue_hair', 'maid'],
    },
  };
  h.detailCache.set('safebooru:12345', detail);

  const cardMock = {
    classList: {
      add(cls) { this[cls] = true; },
      remove(cls) { this[cls] = false; },
    },
  };

  await h.addPostPromptToMain(post, cardMock);

  assert.equal(h.appendCalls.length, 1);
  assert.equal(h.appendCalls[0].targetTa, h.mainPromptEl);
  assert.equal(h.appendCalls[0].text, 'rem_(re:zero), re:zero, 1girl, blue_hair, maid');
  assert.equal(h.mainPromptEl.value, 'rem_(re:zero), re:zero, 1girl, blue_hair, maid');
  assert.equal(h.toasts.some((t) => t.msg.includes('加入主體提示詞框')), true);
});
