// 產生 resources\tags\t2s_chars.json：繁體字 → 簡體字的逐字對照表（Node.js，免安裝套件）。
//
//   node tools/make_t2s_chars.mjs
//
// 用途：tags.rs 的中文 tag 搜尋、poses.rs 的姿勢名稱比對，把「對照表裡的繁體詞」和「使用者輸入」都先折成簡體再比，
// 簡體、繁體輸入就都找得到（例：长发／長髮 → 长发）。對照表本身（zh_map.json、poses.json）維持繁體不動。
//
// 資料來源：ui\vendor\opencc-t2cn.js 內附的 OpenCC 字典（Apache-2.0；opencc-js 是 MIT，見 THIRD_PARTY_NOTICES.md）。
// 直接拿那支轉換程式把每個漢字單獨轉一次，不自己抄字典，所以字典更新後重跑就好，結果每次相同。
//   - 主表用 OpenCC 標準繁體→簡體（t2s）。
//   - 台灣、香港寫法的異體字（著→着、衞→卫、簷→檐…）t2s 沒收的，從 tw2s／hk2s 補進來。
//   - 只留 BMP 的字（輸入法打得出來的）；兩邊都是單一字元的才收。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcFile = path.join(root, "ui", "vendor", "opencc-t2cn.js");
const outFile = path.join(root, "resources", "tags", "t2s_chars.json");

// vendor 檔是瀏覽器用的 ES module，但副檔名是 .js：用 data: URL 載入，不用在 ui\ 底下加 package.json
const code = fs.readFileSync(srcFile, "utf8");
const { Converter } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const conv = (from) => Converter({ from, to: "cn" });
const [t2s, tw2s, hk2s] = [conv("t"), conv("tw"), conv("hk")];

// 這幾個不收：TW 變體表把 么 轉成 幺，簡體的「什么」會跟繁體「什麼」對不起來
const SKIP = new Set(["么"]);
const bmp1 = (s) => [...s].length === 1 && s.codePointAt(0) <= 0xffff;

const map = new Map();
// 漢字：擴充 A、基本區、相容漢字
for (const [a, b] of [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]]) {
  for (let cp = a; cp <= b; cp++) {
    const c = String.fromCodePoint(cp);
    for (const f of [t2s, tw2s, hk2s]) {
      const o = f(c);
      if (o !== c && bmp1(o) && !SKIP.has(c) && !map.has(c)) map.set(c, o);
    }
  }
}

// 自我檢查：這些是整個功能的底線
const must = { 長: "长", 髮: "发", 發: "发", 頭: "头", 傳: "传", 體: "体", 後: "后", 裡: "里", 裏: "里", 麼: "么", 著: "着" };
for (const [k, v] of Object.entries(must)) {
  if (map.get(k) !== v) throw new Error(`對照表缺 ${k} → ${v}（實際 ${map.get(k)}）`);
}
for (const k of "长发头传体后里么着") {
  if (map.has(k)) throw new Error(`簡體字 ${k} 不該被轉掉`);
}

const keys = [...map.keys()].sort((x, y) => x.codePointAt(0) - y.codePointAt(0));
const lines = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(map.get(k))}`);
const about =
  "繁體字→簡體字逐字對照，由 tools/make_t2s_chars.mjs 從 ui/vendor/opencc-t2cn.js（OpenCC 字典，Apache-2.0）產生，勿手改";
const text = `{\n"_about":${JSON.stringify(about)},\n"map":{\n${lines.join(",\n")}\n}\n}\n`;
JSON.parse(text); // 確認格式
fs.writeFileSync(outFile, text, "utf8");
console.log(`${path.relative(root, outFile)}：${keys.length} 個字`);
