// node --test --test-isolation=none tests/charsheet_ui.test.cjs
// 角色設定圖工坊（ui/js/charsheet.js）的純函式：選哪顆 Qwen、參數、裸體指令、存哪些圖、晚到的候選圖
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NUDE_F = '把图1中角色身上的衣服全部脱掉（女）';
function load() {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js/charsheet.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ console, SHEET_PRESETS: { nude: NUDE_F } });
  vm.runInContext(source + '\nglobalThis.subject = {qwenModel, qwenParams, nudeReq, rolesToSave, startRound, takeImage};', context, { filename: 'charsheet.js' });
  return context.subject;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test('qwenModel：生成頁是 Qwen 就用它，否則挑 turbo，沒有就 null', () => {
  const { qwenModel } = load();
  const fam = (m) => ({ unet_family: m });
  assert.equal(qwenModel(fam({ 'anima-turbo.safetensors': 'anima' }), { family: 'anima' }), null);
  assert.equal(qwenModel(fam({ 'noct_q.safetensors': 'qwen21', 'qwen_image_2.1_turbo_int8.safetensors': 'qwen21' }), { family: 'anima' }),
    'qwen_image_2.1_turbo_int8.safetensors');
  assert.equal(qwenModel(fam({ 'noct_q.safetensors': 'qwen21', 'qwen_image_2.1_turbo_int8.safetensors': 'qwen21' }), { family: 'qwen21', model: 'noct_q.safetensors' }),
    'noct_q.safetensors');
});

test('qwenParams：不是同一顆 Qwen 用官方 Turbo 參數、不掛 LoRA；同一顆照生成頁', () => {
  const { qwenParams } = load();
  const base = { family: 'anima', model: 'anima.safetensors', steps: 30, cfg: 4, sampler: 'er_sde', scheduler: 'karras', loras: [{ name: 'x' }] };
  const p = plain(qwenParams(base, 'qwen_turbo.safetensors', 'P', 'cs_a.png', 1664, 928));
  assert.equal(p.mode, 'multiref');
  assert.deepEqual([p.model, p.steps, p.cfg, p.sampler, p.scheduler], ['qwen_turbo.safetensors', 8, 1, 'euler', 'simple']);
  assert.deepEqual(p.loras, []);
  assert.deepEqual(p.refs, [{ image: 'cs_a.png' }]);
  assert.deepEqual([p.size_mode, p.width, p.height, p.prompt], ['fixed', 1664, 928, 'P']);
  const q = { family: 'qwen21', model: 'noct_q.safetensors', steps: 20, cfg: 2.5, sampler: 'res_2s', scheduler: 'beta', loras: [{ name: 'y' }] };
  const p2 = plain(qwenParams(q, 'noct_q.safetensors', 'P', 'cs_a.png', 1344, 1344));
  assert.deepEqual([p2.steps, p2.cfg, p2.sampler, p2.scheduler], [20, 2.5, 'res_2s', 'beta']);
  assert.deepEqual(p2.loras, [{ name: 'y' }]);
});

test('nudeReq：女性用四視圖那句，男性另一句', () => {
  const { nudeReq } = load();
  assert.equal(nudeReq('f'), NUDE_F);
  const m = nudeReq('m');
  assert.match(m, /成年男性/);
  assert.doesNotMatch(m, /阴部|胸部|乳头/);
});

test('rolesToSave：定稿＋轉身圖＋臉部；定稿本來就在資產裡就不再存', () => {
  const { rolesToSave } = load();
  const st = { start: { input: 'cs_a.png' }, pick: { turnaround: { gallery_id: 11 }, face: { gallery_id: 12 }, nude: null } };
  assert.deepEqual(plain(rolesToSave(st)), [
    { role: 'src', input: 'cs_a.png' }, { role: 'sheet', gallery_id: 11 }, { role: 'face', gallery_id: 12 }]);
  const fromGallery = { start: { input: 'cs_a.png', gallery_id: 5 }, pick: { nude: { gallery_id: 13 } } };
  assert.deepEqual(plain(rolesToSave(fromGallery)), [{ role: 'src', gallery_id: 5 }, { role: 'sheet_nude', gallery_id: 13 }]);
  const fromAsset = { start: { input: 'aw_asset_1_1.png', from_asset: true }, pick: { turnaround: { gallery_id: 11 } } };
  assert.deepEqual(plain(rolesToSave(fromAsset)), [{ role: 'sheet', gallery_id: 11 }]);
});

test('晚到的候選圖：換新一輪之後，上一輪的 job 不收', () => {
  const { startRound, takeImage } = load();
  startRound('turnaround', ['a1', 'a2']);
  assert.equal(takeImage('a1', { id: 1 }), 'turnaround');
  startRound('turnaround', ['b1']);
  assert.equal(takeImage('a2', { id: 2 }), null);
  assert.equal(takeImage('b1', { id: 3 }), 'turnaround');
  startRound('face', ['f1']);
  assert.equal(takeImage('b1', { id: 4 }), 'turnaround', '不同步驟各自一輪');
  assert.equal(takeImage('zz', { id: 5 }), null);
});
