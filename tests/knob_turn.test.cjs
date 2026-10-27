// node --test --test-isolation=none tests/knob_turn.test.cjs
// 旋鈕要能像真的一樣繞圈轉（2026-10-26 使用者：「只能上下，改成能360度轉」）：
// 照指標繞旋鈕中心轉了幾度來算，順時針加、逆時針減，可以一直轉好幾圈。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/deck.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const store = { get: (_k, d) => d, set() {} };
  const context = vm.createContext({ console, store, $: () => null, $$: () => [], modeName: {}, api() {}, toast() {}, play() {} });
  vm.runInContext(source + '\nglobalThis.subject = { turnDelta, stepDegrees };', context, { filename: 'deck.js' });
  return context.subject;
}

test('turnDelta：兩個角度之間轉了幾度，跨過 ±180 也是走近的那邊', () => {
  const { turnDelta } = load();
  assert.equal(turnDelta(10, 40), 30, '順時針 30 度');
  assert.equal(turnDelta(40, 10), -30, '逆時針 30 度');
  assert.equal(turnDelta(170, -170), 20, '跨過 180 往順時針走 20 度，不是倒轉 340 度');
  assert.equal(turnDelta(-170, 170), -20, '反過來是逆時針 20 度');
});

test('連續轉一整圈多：累積角度不會在跨過 180 時歸零（可以一直轉）', () => {
  const { turnDelta } = load();
  let last = 0, acc = 0;
  for (let a = 15; a <= 450; a += 15) {
    const ang = ((a + 180) % 360) - 180; // atan2 給的範圍是 -180～180
    acc += turnDelta(last, ang);
    last = ang;
  }
  assert.equal(acc, 450, '轉了一圈又 90 度');
});

test('stepDegrees：選項少時一格角度大、選項多時至少 6 度一格', () => {
  const { stepDegrees } = load();
  assert.equal(stepDegrees(4), 90, '4 個選項：270 度分 3 格');
  assert.equal(stepDegrees(1000), 6, '選項很多也不會細到手抖就跳');
  assert.equal(stepDegrees(1), 270, '只有一個值也不會除以零');
});
