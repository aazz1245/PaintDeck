# 繪匣 PaintDeck

> 舊名「Anima 生圖站」，2026-10-24 改名開源。

在自己的 Windows 電腦上畫圖的桌面程式：用 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 當引擎，把動漫（Anima）、寫實（Qwen-Image 2.1）、排版寫字（MOSS-Image）、影片（內建 LTX-2.3，也能換成自己的 ComfyUI 影片工作流）這幾套模型包成一個中文介面。圖都在本機畫、存在本機，不經過別人的伺服器。

> **English:** A Windows desktop front-end for local image/video generation on top of ComfyUI (Rust + Tauri 2, plain-JS web UI). The UI is Traditional Chinese with English and Simplified Chinese switches. Requires an NVIDIA GPU (AMD and Intel Arc GPUs: experimental, untested on real hardware; machines without a usable GPU can still install it and run ComfyUI on the CPU). Licensed under GPL-3.0.

## 功能

| 功能 | 說明 |
|---|---|
| 生圖 | 文生圖、圖生圖、局部重繪、擴圖、多圖參考、放大、四視圖、去背；LLLite／ControlNet 構圖控制、高解析修復、版面框（指定東西放哪裡） |
| AI 改寫 | 一句中文想法改寫成完整提示詞（本機 llama.cpp 跑 Qwen 系列模型），也能看圖寫描述 |
| 反推 | 從圖片反推 Danbooru tag（WD EVA02，CPU 執行），附自動清理和中文對照 |
| 生圖助手 | 用中文說要什麼，助手自己寫提示詞、畫圖、看圖檢查、再修改；可接雲端顯卡（RunPod 或自己的主機） |
| 讓圖動起來 | 圖生影片：內建 LTX-2.3（有聲音）；也能在設定匯入自己的 ComfyUI 影片工作流（Wan、HunyuanVideo…），生圖站自動填提示詞、首格圖、種子、長度 |
| 導演台 | 長劇情自動分段 → 每段第一格 → 圖生影片 → 接成一部短片；角色設定卡（多視圖設定圖）讓角色長相一致 |
| 影片台與拍攝單 | 接雲端顯卡跑 MiniMax H3 影片：素材板＋分鏡卡、首尾幀、長片接續；拍攝單把劇情拆成一格一格的鏡頭 |
| 資產庫與角色設定圖工坊 | 角色、場景、道具集中管理；從一張圖或一段文字做出全身轉身圖和臉部特寫表，存成可重複使用的角色 |
| 漫畫台 | 選版型、寫每格內容和台詞，MOSS-Image 一次畫出整頁分格漫畫 |
| 影音工作台 | 內建剪輯台（[FableCut](resources/extras/fablecut/LICENSE)）和拆幀工具（幀數沒有固定上限，只看硬碟空間） |
| 給 AI 操作 | 內建 MCP 伺服器：Claude、Codex 等 AI 可以直接叫它生圖、生影片、剪片 |
| 圖庫與提示詞庫 | 每張圖都記得怎麼畫的；好用的設定、片段存成提示詞庫 |
| LoRA 與 Civitai | 搜尋、下載 LoRA，觸發詞和建議強度自動帶入 |
| 安裝精靈 | 第一次開啟時自動下載 ComfyUI、模型、llama.cpp、ffmpeg；已經有 ComfyUI 也能直接沿用；能掃描整台電腦，別的 ComfyUI、A1111／Forge 裡已經有的模型原地使用、不重新下載 |
| 模型與工作流 | 設定頁管理外部模型資料夾（寫成 ComfyUI 的 extra model paths，不搬檔）；模型檔拖進來看權重自動歸類，或貼 Hugging Face／Civitai 網址下載；匯入自己的 ComfyUI 文生圖工作流，在生成頁當成一個模型選 |
| 設定 | 匯出／匯入、恢復原廠（搬到「待刪除」，可以救回） |

完整說明在程式內的使用手冊（`ui/manual.html`，程式裡按「說明」打開）。

## 🍴 個人 Fork 客製功能與更新日誌 (Fork Features & Updates)

本倉庫為個人維護的 Fork 版本（`aazz1245/PaintDeck`），在上游官方版本的基礎上，針對日常使用痛點進行了多項核心功能的增強與深度客製：

### 🌟 核心客製功能清單

- **Booru 畫廊瀑布流 (Virtual Masonry Gallery)**：
  - 支援原生圖片比例的虛擬瀑布流版面排版，依螢幕寬度自適應欄位。
  - 整合 Danbooru 來源切換、多行標籤解析與自動降噪（角色/作品/畫師/一般標籤排序）。
  - 內建 43 款檢驗合格印章與分級色彩標識（全年齡/微澀/R15/R18）。
  - 單擊卡片快速添加/去除提示詞，支援單選與多選切換。
- **三段式提示詞輸入框 (Three-Box Prompt Split)**：
  - 前綴（Prefix）、主詞（Body）、後綴（Suffix）獨立輸入框與展開折疊。
  - 自動合併解析，讓高頻質量詞與風格標籤結構化管理。
- **生圖模式參數獨立記憶 (Independent Mode Parameters)**：
  - 文生圖、圖生圖、外觀、放大等各模式表單參數獨立持久化記憶。
  - 切換模式自動加載專屬參數，修臉開關（Auto Detailer）及去噪強度獨立持久化。
- **資產庫自訂分類轉片段子選項 (Snippet Sub-Folders & Protection)**：
  - 少女、蘿莉、假小子、肉感等自訂分類改為提示詞片段的子分類晶片標籤，防止被誤保存為資產。
  - 在子選項下點「+ 新增」直接呼叫存成片段彈窗。
  - 新增資產時未填寫名字點選「+ 從電腦」，自動取圖檔名填充，徹底防止「資產要有名字」報錯。
- **存成片段支援從電腦上傳與拖放 (Snippet Modal Local Upload & Drag-and-Drop)**：
  - 存成片段彈窗新增「從電腦上傳」按鈕（`#leThumbUp`）。
  - 支援將本機圖片直接拖放至縮圖預覽框。
  - 自動提取檔名作為未命名片段的名稱。
- **資產抽屜多標籤交集篩選 (Multi-Tag Filter & Drawer Card Highlight)**：
  - 支援多標籤同時勾選並即時計算交集數量。
  - 卡片點選反白高亮（`adr-card on`）與滾動條位置記憶。
- **圖片燈箱右鍵「開啟所在資料夾」 (Lightbox Open Containing Folder)**：
  - 大圖燈箱右鍵選單支援一鍵開啟 Windows 檔案總管並定位該圖。
- **LoRA 觸發詞自動同步與清理 (LoRA Trigger Word Sync)**：
  - 選擇 LoRA 自動填入觸發詞，移除 LoRA 時自動清理關聯詞。
- **PaintDeck 專屬開發維護技能 (`paintdeck-dev`)**：
  - 內建全域與專案級開發維護技能，整合 anima MCP 操控、`/plan` 前置規劃、上游三路衝突分析與自動化測試發布標準。

---

### 📝 更新日誌 (Changelog)

#### [2026-11-08]
- **fix(comfy)**: ComfyUI 回傳 LoRA 清單為 null 時查詢目前合法選項，修正子資料夾 LoRA 的斜線格式後重新送出。

#### [2026-11-04]
- **fix(gen)**: 徹底實現「直接開啟保存資料夾」，優先走 PaintDeck 8190 原生 `/api/reveal` 系統級通道，預置預設輸出路徑快取消除初次調用 2000ms 超時延遲，並移除多餘 Toast 提示實現零延遲、純靜默開窗。
- **feat(skill)**: 新增 `paintdeck-dev` 開發維護技能（MCP 控制、`/plan` 規劃、上游衝突分析及同步交付規範）。
- **feat(desktop)**: 在 Windows 桌面建立「繪匣 PaintDeck」快捷方式。
- **docs(readme)**: 在 Fork `README.md` 中建立客製功能專區與持續更新日誌。

#### [2026-10-30]
- **feat(library)**: 存成片段/整套設定彈窗新增「從電腦上傳」按鈕（`#leThumbUp`），支援本機圖片拖放上傳為縮圖，未填名稱時自動以檔名命名。(`40265e5`)
- **feat(assets)**: 將少女、蘿莉、假小子、肉感等自訂分類轉為提示詞片段的子選項晶片，點擊「+ 新增」直接喚起存成片段對話框。(`b8cb47b`)
- **fix(assets)**: 上傳或加圖時若名字為空自動以檔名命名，避免「資產要有名字」報錯阻擋。(`0db7405`)
- **feat(assets)**: 分類下拉選單包含所有分類選項，支援雙向連動與安全清洗。(`a2425ca`)
- **fix(assets)**: 修復添加與儲存資產時自訂分類報錯不認得的類型問題。(`9da851c`)

#### [2026-10-29]
- **feat(gen)**: 實現各生圖模式（文生圖、圖生圖、外觀、放大等）參數獨立記憶與自動修臉獨立切換。(`eb42b14`)
- **feat(viewer)**: 增加圖片預覽右鍵選單與「開啟所在資料夾」功能。(`3769b8e`)
- **feat(booru)**: 實現 Virtual Masonry 瀑布流版面，支援原始比例高度排版。(`cf63b5a`)
- **feat(booru)**: 補齊 Booru 畫廊設定彈窗與 43 款檢驗印章掛載。(`caad01e`)
- **fix(booru)**: 預設來源為 Danbooru，修復暗色高對比主題色彩相容性。(`f3f9477`, `aaf5ec4`)
- **feat(booru)**: 新增點圖填詞、提示詞處理對話框與設定功能。(`c82101f`, `38c86ed`)
- **feat(promptx)**: 提示詞輸入框拆分為前綴、主詞、後綴三段式獨立輸入。

---

## 需要什麼

| 項目 | 需要 |
|---|---|
| 系統 | Windows 10／11（64 位元）。只支援 Windows：用到 DPAPI、Windows 程序管理，安裝精靈下載的是 Windows 版 ComfyUI 和 llama.cpp |
| 顯示卡 | NVIDIA，顯存 8GB 以上（開發時用 RTX 3070 8GB 實測） |
| A 卡（AMD） | **實驗性支援**：RX 5000 以後的獨顯、680M／780M／860M 以後的內顯，最新 AMD 驅動。精靈會改下載官方 AMD 版 ComfyUI 和 llama.cpp Vulkan 版，官方版沒附的架構再換成 AMD 的 ROCm 10 PyTorch；也認得 ZLUDA 版、DirectML 版 ComfyUI。還沒有 A 卡實測過 |
| Intel 顯示卡 | **實驗性支援**：Arc 獨顯、Core Ultra 的 Arc 內顯（改下載官方 Intel 版 ComfyUI）；UHD、Iris Xe 不支援。還沒實測過 |
| 沒有能用的顯示卡 | 照樣能裝，ComfyUI 用 CPU 跑（很慢）；生圖助手可以接雲端顯卡 |
| 記憶體 | 16GB 起跳，做影片建議 32GB |
| 硬碟 | 基本版約 20GB；完整版約 90GB |

## 安裝（一般使用者）

到 [Releases](https://github.com/sressky12-ux/PaintDeck/releases) 下載安裝檔 `PaintDeck_<版本>_x64-setup.exe` 雙擊安裝。安裝檔沒有付費簽章，Windows 可能跳出「Windows 已保護您的電腦」：按「其他資訊」→「仍要執行」。第一次打開會進安裝精靈，照畫面選資料放哪裡、要下載哪些模型就好。

完整版有幾個模型放在 Civitai，要先在「設定」填 Civitai API key 才下載得到（手冊第 01 章有申請步驟）。

## 從 Anima 生圖站升級

1. 先從系統匣右鍵「結束」，關掉舊版。
2. 到 Windows 設定解除安裝「Anima 生圖站」，**不要勾「刪除應用程式資料」**。
3. 安裝「繪匣 PaintDeck」。按「瀏覽」選資料夾後，安裝程式會再加一層 `繪匣 PaintDeck`。
4. 第一次開啟會沿用原本的設定、資料位置與圖庫；有用 MCP 的，請到「設定 → 給 AI 操作」重新複製設定。

改名後 Windows 會把新舊版當成兩套程式，兩套共用設定與連接埠，不能同時開。若裝在同一個資料夾，兩筆解除安裝紀錄可能指向同一個 `uninstall.exe`；安裝新版後再解除安裝舊版，可能把新版一起移除。勾刪除應用程式資料會清掉程式記住的資料位置，必須重跑精靈指回原資料夾；圖庫檔案仍在原資料資料夾。

現有 `26.10.24` 與更早版本都沒有 App 內更新功能；第一個支援更新的版本仍須手動安裝一次。之後公開版可在「設定 → 程式更新」檢查新版，確認後才下載安裝；私人版維持手動更新，請使用私人安裝檔。第一個支援本體更新的公開版是 26.1024.1。

## 從原始碼編譯

需要：

- [Rust](https://rustup.rs/)（stable）
- Tauri CLI：`cargo install tauri-cli --version "^2" --locked`
- WebView2（Windows 10／11 大多內建）
- Node.js 只有跑前端語法檢查時要；Python 只有跑 `tools\` 裡的維護腳本時要

```powershell
# 1. 下載不放進版控的兩個執行檔（onnxruntime.dll、7zr.exe），會比對 SHA-256
powershell -ExecutionPolicy Bypass -File tools\fetch_vendor.ps1

# 2. 測試（不需要模型或 ComfyUI）
cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings

# 3. 打包成安裝檔（輸出在 src-tauri\target\release\bundle\nsis\）
cargo tauri build
```

### 開發時只跑網頁伺服器

`anima-server` 不開視窗、只跑內建網頁伺服器，改前端時重新整理瀏覽器就看得到：

```powershell
cd src-tauri
$env:ANIMA_ROOT = "$env:TEMP\anima_dev\root"   # 資料根目錄（資料庫、設定、待刪除）
$env:ANIMA_WEB  = "..\ui"                      # 網頁檔
$env:ANIMA_RES  = "..\resources"               # 程式附帶的資料
$env:COMFY_ROOT = "D:\ComfyUI_windows_portable\ComfyUI"  # 選填，預設是資料根目錄旁邊的 ComfyUI_windows_portable\ComfyUI
$env:COMFY_URL  = "http://127.0.0.1:8188"      # 選填
$env:ANIMA_PORT = "8191"                       # 選填，預設 8191（正式版用 8190）
cargo run --bin anima-server
```

然後用瀏覽器開 `http://127.0.0.1:8191`。伺服器只聽 127.0.0.1，也只接受本機頁面的請求。

## 專案結構

| 位置 | 內容 |
|---|---|
| `src-tauri/src/main.rs` | 桌面版：視窗、系統匣、第一次啟動的安裝精靈 |
| `src-tauri/src/server/` | 內建網頁伺服器（axum）：所有 `/api/*` 路由，`mod.rs` 的 `router()` 是總表 |
| `src-tauri/src/graphs.rs` | 把網頁送來的參數組成 ComfyUI 節點圖（各模式、各模型家族） |
| `src-tauri/src/comfy.rs` | 跟 ComfyUI 溝通：送任務、收進度與預覽、斷線重連 |
| `src-tauri/src/pe.rs` | AI 改寫：管理 llama-server、組請求、解析與修補模型輸出 |
| `src-tauri/src/agent.rs`、`director.rs`、`comic.rs`、`studio.rs` | 生圖助手、導演台、漫畫台、影音工作台 |
| `src-tauri/src/setup.rs` | 安裝精靈：下載、解壓、檢查 |
| `src-tauri/src/model_dirs.rs`、`image_wf.rs` | 外部模型資料夾與整台電腦的模型掃描；匯入的 ComfyUI 生圖工作流 |
| `src-tauri/src/db.rs` | SQLite（圖庫、任務、提示詞庫、LoRA 說明） |
| `src-tauri/tests/` | 整合測試：`api_routes.rs` 真的開伺服器打 API；`golden_*.rs` 跟舊版 Python 實作的輸出逐項比對 |
| `ui/` | 網頁介面：原生 ES module，不用打包工具；`js/main.js` 是進入點，`i18n/en.json` 是英文字典 |
| `resources/` | 程式附帶的資料：姿勢彙整、Danbooru tag、提示詞範本、ComfyUI 節點與工作流程、模型下載清單 |
| `tools/` | 維護腳本：英文字典（`i18n_extract.py`）、下載附帶執行檔（`fetch_vendor.ps1`）、姿勢圖渲染（`pose3d/`） |

介面文字改了以後，跑 `python -I tools/i18n_extract.py extract` 找出還沒翻的句子，翻好存成 `tools/i18n/done_NN.json`，再跑 `build` 產生 `ui/i18n/en.json`。

## 內容與模型

- 這是一套本機工具，能畫什麼由你下載的模型決定，其中包括成人內容：完整版清單有成人向 LoRA，H3 影片台有「成人」分組的範本，只給 18 歲以上的成年人使用。請遵守你所在地的法律，以及每個模型、LoRA 各自的授權條款（下載頁面上寫的那份）。
- 生圖助手不會自己挑「調整年齡」類的 LoRA（`agent.rs` 的 `agent_may_pick`）。
- 模型不包含在這個專案裡，安裝精靈從 Hugging Face、Civitai 等原始出處下載；下載清單在 `resources/share/models_*.json`。

## 授權

GPL-3.0，見 [LICENSE](LICENSE)。專案裡附帶的第三方程式碼、字型和資料各有授權，列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
