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

  const promptModal = { hidden: true };
  const settingsModal = { hidden: true };

  const nodes = {
    '#prompt': mainPromptEl,
    '#promptPrefix': prefixPromptEl,
    '#promptSuffix': suffixPromptEl,
    '#booruSource': { value: 'danbooru', append() {}, innerHTML: '' },
    '#booruStatus': { textContent: '', classList: { toggle() {} } },
    '#booruGrid': { innerHTML: '', append() {}, classList: { add() {}, remove() {} } },
    '#booruPromptModal': promptModal,
    '#booruSettingsModal': settingsModal,
    '#booruCatChar': { checked: false },
    '#booruCatCopy': { checked: false },
    '#booruCatArt': { checked: false },
    '#booruCatGen': { checked: false },
    '#booruCatMeta': { checked: false },
    '#booruReplaceUnderscores': { checked: false },
    '#booruEscapeParentheses': { checked: false },
    '#booruPromptBlacklist': { value: '' },
  };

  const toasts = [];
  const appendCalls = [];
  const removeCalls = [];

  const utilMock = {
    $: (sel) => nodes[sel] || null,
    $$: () => [],
    el: (tag, attrs = {}, ...kids) => {
      const initialClass = typeof attrs === 'string' ? attrs : (attrs?.class || attrs?.className || '');
      const classListObj = {
        add(cls) { this[cls] = true; },
        remove(cls) { this[cls] = false; },
        toggle(cls, force) { this[cls] = force !== undefined ? !!force : !this[cls]; },
        contains(cls) { return !!this[cls]; },
      };
      initialClass.split(/\s+/).filter(Boolean).forEach((c) => { classListObj[c] = true; });
      return {
        tag,
        attrs,
        kids,
        style: {},
        classList: classListObj,
        addEventListener() {},
        append() {},
        querySelector() { return null; },
        remove() {},
        getBoundingClientRect: () => ({ left: 100, top: 100, right: 200, bottom: 200, width: 100, height: 100 }),
      };
    },
    toast: (msg, type) => { toasts.push({ msg, type }); },
    uploadFile: async () => ({ name: 'test.png', width: 512, height: 512 }),
    store: {
      data: new Map(),
      get(k, fallback) { return this.data.has(k) ? this.data.get(k) : fallback; },
      set(k, v) { this.data.set(k, v); },
    },
  };

  const genMock = {
    appendPrompt: (text, targetTa) => {
      appendCalls.push({ text, targetTa });
      if (targetTa) {
        targetTa.value = targetTa.value ? `${targetTa.value}, ${text}` : text;
      }
      return true;
    },
    removePrompt: (text) => {
      removeCalls.push(text);
      const toRemove = new Set(
        (Array.isArray(text) ? text : [text])
          .flatMap((x) => (typeof x === 'string' ? x.split(',') : []))
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      );
      const curParts = mainPromptEl.value.split(',').map((s) => s.trim()).filter(Boolean);
      mainPromptEl.value = curParts.filter((s) => !toRemove.has(s.toLowerCase())).join(', ');
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

  vm.runInContext(
    source + '\nglobalThis.subject = { extractPromptTags, ratingBadge, togglePostPrompt, addPostPromptToMain, setSelectionMode, clearSelection, openPromptConfigDialog, openSettingsDialog, state, promptConfig, detailCache, SELECTION_STAMPS, STAMP_LABELS, createSelectionStamp, setSelectionStamp, parseTagLines };',
    context,
    { filename: 'booru.js' }
  );
  return { ...context.subject, mainPromptEl, appendCalls, removeCalls, toasts, promptModal, settingsModal };
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

test('extractPromptTags：支援替換底線為空格與轉義括號', () => {
  const h = harness();
  const detail = {
    tags: {
      character: ['rem_(re:zero)'],
      copyright: ['re:zero'],
      artist: ['nagatsuki_tappei'],
      general: ['blue_hair', 'maid_apron'],
    },
  };

  const tags = h.extractPromptTags(detail, {
    categories: ['character', 'copyright', 'artist', 'general'],
    replaceUnderscores: true,
    escapeParentheses: true,
  });

  assert.deepEqual([...tags], [
    'rem \\(re:zero\\)',
    're:zero',
    'nagatsuki tappei',
    'blue hair',
    'maid apron',
  ]);
});

test('ratingBadge：正確回傳全年齡、微澀、R15與R18樣式級別', () => {
  const h = harness();
  assert.deepEqual({ ...h.ratingBadge('general') }, { text: 'SFW', cls: 'sfw' });
  assert.deepEqual({ ...h.ratingBadge('sensitive') }, { text: 'Sens', cls: 'sens' });
  assert.deepEqual({ ...h.ratingBadge('questionable') }, { text: 'R15', cls: 'quest' });
  assert.deepEqual({ ...h.ratingBadge('explicit') }, { text: 'R18', cls: 'nsfw' });
});

test('togglePostPrompt：點選圖片加入提示詞，再次點選去除提示詞', async () => {
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
      contains(cls) { return !!this[cls]; },
    },
    querySelector() { return null; },
  };

  // 第一次點選：加入提示詞
  await h.togglePostPrompt(post, cardMock);

  assert.equal(h.appendCalls.length, 1);
  assert.equal(h.appendCalls[0].targetTa, h.mainPromptEl);
  assert.equal(h.appendCalls[0].text, 'rem_(re:zero), re:zero, 1girl, blue_hair, maid');
  assert.equal(h.mainPromptEl.value, 'rem_(re:zero), re:zero, 1girl, blue_hair, maid');
  assert.equal(cardMock.classList.contains('is-selected'), true);
  assert.equal(h.state.selectedPosts.has('safebooru:12345'), true);

  // 第二次點選：去除提示詞
  await h.togglePostPrompt(post, cardMock);

  assert.equal(h.removeCalls.length, 1);
  assert.equal(h.mainPromptEl.value, '');
  assert.equal(cardMock.classList.contains('is-selected'), false);
  assert.equal(h.state.selectedPosts.has('safebooru:12345'), false);
  assert.equal(h.toasts.some((t) => t.msg.includes('移除該圖標籤')), true);
});

test('togglePostPrompt：單選模式下換選新圖自動替換提示詞', async () => {
  const h = harness();
  h.state.selectionMode = 'single';

  const post1 = { source: 'safebooru', postId: '101' };
  const detail1 = {
    tags: { character: ['frieren'], copyright: [], artist: [], general: ['elf', 'white_hair'] },
  };
  h.detailCache.set('safebooru:101', detail1);

  const post2 = { source: 'safebooru', postId: '102' };
  const detail2 = {
    tags: { character: ['fern'], copyright: [], artist: [], general: ['purple_hair'] },
  };
  h.detailCache.set('safebooru:102', detail2);

  const card1 = {
    classList: { add(cls) { this[cls] = true; }, remove(cls) { this[cls] = false; }, contains(cls) { return !!this[cls]; } },
    querySelector() { return null; },
  };
  const card2 = {
    classList: { add(cls) { this[cls] = true; }, remove(cls) { this[cls] = false; }, contains(cls) { return !!this[cls]; } },
    querySelector() { return null; },
  };

  // 選中圖1
  await h.togglePostPrompt(post1, card1);
  assert.equal(h.mainPromptEl.value, 'frieren, elf, white_hair');
  assert.equal(h.state.selectedPosts.size, 1);

  // 選中圖2：自動替換掉圖1
  await h.togglePostPrompt(post2, card2);
  assert.equal(h.mainPromptEl.value, 'fern, purple_hair');
  assert.equal(h.state.selectedPosts.size, 1);
  assert.equal(h.state.selectedPosts.has('safebooru:102'), true);
  assert.equal(h.state.selectedPosts.has('safebooru:101'), false);
});

test('畫廊預設來源應為 danbooru', () => {
  const h = harness();
  assert.equal(h.state.source, 'danbooru');
});

test('openPromptConfigDialog 與 openSettingsDialog：正常打開彈窗對話框', async () => {
  const h = harness();
  assert.equal(h.promptModal.hidden, true);
  h.openPromptConfigDialog();
  assert.equal(h.promptModal.hidden, false);

  assert.equal(h.settingsModal.hidden, true);
  await h.openSettingsDialog();
  assert.equal(h.settingsModal.hidden, false);
});

test('SELECTION_STAMPS：包含全部 43 款檢驗印章且預設為检疫合格', () => {
  const h = harness();
  assert.equal(h.SELECTION_STAMPS.length, 43);
  assert.equal(h.SELECTION_STAMPS.includes('quarantineQualified'), true);
  assert.equal(h.SELECTION_STAMPS.includes('pass'), true);
  assert.equal(h.SELECTION_STAMPS.includes('qa'), true);
  assert.equal(h.SELECTION_STAMPS.includes('soldOutPostal'), true);

  assert.equal(h.STAMP_LABELS.quarantineQualified, '检疫合格圆章');
  assert.equal(h.state.selectionStamp, 'quarantineQualified');

  const stamp = h.createSelectionStamp('quarantineQualified');
  assert.equal(stamp.root.dataset.stamp, 'quarantineQualified');
  assert.equal(stamp.root.classList.contains('aa-gallery-card__selection'), true);
});

test('togglePostPrompt：選中卡片時掛載居中印章與選中圖層', async () => {
  const h = harness();
  const post = { source: 'danbooru', postId: '999' };
  h.detailCache.set('danbooru:999', {
    tags: { character: ['nahida'], copyright: ['genshin_impact'], artist: [], general: ['solo'] }
  });

  const children = [];
  const wrapMock = {
    append(...nodes) { children.push(...nodes); },
  };

  const cardMock = {
    classList: {
      add(cls) { this[cls] = true; },
      remove(cls) { this[cls] = false; },
      contains(cls) { return !!this[cls]; },
    },
    querySelector(sel) {
      if (sel === '.booru-img-wrap') return wrapMock;
      return null;
    },
  };

  await h.togglePostPrompt(post, cardMock);

  assert.equal(cardMock.classList.contains('is-selected'), true);
  assert.equal(children.some((n) => n.classList?.contains('aa-gallery-card__selected-layer')), true);
  assert.equal(children.some((n) => n.classList?.contains('aa-gallery-card__selection')), true);
});

test('parseTagLines：正確解析多行與逗號分隔的標籤並清理前後空白', () => {
  const h = harness();
  const raw = 'watermark\n  bad_anatomy  , signature\r\n\r\nlogo';
  const parsed = h.parseTagLines(raw);
  assert.deepEqual(parsed, ['watermark', 'bad_anatomy', 'signature', 'logo']);
});


