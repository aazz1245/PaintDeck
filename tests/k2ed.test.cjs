const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const taglibJs = fs.readFileSync(path.join(root, "ui", "js", "taglibpage.js"), "utf8");
const genJs = fs.readFileSync(path.join(root, "ui", "js", "gen.js"), "utf8");

test("ui/index.html adds piano engine switcher while keeping #tlWardrobe intact", () => {
  assert.match(html, /<div class="piano row" id="tlEngineTabs" role="tablist" aria-label="隨機引擎">/);
  assert.match(html, /<button data-eng="anima" class="on" type="button" role="tab" aria-selected="true">Anima 隨機<\/button>/);
  assert.match(html, /<button data-eng="krea2" type="button" role="tab" aria-selected="false">Krea 2 隨機<\/button>/);
  assert.match(html, /<div class="wd" id="tlWardrobe"><\/div>/);
  assert.match(html, /<div class="wd" id="tlK2ed" hidden><\/div>/);
});

test("taglibpage.js and gen.js route engine switching and beforeGenerate cleanly", () => {
  assert.match(taglibJs, /store\.get\("tl_engine",\s*"anima"\)/);
  assert.match(taglibJs, /k2ed\.init\(\{\s*box:\s*\$\("#tlK2ed"\),\s*onApply:\s*applyPrompt\s*\}\)/);
  assert.match(genJs, /store\.get\("tl_engine",\s*"anima"\)\s*===\s*"krea2"\s*\?\s*k2ed\s*:\s*wardrobe/);
});

const vm = require("node:vm");

function loadK2ed() {
  const source = fs.readFileSync(path.join(root, "ui", "js", "k2ed.js"), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "")
    .replace(/import\.meta\.url/g, '"file:///ui/js/k2ed.js"').replace(/\bimport\(/g, "(async () => ({}))(");
  const context = vm.createContext({
    console, URL, URLSearchParams,
    store: { get: (k, d) => d, set() {} }, toast() {}, el: () => ({}), api: async () => ({}), fixHair: (s) => s,
  });
  vm.runInContext(source + "\nglobalThis.subject = { buildQuery, pickRandomItem };", context, { filename: "k2ed.js" });
  return context.subject;
}

test("k2ed.js pure helpers buildQuery and pickRandomItem work as expected", () => {
  const mod = loadK2ed();

  const qs1 = mod.buildQuery(
    { aspect: "auto", costume: "auto", textMode: "all", display: "HELLO", pinItem: "lib:coat1" },
    { motif: "k2x_still_section", char: "miku", motifRatio: "2:3" },
  );
  const p1 = new URLSearchParams(qs1);
  assert.equal(p1.get("motif"), "k2x_still_section");
  assert.equal(p1.get("char"), "miku");
  assert.equal(p1.get("aspect"), "2:3");
  assert.equal(p1.get("costume"), "auto");
  assert.equal(p1.get("item"), "lib:coat1");
  assert.equal(p1.get("display"), "HELLO");
  assert.equal(p1.get("notext"), null);

  const qs2 = mod.buildQuery(
    { aspect: "16:9", costume: "keep", textMode: "notext", display: "", pinItem: "" },
    { motif: "m1", char: "keep", motifRatio: "2:3" },
  );
  const p2 = new URLSearchParams(qs2);
  assert.equal(p2.get("aspect"), "16:9");
  assert.equal(p2.get("costume"), "keep");
  assert.equal(p2.get("notext"), "1");

  assert.equal(mod.pickRandomItem(["a", "b", "c"], "pinned", ["b"]), "pinned");
  assert.equal(mod.pickRandomItem(["a", "b", "c"], "", ["b", "c"], () => 0.9), "c");
  assert.equal(mod.pickRandomItem(["a", "b", "c"], "", [], () => 0.0), "a");
});
