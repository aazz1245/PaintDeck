const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../ui/js/studio.js'), 'utf8');

function harness() {
  const nodes = new Map();
  const F = id => {
    if (!nodes.has(id)) nodes.set(id, {disabled:false, children:[], replaceChildren(){this.children=[];}, append(...v){this.children.push(...v);}});
    return nodes.get(id);
  };
  let consent = false;
  let clear = async () => ({bytes:100,removed:1,skipped:0});
  const calls=[], messages=[];
  const context = vm.createContext({F, sess:{id:'fixture'}, stopPlay(){}, fmtBytes:n=>n+' B', encodeURIComponent,
    el:(tag, attrs, ...children)=>({tag,attrs,children}), confirm:()=>consent, openModal(){},closeModal(){},
    store:{get:()=>null},renderSess(){},framesShow:async()=>{},toast:(...args)=>messages.push(args),
    api:async (url,opts)=>{
      calls.push({url,opts});
      if (url.endsWith('/clear')) return clear();
      return {session:{path:'fixture/data/frames/fixture',bytes:100,sessions:1,skipped:0},trash:{path:'fixture/trash',bytes:0,sessions:0,skipped:0}};
    },
  });
  vm.runInContext(source.slice(source.indexOf('async function showFrameStorage()'),source.indexOf('async function delSess()')),context);
  return {F,calls,messages,context,open:()=>context.showFrameStorage(),consent:()=>{consent=true;},respond:fn=>{clear=fn;}};
}

test('拆幀清理先列位置與大小；取消不刪，確認僅送選定的拆幀', async()=>{
  const h=harness(); await h.open();
  assert.equal(h.F('frClearTrash').disabled,true);
  assert.match(JSON.stringify(h.F('frStorageInfo').children),/fixture\/data\/frames\/fixture/);
  await h.F('frClearSession').onclick(); assert.equal(h.calls.length,1);
  h.consent(); await h.F('frClearSession').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1].opts.json)),{scope:'session',sid:'fixture',confirm:true});
  assert.equal(h.context.sess,null);
  assert.match(h.messages[0][0],/100 B/);
});

test('拆幀清理連按不重送；失敗後可重新檢查且保留選中專案',async()=>{
  const h=harness(); await h.open(); h.consent();
  let reject;
  h.respond(()=>new Promise((_,no)=>{reject=no;}));
  const running=h.F('frClearSession').onclick();
  await h.F('frClearSession').onclick();
  assert.equal(h.calls.filter(c=>c.url.endsWith('/clear')).length,1);
  reject(Error('fixture busy')); await running;
  assert.equal(h.F('frStorage').disabled,false);
  assert.equal(h.context.sess.id,'fixture');
  assert.match(h.messages[0][0],/fixture busy/);
});

test('部分清理失敗會提示且保留專案供重試',async()=>{
  const h=harness(); await h.open(); h.consent();
  h.respond(async()=>({bytes:40,removed:0,skipped:1}));
  await h.F('frClearSession').onclick();
  assert.equal(h.context.sess.id,'fixture');
  assert.match(h.messages[1][0],/部分檔案未清除/);
});
