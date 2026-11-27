const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const genJs = fs.readFileSync(path.join(root, "ui", "js", "gen.js"), "utf8");

test("ui/js/gen.js includes krea2 in BUILTIN_FAMS and BASIC_NEEDS", () => {
  assert.match(genJs, /const BUILTIN_FAMS\s*=\s*\[[^\]]*"krea2"[^\]]*\]/);
  assert.match(genJs, /krea2:\s*\["text_encoders\/qwen3vl_4b",\s*"vae\/qwen_image_vae\."\]/);
});

test("ui/js/gen.js applies Krea 2 Turbo defaults for krea2_turbo_fp8_scaled", () => {
  assert.match(genJs, /function isTurboModel\(\)\s*\{\s*return \/turbo\/i\.test\(/);
  assert.equal(/turbo/i.test("krea2_turbo_fp8_scaled.safetensors"), true);
  assert.match(genJs, /const KREA2_DEFAULTS = \{/);
  assert.match(genJs, /width:\s*1024,\s*\r?\n\s*height:\s*1536/);
  assert.match(genJs, /wlop_c1-st4000\.safetensors",\s*strength:\s*0\.4/);
  assert.match(genJs, /si_\(wooupp\)_000001000\.safetensors",\s*strength:\s*0\.6/);
  assert.match(genJs, /applyKrea2DefaultLoras\(\);/);
  assert.match(genJs, /fam\(\) === "custom" \|\| fam\(\) === "krea2" \? ""/);
});

test("loraDisplayTitle keeps slash-separated model titles like wlop Anima/krea2/moss", () => {
  const lorasJs = fs.readFileSync(path.join(root, "ui", "js", "loras.js"), "utf8");
  assert.match(lorasJs, /krea2:\s*"Krea 2"/);
  assert.match(genJs, /const isPathTitle = \(t, name\) => !t \|\| t === name \|\| \/\\\.\(safetensors\|pt\|bin\|ckpt\)\$\/i\.test\(t\);/);
});
