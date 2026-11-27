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
  assert.match(genJs, /else if \(fam\(\) === "krea2"\) \{ F\("steps"\)\.value = isTurboModel\(\) \? 8 : 30; F\("cfg"\)\.value = isTurboModel\(\) \? 1 : 4; pick\("sampler", "euler"\); pick\("scheduler", "simple"\); \}/);
  assert.match(genJs, /fam\(\) === "custom" \|\| fam\(\) === "krea2" \? ""/);
});
