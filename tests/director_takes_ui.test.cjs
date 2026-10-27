const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(tag, attrs = {}, ...children) {
  return Object.assign({ tag, value: '', options: [], children, hidden: false, disabled: false, dataset: {},
    classList: { contains() { return false; }, add() {}, remove() {}, toggle() {} },
    append(...kids) { this.children.push(...kids); this.options.push(...kids.filter(k => k?.tag === 'option')); },
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {},
  }, attrs);
}
function load(filename, globals, expose) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/js', filename), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  vm.runInContext(source + `\nglobalThis.subject = ${expose};`, context, { filename });
  return context.subject;
}
function director(api, initial) {
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element('div')); return nodes.get(id); };
  get('dirReview').checked = true;
  get('dirRedo').checked = false;
  const subject = load('director.js', {
    document: { getElementById: get }, api, el: element, debounce: () => () => {}, toast() {},
    store: { get: (_, d) => d, set() {} }, gen: {}, drawer: {}, renderTakePanel: () => null,
    mediaSlotsControl: () => ({ element: element('div'), read: () => ({}) }), layoutEditor: () => ({ setAspect() {}, set() {}, el: element('div') }),
  }, `{ run, selectTake, openProject, current: () => P, setProject: (p) => {P=p;running=false;} }`);
  subject.setProject(initial);
  return { subject, get };
}

test('candidate adoption only calls save and take/select, never generation', async () => {
  const calls = [], p = { id: 'p1', title: 'film', settings: {}, segments: [] };
  const { subject } = director(async (url, opts) => { calls.push([url, opts?.json]); return { ...p, updated: 1 }; }, p);
  await subject.selectTake(0, 'take-old');
  assert.deepEqual(calls.map(c => c[0]), ['/api/director/project', '/api/director/take/select']);
  assert.equal(calls[1][1].take_id, 'take-old');
  assert.equal(calls[1][1].index, 0);
});

test('review mode is submitted explicitly and save failure never starts generation', async () => {
  const calls = [], p = { id: 'p1', settings: {}, segments: [] };
  const { subject, get } = director(async (url, opts) => {
    calls.push([url, opts?.json]);
    return { ...p, running: url === '/api/director/project/p1', updated: 2 };
  }, p);
  await subject.run({ only: 0 });
  assert.equal(calls.find(c => c[0] === '/api/director/run')[1].review, true);
  get('dirReview').checked = false;
  subject.setProject(p); calls.length = 0;
  await subject.run({ only: 0 });
  assert.equal(calls.find(c => c[0] === '/api/director/run')[1].review, false);
  const denied = director(async () => { throw new Error('save failed'); }, p);
  assert.equal(await denied.subject.run({ only: 0 }), undefined);
});

test('late adoption cannot replace a different project opened while request was pending', async () => {
  let finish;
  const a = { id: 'a', settings: {}, segments: [] }, b = { id: 'b', settings: {}, segments: [] };
  const { subject } = director(async (url) => url.endsWith('/select') ? new Promise(r => { finish = r; }) : a, a);
  const selected = subject.selectTake(0, 'take1');
  await new Promise(r => setImmediate(r));
  subject.setProject(b);
  finish(a); await selected;
  assert.equal(subject.current().id, 'b');
});

test('take panel previews every saved version and exposes only an explicit adoption action', () => {
  const adopted = [];
  const { renderTakePanel, pendingTake } = load('film-takes.js', { el: element }, '{ renderTakePanel, pendingTake }');
  const seg = { selected_take: 'old', pending_take: 'new', takes: [
    { id: 'old', label: 'old', result: { video_id: 1 }, recipe: { params: { seed: 5 } } },
    { id: 'new', label: 'new', result: { video_id: 2 }, recipe: { params: { seed: 6 } } },
  ] };
  const panel = renderTakePanel({ seg, onSelect: id => adopted.push(id) });
  const flatten = x => !x || typeof x !== 'object' ? [] : [x, ...(x.children || []).flatMap(flatten)];
  const all = flatten(panel);
  assert.deepEqual(all.filter(n => n.tag === 'video').map(n => n.src), ['/img/2', '/img/1']);
  assert.equal(pendingTake(seg).id, 'new');
  all.find(n => n.tag === 'button').onclick();
  assert.deepEqual(adopted, ['new']);
  assert.equal(seg.selected_take, 'old', 'UI callback does not mutate current output before server accepts');
});

test('opening a sheet-created project selects it and displays its engine over the global default', async () => {
  const p = { id: 'new-film', title: 'New film', settings: { video_engine: 'ltx23', seconds: 7.5 }, segments: [] };
  const { subject, get } = director(async url => url === '/api/video/workflows'
    ? { engine: 'h3', builtin: { id: 'ltx23', name: 'LTX local' }, workflows: [] } : p, null);
  await subject.openProject('new-film');
  assert.equal(get('dirProj').value, 'new-film');
  assert.ok(get('dirProj').options.some(o => o.value === 'new-film'));
  assert.ok(get('dirVidEngine').textContent.includes('LTX local'));
  assert.equal(get('dirSecs').value, '7.5');
});
