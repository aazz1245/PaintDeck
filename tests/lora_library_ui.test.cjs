const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const controls = new Map();
  for (const id of ['loraQ', 'loraFamily', 'loraCategory', 'loraTag', 'loraFav', 'loraTotal', 'loraMore', 'loraGrid']) {
    controls.set('#' + id, {
      value: '', checked: false, options: [], children: [], hidden: false, textContent: '',
      replaceChildren(...children) { this.children = children; this.options = children; },
      append(child) { this.children.push(child); },
    });
  }
  const el = (tag, attrs = {}, ...kids) => ({ tag, attrs, kids, get value() { return attrs.value || ''; } });
  const app = { page: 'loras', state: { models: { family_names: { anima: 'Anima（動漫）' } } } };
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/loras.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ $, el, app, api: async () => {}, toast() {}, openModal() {}, closeModal() {}, debounce: f => f });
  function $(id) { return controls.get(id); }
  vm.runInContext(source + '\nglobalThis.subject = { onState, renderPage, categoryOf, preview };', context, { filename: 'loras.js' });
  return { ...context.subject, get: id => controls.get('#' + id) };
}

test('五千個 LoRA 只先建立 60 張卡片，分類與搜尋仍掃完整清單', () => {
  const h = harness();
  const loras = Array.from({ length: 5000 }, (_, i) => ({
    name: `item_${i}.safetensors`, family: 'anima',
    agent: i % 2 ? { kind: 'style', desc: 'watercolor style' } : null,
    tags: i === 4999 ? ['rare-tag'] : [],
  }));
  h.onState({ models: { loras } });
  assert.equal(h.get('loraGrid').children.length, 60);
  assert.equal(h.get('loraTotal').textContent, '5000 / 5000 個');
  assert.equal(h.get('loraMore').hidden, false);
  h.renderPage(false);
  assert.equal(h.get('loraGrid').children.length, 120);
  h.get('loraQ').value = 'rare-tag';
  h.renderPage(true);
  assert.equal(h.get('loraGrid').children.length, 1);
  assert.equal(h.get('loraTotal').textContent, '1 / 5000 個');
  assert.equal(h.get('loraMore').hidden, true);
  assert.equal(h.categoryOf(loras[1]), 'style');
  assert.equal(h.categoryOf({ ...loras[1], category: 'character' }), 'character');
});

test('手動安裝的 LoRA 能使用模型旁的預覽圖', () => {
  const h = harness();
  const image = h.preview({ name: 'krea2\\sample.safetensors', local_preview: true });
  assert.match(image, /\/api\/loras\/local-preview\?name=krea2%5Csample\.safetensors/);
});
