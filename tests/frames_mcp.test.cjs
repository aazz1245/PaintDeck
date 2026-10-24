const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
test('拆幀永久清理在 MCP 層也需要使用者同意', () => {
  const src = fs.readFileSync(path.join(__dirname, '../resources/extras/fablecut/anima-tools.js'),'utf8');
  const begin = src.indexOf('const DANGER = [');
  const end = src.indexOf('function needConfirm',begin);
  const context = vm.createContext({});
  vm.runInContext(src.slice(begin,end),context);
  assert.match(context.danger('POST','/api/studio/frames/clear',{}),/永久清除/);
  assert.equal(context.danger('GET','/api/studio/frames/storage',null),null);
});
