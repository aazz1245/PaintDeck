const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const genJs = fs.readFileSync(path.join(root, "ui", "js", "gen.js"), "utf8");

test("ui/index.html renders #refKrea2Row controls for Krea 2 Style Transfer", () => {
  assert.match(html, /id="refKrea2Row"/);
  assert.match(html, /id="refKrea2Mode"/);
  assert.match(html, /id="refKrea2Fit"/);
  assert.match(html, /id="refKrea2Str"/);
  assert.match(html, /id="refKrea2RefK"/);
  assert.match(html, /id="refKrea2Primary"/);
  assert.match(html, /id="refKrea2Ratio"/);
});

test("ui/js/gen.js enables krea2 in multiref and collects krea2_style params", () => {
  assert.match(genJs, /const canRef = q \|\| fam\(\) === "moss" \|\| fam\(\) === "krea2";/);
  assert.match(genJs, /F\("refKrea2Row"\)\.hidden = !\(fam\(\) === "krea2" && S\.mode === "multiref"\);/);
  assert.match(genJs, /if \(fam\(\) === "krea2" && S\.mode === "multiref"\) \{\s*p\.krea2_style = \{/);
  assert.match(genJs, /if \(n > 2\) return toast\("Krea 2 風格參考最多支援 2 張參考圖/);
});
