---
name: paintdeck-dev
metadata:
  version: "v1.0"
description: "繪匣 PaintDeck（ComfyUI 本機 AI 生圖工作站）開發、維護與上游同步專用技能。當需要：1. 透過內建 anima MCP 操控生圖站；2. 用戶提出修改或更新需求時制定 /plan 計劃；3. 分析上游專案 (sressky12-ux) 與個人 Fork 專案 (aazz1245) 的變動與衝突並供用戶挑選更新模組；4. 自動化測試驗證、版本號全域同步並 Push 至個人倉庫時觸發。"
---

# 繪匣 PaintDeck 開發與維護工作流 (PaintDeck Dev Skill)

本技能為維護個人 Fork 專案 `aazz1245/PaintDeck`、對齊上游官方專案 `sressky12-ux/PaintDeck`、透過 MCP 操控 PaintDeck 及保護個人自訂功能的權威操作規範。

---

## 0. 核心四鐵律 (Four Core Axioms)

1. **先 /plan 後動手**：每次用戶提出需求（功能新增、錯誤修復、版本同步），**一律先執行 /plan**，產出詳細實施規劃給用戶確認，嚴禁未經確認直接修改代碼或執行 Git 合併。
2. **透過 MCP 操控專案**：優先使用內建 `anima` MCP 伺服器工具（`anima_status`, `anima_api`, `anima_generate`, `anima_gallery` 等）操控與檢驗運行中的生圖站，不盲目殺進程或盲改磁碟狀態。
3. **上游更新先做衝突分析並由用戶挑選**：每次合併上游前，必須嚴格分析上游改動與個人 Fork 客製功能的衝突點，向用戶明確彙報更新清單，由用戶自主選擇採納哪些模組，嚴格保護客製化功能。
4. **測試通過、同步版本號並 Push 倉庫**：修改或合併後，必須通過全部自動化測試（`node --test tests/*.test.cjs`，0 失敗），更新全端版本號，同步至本機工作區，並走代理推送至個人 Fork 倉庫。

---

## 1. 專案基礎配置與環境

- **本機工作區 (Workspace)**：`E:\AI\ComfyUI-aki\繪匣 PaintDeck`
- **Git 工作樹 (Scratch)**：`<artifact_dir>\scratch\PaintDeck`
- **個人 Fork 遠端 (origin)**：`https://github.com/aazz1245/PaintDeck.git` (`main` 分支)
- **上游官方遠端 (upstream)**：`https://github.com/sressky12-ux/PaintDeck.git` (`main` 分支)
- **ComfyUI 核心地址**：`http://127.0.0.1:8188`
- **PaintDeck 本地伺服器**：`http://127.0.0.1:8190`
- **系統代理（強制使用）**：`http://127.0.0.1:7897`（所有 Git 命令需帶 `-c http.proxy=... -c https.proxy=...`）

---

## 2. 核心模組一：透過 MCP 操控 PaintDeck

PaintDeck 原生內嵌名為 `anima` 的 MCP 伺服器。當應用運行於 `8190` 埠時，直接調用 `call_mcp_tool`。

### 常用 MCP 工具對照表

| 工具名稱 | 用途與情境 | 關鍵參數範例 |
|---|---|---|
| `anima_status` | 檢查 PaintDeck 與 ComfyUI 連線、模型家族、LoRA 清單 | `{}` |
| `anima_api` | 發送任意內部 REST API 請求（GET/POST） | `{ method: "GET", path: "/api/system" }` |
| `anima_generate` | 發起文生圖、圖生圖或影片生成，回傳預覽圖與參數 | `{ params: { prompt: "...", model: "..." }, look: true }` |
| `anima_gallery` | 搜尋或檢索圖庫中已完成的圖片 | `{ q: "tag", limit: 10 }` |
| `anima_image` | 讀取單張圖片的高解析資訊與元數據（Prompt, Seed） | `{ id: 123 }` |
| `anima_jobs` | 查詢目前正在生成或排隊中的任務佇列 | `{}` |
| `anima_upload` | 上傳本機圖片至 input 資料夾供生圖或參考用 | `{ path: "C:/path/to/img.png" }` |
| `fablecut_*` | 剪輯台與時間線相關操作工具 | 參見 `fablecut_docs` |

### MCP 操控守則
- **狀態前置檢驗**：在驗證新功能或生圖前，先調用 `anima_status`，確認 `comfyui_online: true`。
- **危險操作安全保護**：刪除圖庫、清空回收區、雲端開關機等高風險 API，嚴禁未經用戶確認即帶 `confirm: true`。

---

## 3. 核心模組二：/plan 規劃工作流程

每當用戶提出任何代碼改動、功能增刪或版本升級時，**強制執行以下規劃流程**：

### 步驟 1：建立 `implementation_plan.md` Artifact
計劃文檔應包含：
1. **User Goal & Intent Analysis**：清楚界定本次目標。
2. **客製功能防回退檢核清單 (8 大保護項)**：
   - 🛡️ **Booru 畫廊**：瀑布流版面、Danbooru 來源切換、43 款檢驗印章、分級色彩標籤、點擊圖片填入提示詞（`booru.js`, `app.css`）。
   - 🛡️ **三段式提示詞**：前綴、主詞、後綴獨立輸入框，支援自動合併解析（`promptx.js`, `gen.js`）。
   - 🛡️ **生圖模式參數獨立記憶**：文生圖、圖生圖、外觀、放大等各模式表單參數各自獨立記憶，修臉開關獨立切換（`gen.js`）。
   - 🛡️ **資產庫自訂分類轉片段子選項**：`少女`、`蘿莉`、`肉感` 等改為提示詞片段的子分類晶片，不作為獨立資產保存（`assets.js`）。
   - 🛡️ **片段子選項直接新增**：在片段標籤下點「+ 新增」時打開 `library.saveDialog`（`assets.js`）。
   - 🛡️ **資產新增自動取名保護**：未填名字點選「+ 從電腦」自動使用檔名填充，防止「資產要有名字」錯誤（`assets.js`）。
   - 🛡️ **片段彈窗本機圖片上傳與拖放**：`#leThumbUp` 按鈕與縮圖預覽框本機圖片拖放支援（`library.js`, `index.html`）。
   - 🛡️ **圖庫右鍵功能與 LoRA 清理**：大圖燈箱右鍵「打開所在資料夾」（`gallery.js`）；刪除 LoRA 自動清理其觸發詞（`loras.js`）。
3. **影響範圍評估**：列出本次需要修改的檔案清單。
4. **分步實施計劃與驗證檢查點**。

### 步驟 2：向用戶呈現並等待反饋
輸出簡要概述並引導用戶點擊 Artifact 檢視，**停步等待用戶確認**（用戶輸入「確認」、「繼續」或通過 Proceed 按鈕確認）後才開始執行。

---

## 4. 核心模組三：上游同步與衝突分析流程 (Upstream Sync)

當用戶提出升級或同步官方上游最新版本時，切勿直接 `git merge`，必須執行三路對比分析：

### 步驟 1：抓取與比對
```powershell
# 1. 抓取上游最新內容
git -C "<repo>" -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 fetch upstream

# 2. 計算最近公共祖先 (Merge Base)
$base = git -C "<repo>" merge-base origin/main upstream/main

# 3. 列出上游所有變動檔案清單
git -C "<repo>" diff --name-status $base upstream/main
```

### 步驟 2：建立衝突分類矩陣
將所有變更檔案分類為三大類：
1. **無衝突檔案 (Safe to Auto-merge)**：上游新增或修改、但我方 Fork 從未變更過的檔案（如後端 Rust 新 API、額外模型節點、獨立說明文件）。
2. **潛在衝突/需保護檔案 (Protected Fork Files)**：我方 Fork 包含自訂功能的檔案（如 `ui/js/assets.js`, `ui/js/library.js`, `ui/js/gen.js`, `ui/js/assetdrawer.js`, `ui/index.html` 等）。
3. **新功能/新架構特性 (New Upstream Features)**：上游重大功能引進（如 ComfyUI 升級腳本、MOSS 編輯控制、整本上色、下載中心等）。

### 步驟 3：向用戶彙報並由用戶挑選
以結構化清單呈現給用戶，範例：
> 📊 **上游更新分析結果**：
> - **無衝突安全模組（建議更新）**：[檔案列表，如下載中心、後端模型掃描等]
> - **核心衝突/自訂保護模組（需確認）**：
>   - `ui/js/gen.js`：上游新增了 MOSS 去色帶，我方有三段式提示詞與獨立模式參數。
>   - `ui/js/assetdrawer.js`：上游微調了 H3 參考圖邏輯，我方有多標籤計數交集與卡片高亮。
> - **請用戶選擇**：
>   1. 是否全量合併（自動保留我方全部 8 項自訂功能並融合上游新功能）？
>   2. 還是僅同步特定的後端修復/新模組？

**必須等待用戶確認選擇後，再執行合併！**

---

## 5. 核心模組四：更新執行、測試與 Push 交付

在用戶確認更新範圍後，標準合併與發布流程如下：

### 步驟 1：執行合併與人工代碼整合
```powershell
git -C "<repo>" merge upstream/main --no-commit
```
- 若出現衝突，逐一進行代碼整合，嚴格確保：
  - 既有自訂功能的變數、DOM 事件、樣式 class 不被覆蓋。
  - 上游新匯入的模組與呼叫正確引入。
  - **重要警惕**：在 Node.js 中替換包含 `$$` 的字串時，`String.prototype.replace(a, b)` 會將 `$$` 轉義為 `$`！務必使用 replacer 函數 `() => replacement`。

### 步驟 2：執行全套自動化測試
在工作樹中運行所有測試：
```powershell
node --test tests/*.test.cjs
```
- **通過標準**：全部測試 pass（包含原版測試與我方擴展測試，如 `tests/assets_custom.test.cjs`, `tests/gen_mode_params.test.cjs`, `tests/library_thumb_upload.test.cjs` 等），**0 fail**。

### 步驟 3：全域同步版本號與更新 README.md 日誌
1. **版本號同步**：上游若提升了版本號（如 `26.1031.4`），必須在以下檔案中同步對齊：
   - `src-tauri/Cargo.toml` (`version = "..."`)
   - `src-tauri/tauri.conf.json` (`"version": "..."`)
   - `ui/index.html` (`<span id="verText">V...</span>`)
   - `ui/manual.html`
2. **README 更新日誌同步**：每次自訂修改或合併更新後，必須在 `README.md` 的「📝 更新日誌 (Changelog)」章節追加本次更新內容、日期與關鍵改動說明。

### 步驟 4：鏡像同步至本機工作區
將 Git 樹中的 `ui/`, `resources/`, `tests/`, `src-tauri/`, `tools/` 等檔案完整同步複製至工作區目錄 `E:\AI\ComfyUI-aki\繪匣 PaintDeck`。刪除上游已棄用的殘留檔案（如已刪除的 `civitai.js`）。

### 步驟 5：走代理提交並 Push 到個人倉庫
```powershell
# 1. 提交 Commit
git -C "<repo>" commit -m "merge: 同步上游 <version> 並完整保留全部自訂功能"

# 2. 走代理推送至 origin/main
git -C "<repo>" -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin main
```

---

## 6. 防坑速查清單 (Anti-Pitfall Reference)

1. **嚴禁後台靜默解壓官方 NSIS 安裝包 (`setup.exe /S`)**：
   - **痛點記錄**：官方 `setup.exe` 執行完成後會自動啟動安裝目錄下的原版 `anima-app.exe`。若在臨時目錄靜默解壓，原版進程會搶佔 `8190` 埠，導致瀏覽器載入無客製的純淨 UI，誤以為自訂功能全部丟失！
   - **正確做法**：僅從 Git 源代碼合併，或用 7-Zip 解壓縮工具只提取必要二進制檔，絕不執行 NSIS 安裝程序。
2. **Git 代理環境規範**：
   - 系統代理核心為 Clash/Mihomo，埠為 `127.0.0.1:7897`。
   - 所有外部 Git 命令（fetch, push, clone）及 curl 下載必須顯式掛載 `-c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897`。
3. **i18n 語言檔案保護**：
   - 切勿手動使用腳本重排或格式化 `ui/i18n/en.json`，避免 500KB+ 翻譯鍵值序列化出錯破壞介面。
