const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 外掛「一鍵脫衣」內容補丁（ui/js/feature.js）：裝了就顯示入口、填 UI 文案；沒裝就把入口全藏起來。
function harness() {
  const el = () => ({ hidden: true, textContent: '', placeholder: '', title: '', value: '' });
  const nodes = {
    '#stripLbl': el(), '#stripTargetLbl': el(), '#stripKeepLbl': el(), '#stripRefineLbl': el(),
    '#stripDenoiseLbl': el(), '#stripMergeLbl': el(), '#stripTagsLbl': el(), '#stripExtraLbl': el(),
    '#stripNote': el(), '#stripTags': el(), '#stripExtra': el(),
    '#stripTarget': { options: [{ value: 'female', textContent: '' }, { value: 'male', textContent: '' }] },
    '#stripKeep': { options: [{ value: 'all', textContent: '' }, { value: 'shoes', textContent: '' }, { value: 'underwear', textContent: '' }] },
  };
  const modeBtn = { hidden: true, textContent: '', title: '', dataset: { mode: 'strip' } };
  const actBtn = { hidden: true, textContent: '', title: '', dataset: { act: 'strip' } };
  const document = {
    querySelectorAll(sel) {
      if (sel === '[data-mode="strip"]') return [modeBtn];
      if (sel === '[data-act="strip"]') return [actBtn];
      return [];
    },
  };
  const modeName = {};
  const $ = (id) => nodes[id] || null;
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/feature.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ document, modeName, $, api: async () => ({}) });
  vm.runInContext(source + '\nglobalThis.subject = { applyStrip, stripOn };', context, { filename: 'feature.js' });
  return { ...context.subject, nodes, modeBtn, actBtn, modeName, opt: (id, v) => nodes[id].options.find(o => o.value === v).textContent };
}

const UI = {
  button: '一鍵脫衣', button_title: '把衣服脫掉', send_title: '開始脫',
  label: '脫衣', target_label: '對象', keep_label: '保留',
  targets: { female: '女性', male: '男性' },
  keeps: { all: '全脫', shoes: '留鞋', underwear: '留內衣' },
  refine_label: '精修', denoise_label: '重繪', merge_label: '貼回',
  tags_label: '加 tag', extra_label: '額外', note: '這是外掛',
  tags_ph: '打 tag', extra_ph: '補充',
};

test('裝了補丁：入口顯示、文案全填上', () => {
  const h = harness();
  h.applyStrip(UI);
  assert.equal(h.stripOn(), true);
  assert.equal(h.modeBtn.hidden, false);
  assert.equal(h.modeBtn.textContent, '一鍵脫衣');
  assert.equal(h.modeBtn.title, '把衣服脫掉');
  assert.equal(h.actBtn.hidden, false);
  assert.equal(h.actBtn.title, '開始脫');
  assert.equal(h.modeName.strip, '一鍵脫衣');
  assert.equal(h.nodes['#stripLbl'].textContent, '脫衣');
  assert.equal(h.nodes['#stripNote'].textContent, '這是外掛');
  assert.equal(h.nodes['#stripTags'].placeholder, '打 tag');
  assert.equal(h.opt('#stripTarget', 'female'), '女性');
  assert.equal(h.opt('#stripKeep', 'underwear'), '留內衣');
});

test('沒裝補丁：入口全藏起來、模式名退回「改圖」', () => {
  const h = harness();
  h.applyStrip(UI);     // 先裝
  h.applyStrip(null);   // 再移除
  assert.equal(h.stripOn(), false);
  assert.equal(h.modeBtn.hidden, true);
  assert.equal(h.actBtn.hidden, true);
  assert.equal(h.modeName.strip, '改圖');
});
