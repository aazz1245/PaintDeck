const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 純程式測試：讀實際 HTML 的控制項，執行原始模組及 API 包裝；fetch 僅回固定資料。
// 不啟動瀏覽器、不連 localhost、不安裝更新。
const ready = {
  current_version:'26.1024.1', enabled:true, channel:'public', auto_check:true,
  phase:'available', busy_reason:null,
  update:{version:'26.1024.2', notes:'fixture release notes'},
};
function moduleSubject(file, names, globals) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext(globals);
  vm.runInContext(source + '\nglobalThis.subject = {' + names.join(',') + '};', context);
  return context.subject;
}
async function harness(initial = ready) {
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    nodes.set('#' + match[1], {
      hidden:/\shidden\b/.test(match[0]), disabled:/\sdisabled\b/.test(match[0]),
      checked:false, textContent:'',
      set innerHTML(_) { throw Error('Release notes must remain plain text'); },
    });
  }
  const requests = [], toasts = [], confirmations = [], polls = [];
  let current = structuredClone(initial), responder, consent = false;
  const document = {querySelector:id => nodes.get(id) || null, addEventListener() {}};
  const {api, openModal} = moduleSubject('util.js', ['api', 'openModal'], {
    document, AbortController, setTimeout, clearTimeout,
    fetch:async (url, options) => {
      const request = {url, method:options.method || 'GET', body:options.body && JSON.parse(options.body),
        hasTimeoutSignal:!!options.signal};
      requests.push(request);
      if (responder) return responder(request);
      return {ok:true, json:async () => structuredClone(current)};
    },
  });
  const subject = moduleSubject('updates.js', ['init'], {
    $:document.querySelector, api, openModal, toast:(...args) => toasts.push(args),
    confirm:message => { confirmations.push(message); return consent; },
    setInterval:callback => { polls.push(callback); return polls.length; },
  });
  subject.init();
  await new Promise(setImmediate);
  return {
    node:id => { assert.ok(nodes.has('#' + id), 'missing HTML control ' + id); return nodes.get('#' + id); },
    requests, toasts, confirmations, polls,
    state:value => { current = structuredClone(value); },
    respond:callback => { responder = callback; },
    consent:value => { consent = value; },
  };
}
test('實際 HTML 的更新按鈕載入狀態，說明按鈕開啟更新視窗', async () => {
  const h = await harness();
  assert.equal(h.node('updateVersion').textContent, ready.current_version);
  assert.equal(h.node('updateInstall').disabled, false);
  assert.equal(h.node('updateModal').hidden, true);
  h.node('updateDetails').onclick();
  await new Promise(setImmediate);
  assert.equal(h.node('updateModal').hidden, false);
  assert.equal(h.node('updateNotes').textContent, ready.update.notes);
  assert.ok(h.requests.every(r => r.url === '/api/app/update'));
});
test('按檢查遇到請求失敗後仍保留離線說明，並可再次檢查', async () => {
  const h = await harness({...ready, update:null, phase:'current'});
  h.respond(async () => { throw Error('fixture connection failed'); });
  await h.node('updateCheck').onclick();
  assert.match(h.node('updateHint').textContent, /暫時連不到 GitHub/);
  assert.equal(h.node('updateCheck').disabled, false);
  h.respond(async () => ({ok:true, json:async () => structuredClone(ready)}));
  await h.node('updateCheck').onclick();
  assert.match(h.node('updateHint').textContent, /有新版可用/);
  assert.equal(h.node('updateInstall').disabled, false);
  assert.equal(h.requests.at(-1).method, 'POST');
});
test('自動檢查存檔失敗會回復原勾選並顯示錯誤', async () => {
  const h = await harness();
  h.node('updateAuto').checked = false;
  h.respond(async () => ({ok:false, status:500, json:async () => ({error:'fixture save failed'})}));
  await h.node('updateAuto').onchange();
  assert.equal(h.node('updateAuto').checked, true);
  assert.deepEqual(h.requests.at(-1).body, {auto_check:false});
  assert.deepEqual(h.toasts.at(-1), ['fixture save failed', 'err']);
});
test('取消安裝確認不送出安裝請求，忙碌後也不能開始安裝', async () => {
  const h = await harness();
  await h.node('updateInstall').onclick();
  assert.match(h.confirmations[0], /26\.1024\.2/);
  assert.equal(h.requests.filter(r => r.url.endsWith('/install')).length, 0);
  h.state({...ready, busy_reason:'fixture generation is running'});
  await h.polls[0]();
  await h.node('updateInstall').onclick();
  assert.equal(h.node('updateInstall').disabled, true);
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.node('updateReason').textContent, 'fixture generation is running');
});
test('私人版在 HTML 控制項上停用更新及自動檢查', async () => {
  const h = await harness({...ready, enabled:false, channel:'private', update:null});
  for (const id of ['updateCheck', 'updateAuto', 'updateInstall']) assert.equal(h.node(id).disabled, true);
  assert.equal(h.node('updateAuto').checked, false);
  assert.equal(h.node('updateNotice').hidden, true);
  assert.match(h.node('updateHint').textContent, /私人版維持手動更新/);
});
test('確認安裝只送目前版本及確認旗標，後續安裝狀態停用按鈕', async () => {
  const h = await harness();
  h.consent(true);
  h.respond(async request => {
    if (request.url === '/api/app/update/install') {
      h.state({...ready, phase:'installing'});
      return {ok:true, json:async () => ({ok:true})};
    }
    return {ok:true, json:async () => ({...ready, phase:'installing'})};
  });
  await h.node('updateInstall').onclick();
  await new Promise(setImmediate);
  const install = h.requests.filter(r => r.url === '/api/app/update/install');
  assert.equal(install.length, 1);
  assert.deepEqual(install[0].body, {version:'26.1024.2', confirm:true});
  assert.equal(install[0].method, 'POST');
  assert.equal(install[0].hasTimeoutSignal, false);
  assert.equal(h.node('updateInstall').disabled, true);
  assert.equal(h.node('updateCheck').disabled, true);
  assert.match(h.node('updateProgress').textContent, /正在安裝/);
});
