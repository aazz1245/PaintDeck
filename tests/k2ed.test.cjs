const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const taglibJs = fs.readFileSync(path.join(root, "ui", "js", "taglibpage.js"), "utf8");
const genJs = fs.readFileSync(path.join(root, "ui", "js", "gen.js"), "utf8");
const hostHtml = fs.readFileSync(path.join(root, "ui", "plugin-host", "host.html"), "utf8");
const apiShim = fs.readFileSync(path.join(root, "ui", "plugin-host", "scripts", "api.js"), "utf8");
const appShim = fs.readFileSync(path.join(root, "ui", "plugin-host", "scripts", "app.js"), "utf8");

test("ui/index.html embeds native plugin iframes while preserving right generate pane", () => {
  assert.match(html, /<div class="piano row" id="tlEngineTabs" role="tablist" aria-label="隨機引擎">/);
  assert.match(html, /<button data-eng="anima" class="on" type="button" role="tab" aria-selected="true">Anima 隨機<\/button>/);
  assert.match(html, /<button data-eng="krea2" type="button" role="tab" aria-selected="false">Krea 2 隨機<\/button>/);
  assert.match(html, /<iframe id="tlWardrobeFrame" class="tlp-frame"/);
  assert.match(html, /<iframe id="tlK2edFrame" class="tlp-frame"/);
  assert.match(html, /<div id="tlPluginFallback" class="tlp-fallback" hidden><\/div>/);
  // 右側提示詞、生成鈕與模型參數欄必須保留
  assert.match(html, /id="tlBorrowMid"/);
  assert.match(html, /id="tlBorrowGen"/);
  assert.match(html, /id="tlBorrowSide"/);
});

test("taglibpage.js and gen.js drive native iframe hosts and beforeGenerate bridge", () => {
  assert.match(taglibJs, /anima:\s*"\/plugin-host\/host\.html\?engine=anima"/);
  assert.match(taglibJs, /krea2:\s*"\/plugin-host\/host\.html\?engine=krea2"/);
  assert.match(taglibJs, /PAINTDECK_PLUGIN_PROMPT/);
  assert.match(taglibJs, /PAINTDECK_PLUGIN_REROLL/);
  assert.match(genJs, /await taglibPage\.beforeGenerate\(\)/);
});

test("plugin-host shim supports both Wardrobe V6 and K2-Editorial native scripts", () => {
  assert.match(hostHtml, /\/api\/wardrobe\/ext\/anima_wardrobe_v4_studio\.js/);
  assert.match(hostHtml, /\/api\/k2ed\/ext\/k2ed_panel\.js/);
  assert.match(hostHtml, /\/api\/plugin-ui\/object_info\/\$\{CFG\.nodeName\}/);
  assert.match(apiShim, /\/anima-wardrobe-v6\/roll/);
  assert.match(apiShim, /\/k2ed\/build/);
  assert.match(appShim, /registerExtension/);
});
