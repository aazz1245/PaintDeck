const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'..')+'/';
const {test}=require('node:test');
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function el(tag,attrs={},...children){return Object.assign({tag,value:'',children,hidden:false,disabled:false,style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(t,f){(this.events||={})[t]=f;},replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},focus(){},scrollIntoView(){},querySelectorAll(){return [];}},attrs);}
function sheet(api,extra={}){
 const nodes=new Map(),saved={},asked=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,el('div'));return nodes.get(id);};
 const c=vm.createContext({structuredClone,Event,console,setTimeout,clearTimeout,api,el,toast(){},store:{get:(_,d)=>d,set:(k,v)=>saved[k]=structuredClone(v)},debounce:()=>()=>{},confirm:m=>{asked.push(m);return true;},studio:{openVideo(){}},assets:{list:async()=>[]},openModal:s=>node(s.slice(1)).hidden=false,closeModal:s=>node(s.slice(1)).hidden=true,document:{getElementById:node,addEventListener(){},activeElement:null},...extra});
 const src=fs.readFileSync(root+'ui/js/shotsheet.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
 vm.runInContext(src+'\nglobalThis.s={load,current,composeNow,save,polish,applyTo,offerLoad,promptsEl,issuesDialog,addRef,setSegCount};',c);
 return {s:c.s,node,saved,asked};
}
const reports=[];
test('late compose preserves loaded draft',async()=>{
  const r=deferred(),m=sheet(()=>r.promise);m.s.load({title:'A',segments:[{prompt:'A-old'}]});const p=m.s.composeNow();
  m.s.load({title:'B',segments:[{prompt:'B-keep'}]});r.resolve({segments:[{prompt:'A-late',mirror:'A-en'}]});await p;
  assert.equal(m.s.current().segments[0].prompt,'B-keep');reports.push(['late_compose_crosses_load',m.s.current().title,m.s.current().segments[0].prompt]);
 
});

test('manual mirror survives automatic compose',async()=>{
  const m=sheet(async()=>({segments:[{prompt:'generated',mirror:'generated mirror'}]}));m.s.load({segments:[{prompt:'generated',mirror:'old mirror'}]});
  const tree=m.s.promptsEl();const walk=n=>{if(!n||typeof n!=='object')return [];return [n,...(n.children||[]).flatMap(walk)];};const ta=walk(tree).find(n=>n.id==='shM0');
  ta.value='hand-edited translation';ta.events.input();await m.s.composeNow();assert.equal(m.s.current().segments[0].mirror,'hand-edited translation');reports.push(['manual_mirror_overwritten',m.s.current().segments[0].manual,m.s.current().segments[0].mirror]);
 
});

test('apply waits for current composition',async()=>{
  const calls=[],m=sheet(async()=>({segments:[{prompt:'NEW action',mirror:''}]}),{h3:{applySheet:async x=>calls.push(x)}});
  m.s.load({segments:[{prompt:'OLD action',beats:[{from:0,to:4,action:'OLD action'}]}]});m.s.current().segments[0].beats[0].action='NEW action';m.s.save();await m.s.applyTo();
  assert.equal(calls[0].prompt,'NEW action');reports.push(['apply_before_debounce_uses_old_prompt',calls[0].prompt]);
 
});

test('polish preserves edits made while waiting',async()=>{
  const r=deferred(),m=sheet(()=>r.promise);m.s.load({segments:[{prompt:'before'}]});const p=m.s.polish(0,'9b');m.s.current().segments[0].prompt='new manual edit';m.s.current().segments[0].manual=true;r.resolve({prompt:'late AI',mirror:'late mirror'});await p;
  assert.equal(m.s.current().segments[0].prompt,'new manual edit');reports.push(['polish_overwrites_later_edit',m.s.current().segments[0].prompt]);
 
});

test('loading a chain asks about scene-only draft',async()=>{
  const m=sheet(async()=>({}));m.s.load({scene:{text:'unsaved scene'},camera:'unsaved camera',sound:{ambient:'unsaved sound'}});m.s.offerLoad({scene:{text:'chain scene'}});
  assert.equal(m.asked.length,1);reports.push(['offerLoad_loses_scene_without_question',m.s.current().scene.text,m.asked.length]);
 
});

test('shrinking asks about sound-only segment',async()=>{
  const m=sheet(async()=>({}));m.s.load({segments:[{}, {beats:[{from:0,to:4,sfx:'door closes'}]}]});m.s.setSegCount(1);assert.equal(m.asked.length,1);reports.push(['shrink_loses_sound_only',m.asked.length]);
 
});

test('concurrent references respect limit',async()=>{
  const m=sheet(async()=>({})),r=deferred();m.s.load({refs:{on:true,items:Array.from({length:7},(_,i)=>({file:'r'+i+'.png'}))}});
  const p1=m.s.addRef(()=>r.promise),p2=m.s.addRef(()=>r.promise);r.resolve({name:'new.png'});await Promise.all([p1,p2]);assert.equal(m.s.current().refs.items.length,8);reports.push(['concurrent_refs_exceed_limit',m.s.current().refs.items.length]);
 
});

test('clicking check issue resolves cancellation',async()=>{
  const m=sheet(async()=>({}));let settled=false;const p=m.s.issuesDialog([{seg:0,rule:1,msg:'test'}]).then(()=>settled=true);
  m.node('shCheckList').children[0].onclick();await tick();assert.equal(settled,true);assert.equal(m.node('shCheckModal').hidden,true);reports.push(['click_issue_closes_but_does_not_resolve',settled]);m.node('shCheckBack').onclick();await p;
 
});

test('old picker choice cannot resolve new picker',async()=>{
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,el('div'));return nodes.get(id);};const choose=deferred();let num=0;
  const c=vm.createContext({console,el,api:async(url)=>url==='/api/generate'?{jobs:[{job:String(++num)}]}:choose.promise,toast(){},gen:{collectParams:()=>({})},openModal(){},closeModal(){},document:{getElementById:node}});
  vm.runInContext(fs.readFileSync(root+'ui/js/framepick.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.f={pick,choose,finish,onImage};',c);
  const p1=c.f.pick();await tick();const choosing=c.f.choose({id:11});c.f.finish(null);assert.equal(await p1,null);
  const p2=c.f.pick();await tick();choose.resolve({name:'old-run.png'});await choosing;let done=false;p2.then(()=>done=true);await tick();assert.equal(done,false);c.f.finish(null);await p2;
 
});

test('camera cheat labels and tooltips have English translations',()=>{
 const rules=JSON.parse(fs.readFileSync(root+'resources/h3/sheet_rules.json','utf8'));
 const exact=JSON.parse(fs.readFileSync(root+'ui/i18n/en.json','utf8')).exact;
 for(const items of Object.values(rules.cheat)) for(const [label,zh] of items) for(const text of [label,zh]) if(/[\u3400-\u9fff]/.test(text)) assert.ok(exact[text],text);
});

test('template empty reference slots are filled before appending',async()=>{
 const m=sheet(async()=>({}));m.s.load({refs:{on:true,items:Array.from({length:8},(_,i)=>({asset_id:i+1,file:null}))}});
 await m.s.addRef(async()=>({name:'new.png',asset_id:99}));
 assert.equal(m.s.current().refs.items.length,8);
 assert.equal(m.s.current().refs.items.filter(x=>x.file).length,1);
});

test('check modal cancellation resolves false',async()=>{
 const m=sheet(async()=>({}));
 const pending=m.s.issuesDialog([{seg:0,msg:'test'}]);
 m.node('shCheckModal').oncancel();
 assert.equal(await pending,false);
});
test('editing during an outstanding composition invalidates its response',async()=>{
 const r=deferred(),m=sheet(()=>r.promise);
 m.s.load({segments:[{prompt:'keep'}]});
 const pending=m.s.composeNow();
 m.s.current().camera='new camera';m.s.save();
 r.resolve({segments:[{prompt:'stale'}]});await pending;
 assert.equal(m.s.current().segments[0].prompt,'keep');
});
