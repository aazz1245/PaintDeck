const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function editor(saved = new Map()) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', options: ['euler', 'euler_ancestral', 'normal', 'sgm_uniform'].map((value) => ({ value })) });
    return nodes.get(id);
  };
  const context = vm.createContext({
    $: get, $$: () => [], refs: { get: () => [] }, promptx: {}, library: { fillPickers() {} },
    store: { get: (k, d) => structuredClone(saved.has(k) ? saved.get(k) : d), set: (k, v) => saved.set(k, structuredClone(v)) },
    app: { state: { settings: { negative: 'old default' }, models: { unet_family: { anima: 'anima', anima_turbo: 'anima', moss: 'moss', qwen: 'qwen21' } } } },
  });
  const raw = fs.readFileSync(path.join(__dirname, '../ui/js/gen.js'), 'utf8');
  const source = raw.replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*\};\r?\n/gm, '').replace(/^export /gm, '');
  const binding = raw.match(/F\("model"\)\.onchange = [^\r\n]+/)[0];
  vm.runInContext(source + '\nmodelHint = () => {}; renderLoras = () => {}; swapCart = () => {};\n' + binding +
    '\nglobalThis.subject = {MODEL_PROMPTS, rememberModelPrompts, save};', context);
  const choose = (model) => { get('#model').value = model; get('#model').onchange(); };
  const edit = (id, value) => { get('#' + id).value = value; context.subject.rememberModelPrompts([id]); };
  return { choose, edit, get: (id) => get('#' + id), defaults: context.subject.MODEL_PROMPTS, saved, save: context.subject.save };
}

test('選模型切換前綴和負面詞，Anima 普通版和 Turbo 共用同一組，主詞與後綴保留', () => {
  const e = editor();
  e.get('prompt').value = 'my subject';
  e.get('promptSuffix').value = 'my suffix';
  for (const model of ['anima', 'moss', 'anima_turbo']) {
    e.choose(model);
    const defaults = e.defaults[model === 'anima_turbo' ? 'anima' : model];
    assert.equal(e.get('promptPrefix').value, defaults.promptPrefix);
    assert.equal(e.get('negative').value, defaults.negative);
    assert.equal(e.get('prompt').value, 'my subject');
    assert.equal(e.get('promptSuffix').value, 'my suffix');
    assert.equal(e.saved.get('form').negative, defaults.negative);
  }
});

test('手動輸入立即按模型記住，快速切換不丟失，重新載入仍能還原', () => {
  const e = editor();
  e.choose('anima');
  e.edit('promptPrefix', 'my anime prefix, ');
  e.edit('negative', 'my anime negative');
  e.choose('moss');
  e.edit('promptPrefix', 'my moss prefix, ');
  e.edit('negative', 'my moss negative');
  e.choose('anima_turbo');
  assert.equal(e.get('promptPrefix').value, 'my anime prefix, ');
  assert.equal(e.get('negative').value, 'my anime negative');
  const reloaded = editor(e.saved);
  reloaded.choose('moss');
  assert.equal(reloaded.get('promptPrefix').value, 'my moss prefix, ');
  assert.equal(reloaded.get('negative').value, 'my moss negative');
});

test('只改一個欄位不會把另一個舊預設帶進新設定，空白自訂值也會記住', () => {
  const e = editor();
  e.get('model').value = 'anima';
  e.get('promptPrefix').value = 'old prefix';
  e.edit('negative', '');
  e.choose('moss'); e.choose('anima');
  assert.equal(e.get('promptPrefix').value, e.defaults.anima.promptPrefix);
  assert.equal(e.get('negative').value, '');
});

test('恢復檔案預設會清除對應自訂值，程式套用的欄位隨儲存記住', () => {
  const e = editor();
  e.choose('anima');
  e.edit('negative', 'custom');
  e.edit('negative', e.defaults.anima.negative);
  assert.equal(e.saved.get('modelPrompts').anima, undefined);
  e.get('negative').value = 'applied from saved image';
  e.save();
  e.choose('moss'); e.choose('anima');
  assert.equal(e.get('negative').value, 'applied from saved image');
});
