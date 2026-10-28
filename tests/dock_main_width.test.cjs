// 看圖區的說明列（LoRA 名稱一長串、不換行）不能把看圖區撐出去、壓到右邊的停靠區（2026-10-28 兩位使用者回報「UI 出 bug」）。
// 原因：.monitor 只寫 grid-template-rows，隱含的欄寬跟著內容走，.viewer 的 min-width: auto 又擋不住。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../ui/css/app.css'), 'utf8');
const rule = (sel) => (css.match(new RegExp(`^${sel.replace(/[.*>]/g, '\\$&')} \\{([^}]*)\\}`, 'm')) || [])[1] || '';

test('CSS：.monitor 欄寬定死，長說明列撐不開看圖區', () => {
  assert.match(rule('.monitor'), /grid-template-columns: minmax\(0, 1fr\)/);
});

test('CSS：.dock-main 欄寬定死、裡面的格子可以比內容窄', () => {
  assert.match(rule('.dock-main'), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(rule('.dock-main > *'), /min-width: 0/);
});
