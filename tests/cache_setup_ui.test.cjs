const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = file => fs.readFileSync(path.join(__dirname, '../ui/js', file), 'utf8');
const flush = () => new Promise(setImmediate);

function cacheHarness() {
  const nodes = new Map(['cacheScan','cacheClear','cacheSummary','cacheGroups','cacheResult'].map(id => ['#'+id,
    {textContent:'', disabled:false, replaceChildren(...children) {this.children = children;}}]));
  let consent = false, handler = async () => ({bytes:100, groups:[{id:'downloads',label:'fixture cache',bytes:100}]});
  const calls = [];
  const context = vm.createContext({
    $:id => nodes.get(id), el:(tag, attrs, ...children) => ({tag, attrs, children}), fmtBytes:n => n+' B',
    confirm:() => consent,
    api:async (url, opts) => { calls.push({url, opts}); return handler(url, opts); },
  });
  vm.runInContext(source('cache.js').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\ninit();', context);
  return {node:id => nodes.get('#'+id), calls, consent:v => {consent=v;}, respond:fn => {handler=fn;}};
}
test('快取清理先列大小，取消不送請求，確認後只送固定清理 API', async () => {
  const h = cacheHarness();
  await h.node('cacheScan').onclick();
  assert.equal(h.node('cacheClear').disabled, false);
  assert.match(h.node('cacheSummary').textContent, /100 B/);
  await h.node('cacheClear').onclick();
  assert.equal(h.calls.length, 1);
  h.consent(true);
  h.respond(async url => url.endsWith('/clear') ? {freed_bytes:80,skipped:1,warnings:[]} : {bytes:20,groups:[]});
  await h.node('cacheClear').onclick();
  assert.equal(h.calls[1].url, '/api/cache/clear');
  assert.equal(JSON.stringify(h.calls[1].opts.json), '{"confirm":true}');
  assert.equal(h.calls[1].opts.timeout, 0);
  assert.match(h.node('cacheResult').textContent, /80 B.*1/);
  assert.match(h.node('cacheSummary').textContent, /20 B/);
});
test('清理期間連按只送一次，失敗後顯示原因並恢復可操作', async () => {
  const h = cacheHarness(); await h.node('cacheScan').onclick(); h.consent(true);
  let reject;
  h.respond(url => url.endsWith('/clear') ? new Promise((_, no) => {reject=no;}) : {bytes:100,groups:[]});
  const running = h.node('cacheClear').onclick(); await flush();
  assert.equal(h.node('cacheClear').disabled, true);
  await h.node('cacheClear').onclick();
  assert.equal(h.calls.filter(c => c.url.endsWith('/clear')).length, 1);
  reject(Error('fixture busy')); await running;
  assert.match(h.node('cacheResult').textContent, /fixture busy/);
  assert.equal(h.node('cacheClear').disabled, false);
});
test('快取大小讀取失敗時不能直接清理', async () => {
  const h = cacheHarness(); h.respond(async () => {throw Error('fixture unavailable');});
  await h.node('cacheScan').onclick();
  assert.equal(h.node('cacheClear').disabled, true);
  assert.match(h.node('cacheSummary').textContent, /fixture unavailable/);
});

function installHarness(key, fail = false) {
  const text = source('setup.js');
  const begin = text.indexOf('async function startRun()');
  const end = text.indexOf('F("cancelBtn").onclick', begin);
  const nodes = new Map();
  const F = id => {if (!nodes.has(id)) nodes.set(id, {value:'',textContent:''}); return nodes.get(id);};
  F('wizCivitaiKey').value = key;
  const calls = [];
  const context = vm.createContext({F, scan:true, chk:{data:{has_key:false}}, pick:{packs:new Set(['anima'])},
    finished:false, failedRun:false, usable:false, poll:null,
    chosen:() => ({data_root:'fixture-station', comfy_dir:'fixture-comfy'}),
    api:async (url, options) => {calls.push({url,options}); if (fail) throw Error('fixture rejected');},
    clearInterval(){}, setInterval(){return 1;}, refresh(){}, esc:s=>s,
  });
  vm.runInContext(text.slice(begin, end) + '\nglobalThis.startRun = startRun;', context);
  return {run:context.startRun, F, calls, hasKey:() => context.chk.data.has_key};
}
test('安裝金鑰隨開始安裝送出，成功後清空輸入，留白不覆蓋舊金鑰', async () => {
  const h = installHarness('  TEST-ONLY-KEY  '); await h.run();
  assert.equal(h.calls[0].url, '/api/setup/run');
  assert.equal(h.calls[0].options.json.civitai_key, 'TEST-ONLY-KEY');
  assert.equal(h.F('wizCivitaiKey').value, '');
  assert.equal(h.hasKey(), true);
  const blank = installHarness('  '); await blank.run();
  assert.equal(Object.hasOwn(blank.calls[0].options.json, 'civitai_key'), false);
});
test('安裝請求未送成功時保留輸入供重試，畫面不顯示金鑰', async () => {
  const h = installHarness('TEST-ONLY-KEY', true); await h.run();
  assert.equal(h.F('wizCivitaiKey').value, 'TEST-ONLY-KEY');
  assert.equal(h.F('runPhase').innerHTML.includes('TEST-ONLY-KEY'), false);
  assert.equal(h.F('nextBtn').textContent, '重試');
});
