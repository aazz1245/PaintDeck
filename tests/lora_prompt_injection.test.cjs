const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const section = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
};

test("LoRA cards keep trigger metadata without inserting or deleting prompt text", () => {
  const gen = read("ui/js/gen.js");
  const picker = read("ui/js/loras.js");
  const html = read("ui/index.html");

  assert.doesNotMatch(section(gen, "export function addLora", "export function applyLoraRecipe"), /prependTriggers/);
  assert.doesNotMatch(section(gen, "export function applyLoraRecipe", "export function removeLora"), /prependTriggers/);
  assert.doesNotMatch(section(gen, "export function removeLora", "const clamp"), /removePrompt/);
  assert.doesNotMatch(section(gen, "export function fullPrompt", "export function appendPrompt"), /triggerWords|withLoraTriggers/);
  assert.doesNotMatch(gen, /lora-trig-preview|prependTriggers\(/);
  assert.doesNotMatch(picker, /lpTrig|pickCb\(l\s*,/);
  assert.doesNotMatch(html, /id="lpTrig"/);
});
