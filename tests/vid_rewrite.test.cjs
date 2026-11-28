const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const genJs = fs.readFileSync(path.join(root, "ui", "js", "gen.js"), "utf8");

test("vidModal places AI rewrite button right below hint and above vidModelBox", () => {
  const hintIdx = html.indexOf("不用再描述圖裡已經有的東西。");
  const btnIdx = html.indexOf('id="vidRewrite"');
  const modelIdx = html.indexOf('id="vidModelBox"');
  assert.ok(hintIdx > 0 && btnIdx > hintIdx && modelIdx > btnIdx);
});

test("gen.js wires #vidRewrite to /api/h3/write with local 9b brain and First frame image", () => {
  assert.match(genJs, /F\("vidRewrite"\)\.onclick = async \(\) =>/);
  assert.match(genJs, /api\("\/api\/h3\/write"/);
  assert.match(genJs, /mode:\s*"i2v"/);
  assert.match(genJs, /brain:\s*"9b"/);
});
