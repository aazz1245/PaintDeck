const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function element(tag,attrs={},...children){return Object.assign({tag,children:children.flat(),value:'',options:[],checked:false,disabled:false,classList:{add(){},remove(){},toggle(){}},append(...x){this.children.push(...x);},replaceChildren(...x){this.children=x;},before(){},remove(){}},attrs);}
function subject(api,extra={}){
 const elements=new Map();
 const source=fs.readFileSync(path.join(__dirname,'../ui/js/h3chain.js'),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'').replace(/import\("\.\/shotsheet\.js"\)/g,'Promise.resolve(shotSheet)');
 const context=vm.createContext({structuredClone,console,setTimeout,clearTimeout,el:element,api,toast(){},confirm:()=>true,
  store:{get:(_,d)=>d,set(){}},document:{getElementById(id){if(!elements.has(id))elements.set(id,element('div'));return elements.get(id);}},
  pickFromGallery(){},openLightboxRecord(){},shotSheet:{offerLoad(){},precheck:async()=>true},...extra});
 vm.runInContext(source+`\npaint=()=>{};paintEst=()=>{};paintRun=()=>{};paintSegs=()=>{};setStatus=()=>{};
 globalThis.subject={open,loadList,save,run,join,pickInto,takesEl,running,sizeLocked,get:()=>chain,set:(x)=>{chain=x;}};`,context);
 return context.subject;
}
test('late open response cannot replace another H3 project',async()=>{
 const a=deferred(),b=deferred();const s=subject(url=>url.endsWith('/A')?a.promise:b.promise);
 const one=s.open('A');const two=s.open('B');b.resolve({id:'B'});await two;a.resolve({id:'A'});await one;
 assert.equal(s.get().id,'B');
});
test('failed draft save prevents submitting a generation request',async()=>{
 const calls=[];const s=subject(async(url)=>{calls.push(url);throw Error('save failed');});
 s.set({id:'A',segments:[{text:'hello'}]});await s.run();
 assert.deepEqual(calls,['/api/h3/chain/save']);
});
test('adopting selected older take can dismiss a pending candidate and does not overwrite a newly opened project',async()=>{
 const response=deferred();let selecting;
 const s=subject(async(url,opts)=>{
   if(url.endsWith('/save'))return {...opts.json.chain,updated:3};
   if(url.endsWith('/take/select')){selecting=opts.json;return response.promise;}
   throw Error(url);
 });
 const seg={status:'done',selected_take:'old',pending_take:'new',takes:[{id:'old',label:'old',recipe:{},result:{files:{}}},{id:'new',label:'new',recipe:{},result:{files:{}}}]};
 s.set({id:'A',segments:[seg]});
 const tree=s.takesEl(seg,0);const walk=(x)=>[x,...(x?.children||[]).flatMap(c=>typeof c==='object'?walk(c):[])];
 const adopt=walk(tree).find(x=>x?.tag==='button'&&x.children.includes('已採用'));
 assert.equal(adopt.disabled,false);
 const task=adopt.onclick();await new Promise(setImmediate);
 assert.equal(selecting.take_id,'old');
 s.set({id:'B',segments:[]});response.resolve({id:'A',segments:[seg]});await task;
 assert.equal(s.get().id,'B');
});

test('late list refresh cannot reopen its old project after navigation',async()=>{
 const response=deferred(),calls=[];
 const s=subject(async url=>{calls.push(url);if(url==='/api/h3/chains')return response.promise;return {id:'B',segments:[]};});
 s.set({id:'A',segments:[]});const pending=s.loadList('A');await s.open('B');
 response.resolve({chains:[{id:'A',title:'A'},{id:'B',title:'B'}]});await pending;
 assert.equal(s.get().id,'B');assert.deepEqual(calls,['/api/h3/chains','/api/h3/chain/B']);
});

test('late image upload cannot write into or save the newly opened project',async()=>{
 const upload=deferred();let saves=0;
 const s=subject(async url=>{if(url==='/api/h3/media')return upload.promise;if(url.endsWith('/B'))return {id:'B',first:'b.png',segments:[]};saves++;},
   {pickFromGallery:async cb=>cb({id:7})});
 s.set({id:'A',first:'a.png',segments:[]});
 const pending=s.pickInto(name=>{s.get().first=name;saves++;},'gallery');await new Promise(setImmediate);
 await s.open('B');upload.resolve({kind:'image',name:'a-upload.png'});await pending;
 assert.equal(s.get().first,'b.png');assert.equal(saves,0);
});

test('late run and join responses cannot mark a different project running',async()=>{
 for(const action of ['run','join']){
  const response=deferred(),calls=[];
  const s=subject(async(url,opts)=>{
   calls.push(url);if(url.endsWith('/save'))return {...opts.json.chain,updated:1};
   if(url.endsWith('/'+action))return response.promise;
   if(url.endsWith('/B'))return {id:'B',running:false,segments:[]};throw Error(url);
  });
  s.set({id:'A',running:false,segments:[{text:'action',status:'todo'}]});
  const pending=s[action]();await new Promise(setImmediate);await s.open('B');response.resolve({ok:true});await pending;
  assert.equal(s.get().id,'B');assert.equal(s.get().running,false);
  assert.equal(calls.filter(x=>x==='/api/h3/chain/B').length,1);
 }
});

test('navigation during shot-sheet precheck prevents submitting or saving the new project',async()=>{
 const precheck=deferred(),calls=[];
 const s=subject(async url=>{calls.push(url);return {id:'B',segments:[]};},{shotSheet:{offerLoad(){},precheck:()=>precheck.promise}});
 s.set({id:'A',sheet:{},segments:[{text:'A action'}]});const pending=s.run();await new Promise(setImmediate);
 await s.open('B');precheck.resolve(true);await pending;
 assert.deepEqual(calls,['/api/h3/chain/B']);
});

test('saving synchronizes invalidated results while keeping segment object and draft text',async()=>{
 const seg={text:'new action',status:'done',selected_take:'old',files:{end:'old.mp4'},takes:[{id:'old'}]};
 const s=subject(async(_,opts)=>({...opts.json.chain,segments:[{text:'new action',status:'todo',selected_take:null,files:null,takes:[{id:'old'}]}],final:null}));
 s.set({id:'A',segments:[seg],final:{id:9}});assert.equal(await s.save(),true);
 assert.equal(s.get().segments[0],seg);assert.equal(seg.text,'new action');assert.equal(seg.status,'todo');
 assert.equal(seg.selected_take,null);assert.equal(seg.files,null);assert.equal(seg.takes[0].id,'old');assert.equal(s.get().final,null);
});

test('an in-flight adoption only locks its own project',async()=>{
 const response=deferred();const seg={status:'review',pending_take:'new',takes:[{id:'new',result:{files:{}}}]};
 const s=subject(async(url,opts)=>url.endsWith('/save')?opts.json.chain:url.endsWith('/B')?{id:'B',segments:[]}:response.promise);
 s.set({id:'A',segments:[seg]});const walk=x=>[x,...(x?.children||[]).flatMap(c=>typeof c==='object'?walk(c):[])];
 const button=walk(s.takesEl(seg,0)).find(x=>x?.tag==='button'&&x.children.includes('採用這版'));
 const pending=button.onclick();await new Promise(setImmediate);assert.equal(s.running(),true);
 await s.open('B');assert.equal(s.running(),false);response.resolve({id:'A',segments:[seg]});await pending;
 assert.equal(s.get().id,'B');
});

test('pending review and saved dimensions lock ratio even without a done segment',()=>{
 const s=subject(async()=>({}));
 for(const value of [{segments:[{status:'review',pending_take:'x'}]},{segments:[{status:'todo',takes:[{id:'x'}]}]},{size:[640,960],segments:[{status:'error'}]}]){
  s.set(value);assert.equal(s.sizeLocked(),true);
 }
 s.set({size:null,segments:[{status:'todo'}]});assert.equal(s.sizeLocked(),false);
});
