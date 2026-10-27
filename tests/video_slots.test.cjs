const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const assert = require('node:assert/strict'), { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const plain = x => JSON.parse(JSON.stringify(x));
const walk = n => !n || typeof n !== 'object' ? [] : [n, ...(n.children || []).flat(Infinity).flatMap(walk)];
const slot = (key, kind, node, input) => ({key, kind, node, input, label:key, role:kind === 'audio' ? 'voice' : 'reference'});
const image = slot('hero','image','52','image'), audio = slot('voice','audio','71','audio');
function load(extra={}) {
  const el=(tag,attrs={},...children)=>Object.assign({tag,children:children.flat(Infinity),value:'',append(...c){this.children.push(...c);}},attrs);
  const c=vm.createContext({el,toast(){},pickFile:async()=>({name:'voice.wav'}),uploadFile:async()=>({name:'aw_voice.wav'}),...extra});
  const src=fs.readFileSync(path.join(root,'ui/js/video-slots.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
  vm.runInContext(src+'\nglobalThis.api={mediaSlots,mediaBasename,mediaSlotParams,mediaSlotsControl};',c);
  return c.api;
}
test('each named input keeps its own file and omitted inputs preserve workflow values',()=>{
  const a=load(), slots=[image,audio];
  assert.deepEqual(plain(a.mediaSlotParams(slots,{hero:'hero.png',voice:'voice.wav'})),{hero:'hero.png',voice:'voice.wav'});
  assert.deepEqual(plain(a.mediaSlotParams(slots,{hero:'',voice:'voice.wav',unmapped:'no.png'})),{voice:'voice.wav'});
  assert.equal(a.mediaSlots({info:{media_slots:slots}}).length,2);
});
test('paths, urls, wrong media types and duplicate mapping targets cannot be submitted',()=>{
  const a=load();
  for(const file of ['../hero.png','C:\\hero.png','https://example.com/a.png','a/b.png',' voice.png','voice.wav'])
    assert.throws(()=>a.mediaSlotParams([image],{hero:file}));
  assert.throws(()=>a.mediaSlotParams([image,{...image,key:'other'}],{}),/重複/);
  assert.throws(()=>a.mediaSlotParams([image,{...audio,key:'hero'}],{}),/重複/);
});
test('audio picker uploads only to its own slot and blocks generation until completed',async()=>{
  let resolve,requested,kind;
  const a=load({pickFile:async accept=>{requested=accept;return {name:'source.wav'};},uploadFile:async(f,k)=>{kind=k;return new Promise(r=>resolve=r);}});
  const ctl=a.mediaSlotsControl({engine:{media_slots:[image,audio]},values:{hero:'hero.png'}});
  const buttons=walk(ctl.element).filter(n=>n.tag==='button' && n.children.includes('選檔上傳…'));
  const running=buttons[1].onclick(); await new Promise(setImmediate);
  assert.equal(kind,'audio'); assert.match(requested,/\.wav/); assert.throws(()=>ctl.read(),/上傳/);
  resolve({name:'new_voice.wav'}); await running;
  assert.deepEqual(plain(ctl.read()),{hero:'hero.png',voice:'new_voice.wav'});
});
test('late upload cannot change the current workflow or saved selection',async()=>{
  let resolve,current=true,changed=0;
  const a=load({uploadFile:async()=>new Promise(r=>resolve=r)});
  const ctl=a.mediaSlotsControl({engine:{media_slots:[audio]},isCurrent:()=>current,onchange:()=>changed++});
  const running=walk(ctl.element).find(n=>n.tag==='button'&&n.children.includes('選檔上傳…')).onclick();
  await new Promise(setImmediate);current=false;resolve({name:'new_voice.wav'});await running;
  assert.equal(changed,0); assert.deepEqual(plain(ctl.read()),{});
});
test('shared uploader routes audio/video correctly and picker restores image defaults',async()=>{
  const calls=[],input={files:[],click(){this.onchange();}},c=vm.createContext({FormData:class{append(){}},api:async(url)=>{calls.push(url);return {};},$:()=>input});
  const src=fs.readFileSync(path.join(root,'ui/js/util.js'),'utf8');
  const part=src.slice(src.indexOf('export async function uploadFile'),src.indexOf('// 拖放、選檔共用')).replace(/^export /gm,'');
  vm.runInContext(part+'\nglobalThis.u={uploadFile,pickFile};',c);
  await c.u.uploadFile({name:'voice.wav'},'audio'); await c.u.uploadFile({name:'clip.mp4'},'video'); await c.u.uploadFile({name:'image.png'});
  assert.deepEqual(calls,['/api/video/media/upload?kind=audio','/api/video/media/upload?kind=video','/api/upload?kind=image']);
  await c.u.pickFile('.wav');assert.equal(input.accept,'.wav');await c.u.pickFile();assert.equal(input.accept,'image/*');
});
