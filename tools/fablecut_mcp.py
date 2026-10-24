"""剪輯台（FableCut）的 MCP 伺服器接上生圖站的全站工具（resources\\extras\\fablecut\\anima-tools.js）。

FableCut 本體只多兩行（重複跑不會插第二次）：
  1. TOOLS 清單結尾後面：把 anima_* 工具加進清單
  2. callTool() 開頭：anima_ 開頭的工具交給 anima-tools.js
另外把 initialize 回的伺服器名稱改成 anima（MCP 設定裡的名字也是 anima）。

升級 FableCut 之後重跑：
    C:\\Users\\User\\AppData\\Local\\Python\\bin\\python -I -X utf8 tools\\fablecut_mcp.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
F = ROOT / "resources" / "extras" / "fablecut" / "mcp-server.js"
MARK = "/* Anima 生圖站：全站工具（tools\\fablecut_mcp.py 插的） */"

PATCHES = [
    # (原本的字串, 換成, 說明)
    (
        "];\n\n/* ── Loudness normalize (fablecut_normalize_audio) ──",
        "];\n" + MARK + "\nconst Anima = require(\"./anima-tools\"); TOOLS.push(...Anima.TOOLS);\n\n/* ── Loudness normalize (fablecut_normalize_audio) ──",
        "TOOLS 結尾",
    ),
    (
        "async function callTool(name, args, attempt = 0) {\n",
        "async function callTool(name, args, attempt = 0) {\n  if (name.startsWith(\"anima_\")) return Anima.call(name, args); " + MARK + "\n",
        "callTool 開頭",
    ),
    (
        'serverInfo: { name: "fablecut", version: "1.15.0" },',
        'serverInfo: { name: "anima", version: "1.15.0" }, ' + MARK,
        "伺服器名稱",
    ),
]


def main():
    s = F.read_text(encoding="utf-8")
    nl = "\r\n" if "\r\n" in s else "\n"
    s = s.replace("\r\n", "\n")
    done = 0
    for old, new, what in PATCHES:
        if new in s:
            continue
        if s.count(old) != 1:
            sys.exit(f"找不到「{what}」的位置（FableCut 改版了？）：要手動看 mcp-server.js 再改這支腳本")
        s = s.replace(old, new)
        done += 1
    F.write_text(s.replace("\n", nl), encoding="utf-8", newline="")
    print(f"mcp-server.js：新插 {done} 處，共 {len(PATCHES)} 處都在")


if __name__ == "__main__":
    main()
