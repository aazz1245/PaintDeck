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
    source + '\nglobalThis.subject = { extractPromptTags, ratingBadge, togglePostPrompt, addPostPromptToMain, setSelectionMode, clearSelection, openPromptConfigDialog, openSettingsDialog, state, promptConfig, detailCache, SELECTION_STAMPS, STAMP_LABELS, createSelectionStamp, setSelectionStamp, parseTagLines, VirtualMasonryLayout, masonryColumnCount, ratingKey, ratingTone, ratingLabel, renderGrid };',
    context,
    { filename: 'booru.js' }
  );
  return { ...context.subject, mainPromptEl, appendCalls, removeCalls, toasts, promptModal, settingsModal, nodes };
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

test('masonryColumnCount：依寬度自適應欄位數', () => {
  const h = harness();
  assert.equal(h.masonryColumnCount(280, { minCardWidth: 118, gap: 6, maxColumns: 6 }), 2);
  assert.equal(h.masonryColumnCount(500, { minCardWidth: 118, gap: 6, maxColumns: 6 }), 4);
  assert.equal(h.masonryColumnCount(750, { minCardWidth: 118, gap: 6, maxColumns: 6 }), 6);
});

test('VirtualMasonryLayout：不同解析度圖片按原始比例計算高度（非強制等高正方形）', () => {
  const h = harness();
  const layout = new h.VirtualMasonryLayout({ width: 500, minCardWidth: 118, gap: 6, maxColumns: 4 });
  assert.equal(layout.columnCount, 4);
  assert.ok(layout.cardWidth > 115);

  const portrait = { source: 'danbooru', postId: '1', width: 800, height: 1200 }; // 2:3 直圖
  const landscape = { source: 'danbooru', postId: '2', width: 1920, height: 1080 }; // 16:9 橫圖
  const square = { source: 'danbooru', postId: '3', width: 1000, height: 1000 }; // 1:1 正方形

  layout.append([portrait, landscape, square]);

  const pPlacement = layout.placementsByKey.get('danbooru:1');
  const lPlacement = layout.placementsByKey.get('danbooru:2');
  const sPlacement = layout.placementsByKey.get('danbooru:3');

  assert.ok(pPlacement && lPlacement && sPlacement);
  // 直圖高度顯著大於橫圖與正方形，完全保留自然縱橫比
  assert.ok(pPlacement.height > sPlacement.height);
  assert.ok(sPlacement.height > lPlacement.height);
  assert.equal(Math.round(pPlacement.height / sPlacement.height * 10) / 10, 1.5);
});

test('VirtualMasonryLayout：優先填補最短欄位並在重設寬度時重排', () => {
  const h = harness();
  const layout = new h.VirtualMasonryLayout({ width: 250, minCardWidth: 118, gap: 6, maxColumns: 4 });
  assert.equal(layout.columnCount, 2);

  layout.append([
    { source: 'x', postId: '1', width: 100, height: 300 }, // col 0
    { source: 'x', postId: '2', width: 100, height: 100 }, // col 1
    { source: 'x', postId: '3', width: 100, height: 100 }, // 應排入最短的 col 1
  ]);

  assert.equal(layout.placementsByKey.get('x:1').column, 0);
  assert.equal(layout.placementsByKey.get('x:2').column, 1);
  assert.equal(layout.placementsByKey.get('x:3').column, 1);

  // 當容器拉寬時，reflow 重新配置欄位
  assert.equal(layout.configure(500), true);
  assert.equal(layout.columnCount, 4);
});

test('ratingLabel 與 ratingTone：正確映射原版分級文字與色彩標識', () => {
  const h = harness();
  assert.equal(h.ratingTone('general'), 'general');
  assert.equal(h.ratingTone('safe'), 'safe');
  assert.equal(h.ratingTone('sensitive'), 'sensitive');
  assert.equal(h.ratingTone('questionable'), 'questionable');
  assert.equal(h.ratingTone('explicit'), 'explicit');

  assert.equal(h.ratingLabel('general'), '全龄');
  assert.equal(h.ratingLabel('safe'), '全龄');
  assert.equal(h.ratingLabel('sensitive'), '敏感');
  assert.equal(h.ratingLabel('questionable'), '疑虑');
  assert.equal(h.ratingLabel('explicit'), '色情');
});



