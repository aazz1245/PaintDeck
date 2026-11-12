const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function element(tag, attrs = {}, ...children) {
  return Object.assign({
    tag, children: children.filter((c) => c != null), value: '', checked: false, disabled: false, hidden: false,
    style: {}, classList: { add() {}, toggle() {} }, focus() {}, select() {}, remove() { this.removed = true; },
    append(...kids) { this.children.push(...kids.filter((c) => c != null)); },
    replaceChildren(...kids) { this.children = kids; }, addEventListener() {},
    querySelectorAll() { return walk(this).filter((e) => ['button', 'input', 'select'].includes(e.tag)); },
  }, attrs);
}
function walk(root) {
  return root.children.flatMap((c) => c && typeof c === 'object' ? [c, ...walk(c)] : []);
}
function harness(initial = [], settings = new Map(), intercept = () => {}) {
  let records = structuredClone(initial);
  const nodes = new Map(), calls = [], messages = [], events = [], dialogs = [];
  const node = (id) => {
    id = id.replace(/^#/, '');
    if (!nodes.has(id)) nodes.set(id, element('input'));
    return nodes.get(id);
  };
  const body = element('body');
  const globals = {
    structuredClone, Event, crypto: { randomUUID },
    store: { get: (k, d) => structuredClone(settings.has(k) ? settings.get(k) : d), set: (k, v) => settings.set(k, structuredClone(v)) },
    el: element, $: node, $$: () => [], toast: (m) => messages.push(m), confirm: () => true,
    library: { saveDialog: (opts) => dialogs.push(opts), edit() {} },
    openModal() {}, closeModal() {}, app: { state: null },
    document: { getElementById: node, body, addEventListener() {}, dispatchEvent: (e) => events.push(e.type), documentElement: { lang: 'zh-Hans' } },
    api: async (url, options) => {
      calls.push([url, options?.json]);
      await intercept(url, options);
      if (!options) return structuredClone(records);
      assert.equal(url, '/api/lib');
      const patch = structuredClone(options.json);
      const old = records.find((it) => it.id === patch.id);
      const updated = { ...old, ...patch, id: patch.id || records.length + 1 };
      if (old) records[records.indexOf(old)] = updated;
      else records.push(updated);
      return structuredClone(updated);
    },
  };
  function module(file, exposed) {
    const source = fs.readFileSync(path.join(__dirname, '../ui/js', file), 'utf8')
      .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    const context = vm.createContext({ ...globals });
    vm.runInContext(source + `\nglobalThis.subject = {${exposed}};`, context);
    return context.subject;
  }
  const subject = module('assets.js', `init, load, paintKinds, newOne, open, collect, addCategory, changeCategory, manageCategories, inCategory, folderNames,
    categories: () => categories, selection: () => [kind, snippetFolder], choose: (k, f = null) => { kind = k; snippetFolder = f; }`);
  subject.init();
  return { subject, module, node, body, settings, calls, messages, events, dialogs, records: () => records };
}
const char = (id, folder = '', tags = []) => ({ id, kind: 'char', name: '角色' + id, folder, tags, data: {} });
const snippet = (id, folder = '', tags = []) => ({ id, kind: 'snippet', name: '片段' + id, folder, tags, data: { text: 'test' } });
const button = (root, text) => walk(root).find((e) => e.tag === 'button' && e.children.includes(text));

test('上排新增分類沿用原資產類型，選分類時自動帶標籤，重新載入後保留', async () => {
  const h = harness([char(1, '', ['原標籤'])]);
  await h.subject.load();
  h.subject.addCategory('主角', 'char');
  const category = h.subject.categories().find((c) => c.name === '主角');
  h.subject.newOne();
  assert.equal(h.subject.collect().kind, 'char');
  assert.deepEqual([...h.subject.collect().tags], ['主角']);
  h.subject.open(h.records()[0]);
  h.node('asKind').value = category.id;
  assert.deepEqual([...h.subject.collect().tags], ['主角', '原標籤']);
  const reloaded = harness(h.records(), h.settings);
  assert.equal(reloaded.subject.categories().find((c) => c.id === category.id).name, '主角');
});

test('內建分類改名和移除只改分類欄，原資產仍在全部且保持原類型', async () => {
  const h = harness([char(1)]);
  await h.subject.changeCategory('main', 'char', '人物');
  assert.equal(h.subject.categories().find((c) => c.id === 'char').name, '人物');
  await h.subject.changeCategory('main', 'char', null);
  assert.equal(h.subject.categories().some((c) => c.id === 'char'), false);
  assert.equal(h.subject.inCategory(h.records()[0], 'all'), true);
  assert.equal(h.records()[0].kind, 'char');
  assert.equal(h.calls.some(([, body]) => body), false);
});

test('自訂上排分類改名只更新相應類型的標籤，移除不刪除資產或改變編輯器類型', async () => {
  const h = harness([char(1, '', ['主角', '原標籤']), snippet(2, '', ['主角'])]);
  h.subject.addCategory('主角', 'char');
  const id = h.subject.categories().find((c) => c.name === '主角').id;
  await h.subject.load();
  h.subject.open(h.records()[0]);
  await h.subject.changeCategory('main', id, '常用角色');
  assert.deepEqual(h.records()[0].tags, ['原標籤', '常用角色']);
  assert.deepEqual(h.records()[1].tags, ['主角']);
  await h.subject.changeCategory('main', id, null);
  assert.equal(h.records().length, 2);
  assert.deepEqual(h.records()[0].tags, ['原標籤']);
  assert.equal(h.subject.collect().kind, 'char');
  assert.equal(h.subject.selection()[0], 'all');
});

test('下排可新增空分類並持久保存，新增片段使用所選資料夾', async () => {
  const h = harness();
  h.subject.choose('snippet');
  h.subject.manageCategories('folder');
  const modal = h.body.children.at(-1);
  walk(modal).find((e) => e.tag === 'input').value = '新片段';
  await button(modal, '＋ 新增分類').onclick();
  assert.ok([...h.subject.folderNames()].includes('新片段'));
  const reloaded = harness([], h.settings);
  reloaded.subject.choose('snippet', '新片段');
  reloaded.subject.newOne();
  assert.equal(reloaded.dialogs[0].folder, '新片段');
  assert.ok([...reloaded.subject.folderNames()].includes('新片段'));
});

test('片段資料夾改名、刪除僅影響片段，同名角色資料夾保持不變', async () => {
  const h = harness([snippet(1, '少女'), snippet(2, '少女'), char(3, '少女')]);
  h.subject.choose('snippet', '少女');
  await h.subject.changeCategory('folder', '少女', '人物片段');
  assert.deepEqual(h.records().map((x) => x.folder), ['人物片段', '人物片段', '少女']);
  assert.equal(h.subject.selection()[1], '人物片段');
  await h.subject.changeCategory('folder', '人物片段', null);
  assert.deepEqual(h.records().map((x) => x.folder), ['', '', '少女']);
  assert.equal(h.records().length, 3);
  assert.equal(h.subject.selection()[1], '');
  assert.ok(![...h.subject.folderNames()].includes('人物片段'));
  assert.ok(h.events.includes('lib-changed'));
});

test('片段分類 all 與全部片段不衝突，未分類可以獨立篩選', async () => {
  const h = harness([snippet(1, 'all'), snippet(2)]);
  await h.subject.load();
  h.subject.choose('snippet', 'all'); h.subject.paintKinds();
  assert.ok(button(h.node('asKinds'), 'all'));
  assert.ok(button(h.node('asKinds'), '全部片段'));
  h.subject.choose('snippet', ''); h.subject.newOne();
  assert.equal(h.dialogs[0].folder, '');
});

test('分類名稱拒絕空白和重複；失敗不更新分類或呼叫儲存 API', async () => {
  const h = harness();
  assert.throws(() => h.subject.addCategory('  ', 'char'), /名稱/);
  assert.throws(() => h.subject.addCategory('角色', 'char'), /同名/);
  await assert.rejects(h.subject.changeCategory('main', 'char', '場景'), /同名/);
  assert.equal(h.calls.length, 0);
});

test('部分更新失敗保留來源及目標分類，重試可合併完成，其他標籤不丟失', async () => {
  let failed = false;
  const h = harness([char(1, '', ['主角']), char(2, '', ['主角', '保留'])], new Map(), async (url, opts) => {
    if (opts?.json.id === 2 && !failed) { failed = true; throw Error('儲存失敗'); }
  });
  h.subject.addCategory('主角', 'char');
  const id = h.subject.categories().find((c) => c.name === '主角').id;
  await assert.rejects(h.subject.changeCategory('main', id, '人物'), /已更新 1 筆/);
  assert.ok(h.subject.categories().some((c) => c.name === '主角'));
  assert.ok(h.subject.categories().some((c) => c.name === '人物'));
  await h.subject.changeCategory('main', id, '人物');
  assert.deepEqual(h.records().map((x) => x.tags), [['人物'], ['保留', '人物']]);
  assert.equal(h.subject.categories().filter((c) => c.name === '人物').length, 1);
  assert.equal(h.subject.categories().some((c) => c.name === '主角'), false);
});

test('分類更新期間連點不會重複儲存', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const h = harness([snippet(1, '舊')], new Map(), async (url, opts) => { if (!opts) await waiting; });
  const first = h.subject.changeCategory('folder', '舊', '新');
  await h.subject.changeCategory('folder', '舊', '新');
  assert.equal(h.calls.length, 1);
  release(); await first;
  assert.equal(h.calls.filter(([, body]) => body).length, 1);
});

test('自訂片段分類帶入提示詞庫編輯窗，儲存前保留分類標籤', () => {
  const h = harness();
  const lib = h.module('library.js', 'saveDialog, setContext: (c) => { ctx = c; }, tags: () => E.tags');
  lib.setContext({ family: () => 'anima', famOf: () => 'anima', current: () => null });
  lib.saveDialog({ kind: 'snippet', folder: '片段資料夾', tags: ['自訂片段'], data: { text: 'test' } });
  assert.deepEqual([...lib.tags()], ['自訂片段']);
  assert.equal(h.node('leFolder').value, '片段資料夾');
});

test('分類改名保留編輯區尚未儲存的內容和其他標籤', async () => {
  const h = harness([char(1, '', ['主角'])]);
  h.subject.addCategory('主角', 'char');
  const id = h.subject.categories().find((c) => c.name === '主角').id;
  h.subject.open(h.records()[0]);
  h.node('asLabels').value = '主角, 尚未儲存';
  h.node('asName').value = '正在編輯';
  await h.subject.changeCategory('main', id, '人物');
  assert.deepEqual([...h.subject.collect().tags], ['人物', '尚未儲存']);
  assert.equal(h.subject.collect().name, '正在編輯');
  assert.equal(h.records()[0].name, '角色1');
});
