"""產生 app/tag_rules.json：反推「自動清理」用的 Danbooru 標籤隱含關係（例：pink_rose → rose → flower）。

只查反推模型（data/models/tagger/selected_tags.csv）會輸出的一般標籤；向 Danbooru API 查 active 的 tag_implications。
有了它，清理時「留下的標籤已經隱含的上層標籤」就可以拿掉（pink rose 已經代表 rose、flower）。
用法：.venv\\Scripts\\python.exe tools\\build_tag_rules.py   （約 1～2 分鐘，要連網；換了反推模型再跑一次）
"""
import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOCAB = os.path.join(ROOT, "data", "models", "tagger", "selected_tags.csv")
OUT = os.path.join(ROOT, "app", "tag_rules.json")
API = "https://danbooru.donmai.us/tag_implications.json?"


def fetch(names):
    q = urllib.parse.urlencode({"search[antecedent_name_comma]": ",".join(names), "search[status]": "active", "limit": 1000})
    req = urllib.request.Request(API + q, headers={"User-Agent": "anima-ui-tag-rules/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:  # 偶爾 429／逾時：等一下重試
            print(f"  重試（{e}）", flush=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("Danbooru API 連不上")


def main():
    with open(VOCAB, encoding="utf-8") as f:
        names = [r["name"] for r in csv.DictReader(f) if r["category"] == "0"]
    vocab = set(names)
    implies = {}
    for i in range(0, len(names), 100):
        for x in fetch(names[i:i + 100]):
            a, c = x["antecedent_name"], x["consequent_name"]
            implies.setdefault(a, [])
            if c not in implies[a]:
                implies[a].append(c)
        print(f"{min(i + 100, len(names))}/{len(names)}", flush=True)
        time.sleep(1)
    data = {"source": "danbooru tag_implications (active)", "built": time.strftime("%Y-%m-%d"),
            "implies": {k: sorted(v) for k, v in sorted(implies.items())}}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=0)
    inside = sum(1 for k, v in implies.items() for c in v if c in vocab)
    print(f"寫入 {OUT}：{len(implies)} 個標籤有上層，其中 {inside} 條指向反推模型認得的標籤")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
