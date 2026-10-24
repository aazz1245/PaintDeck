# 繪匣 PaintDeck：給 AI 的全站操作說明

使用者在自己的 Windows 電腦上用「繪匣 PaintDeck」生圖、生影片、做漫畫、剪片。生圖站背後是 ComfyUI，網址 {{ANIMA_URL}}（只接受本機）。
你透過這個 MCP 伺服器（名字叫 anima）操作它：

- `anima_status`：先呼叫。ComfyUI 有沒有連上、有哪些模型（依家族分）、LoRA、工作流。
- `anima_docs`：讀這份說明，帶 section 只讀一段。
- `anima_generate`：生圖、生影片（生成頁那套），會幫你補預設參數、等畫完、可以順便回縮圖。
- `anima_jobs`、`anima_gallery`、`anima_image`、`anima_upload`：任務、圖庫、看圖、放輸入檔。
- `anima_api`：其他所有功能（漫畫台、導演台、H3 影片、生圖助手、提示詞庫、LoRA、AI 改寫、反推、拆幀、模型、雲端…）直接打 HTTP API。
- `fablecut_*`：剪輯台（FableCut）的工具，剪片、配樂、字幕、轉場、調色、匯出。用法讀 `fablecut_docs`。

跟使用者講話：白話、繁體中文，對象不是工程師。回報畫圖結果時附上「配方」：提示詞、負面詞、模型、LoRA 和強度、步數、CFG、取樣器、尺寸、種子。

## 規則（一定要照做）

- **會花錢、刪東西、改設定的**，`anima_api` 不帶 `confirm:true` 不會送出。先用白話跟使用者講清楚（花錢的要講每小時價格），使用者同意了才帶 `confirm:true` 重送。包含：雲端開機／關機（關機＝刪機，下次要重下約 32GB 模型）、清空回收區、把圖移到回收區或永久刪除、各種 `/delete`、清除任務、改設定、改 AI 改寫的系統提示詞、模型資料夾與下載、Civitai 下載、恢復原廠。
- 使用者的圖不要刪。真的要清，用移到回收區（`/api/images/batch` action `trash`），永久刪除留給使用者自己按。
- 不要碰金鑰：Civitai 金鑰、RunPod 金鑰都在生圖站裡加密存著，API 不會回傳，也不要叫使用者貼給你。
- 生圖站跟 ComfyUI 是同一台電腦、同一張顯示卡：一次送太多張會排很久。先送 1～2 張確認方向再加量。
- 不要改使用者的預設負面詞、預設組、模型預設值，除非使用者明講。
- 成人內容：生圖站是使用者私人用的，成人圖照使用者要求畫；寫實風格的成人圖要寫清楚是成年人（寫具體年紀或成熟身形）。
- 沒做到的、沒驗證的，照實說。

## 快速上手

1. `anima_status` → 看 `comfyui_online` 是不是 true、`models_by_family` 有哪些模型。
2. 畫一張：`anima_generate {params:{prompt:"masterpiece, best quality, score_7, safe, 1girl, ...", model:"anima-turbo-v1.1.safetensors"}, look:true}`
   model 不給會挑 Anima Turbo；steps、cfg、sampler、scheduler、尺寸、負面詞沒給會照家族補（回傳 `filled_defaults` 列出補了什麼）。
3. 回傳的 `jobs[].images` 是圖庫編號，用 `anima_image {id}` 看大一點的圖和完整參數。
4. 要改：同樣的 params 改提示詞，或 `seed` 固定只改一點點。
5. 要拿圖庫的圖當輸入（img2img、局部重繪、多圖參考）：`anima_api POST /api/to_input {id}` → 回傳 `name`，填進 `init_image`／`refs`。

## 模型家族與預設參數

生成用的模型分家族，`anima_status` 的 `models_by_family` 列出這台電腦有的。**LoRA 只能用在同家族**，家族不合的會被直接略過（回傳 `skipped_loras`）。

| 家族 | 是什麼 | 預設（沒給才補） | 提示詞寫法 |
|---|---|---|---|
| anima | Anima 動漫模型。Turbo 版最常用 | Turbo：8 步、CFG 1、euler、simple、832×1216；非 Turbo：30 步、CFG 4、er_sde | Danbooru tag＋英文句子（見「提示詞」） |
| qwen21 | Qwen-Image 2.1（介面叫「編輯」）：改圖、多圖參考、寫實、中文字 | Turbo：8 步 CFG 1；一般：25 步 CFG 3；1024×1536 | 英文長段落；改圖用中文指令 |
| moss | MOSS-Image（介面叫「文生圖繪圖」）：排版、寫字、版面框、漫畫台 | 25 步（掛 `moss_speed_dmd` 加速 LoRA 0.35 時 10 步）、CFG 3、euler、sgm_uniform、1024×1536 | 英文描述；文字用引號寫出來 |
| ltx23 | LTX-2.3 影片（10Eros） | `mode:"video"` 用 | 英文影片描述 |
| custom | 使用者匯入的 ComfyUI 生圖工作流（model 是 `wf:<代號>`） | 步數 CFG 照工作流 | 照工作流 |
| sdxl／flux／sd15 | 使用者自己放的其他模型 | 25 步 CFG 4 | 照該模型 |

- CFG 1 的 Turbo 模型**負面詞沒作用**：不要的東西用正面描述排除，或用負強度 LoRA。
- 寬高會被對齊成 16（Qwen 是 32）的倍數。
- `seed`：不給、空白、-1 都是隨機。一次畫 count 張，種子是 seed、seed+1、seed+2…

## 生成（POST /api/generate）

`anima_generate` 就是包這個 API。請求是 `{params, count}`，回 `{jobs:[{job, seed}]}`。任務在背景跑，`anima_jobs {jobs, wait:true}` 等結果。

共用欄位：`mode`、`model`、`prompt`、`negative`、`seed`、`steps`、`cfg`、`sampler`、`scheduler`、`width`、`height`、`loras:[{name, strength}]`、`turbo_lora`（非 Turbo 的 Anima 掛加速 LoRA 的檔名，或 false）、`idea`（記在圖庫的「想法」，方便之後找）。

| mode | 做什麼 | 要多給的欄位 |
|---|---|---|
| txt2img | 文生圖 | width、height（必填，`anima_generate` 會補）。可加 `hires`、`control`、`layout`（MOSS） |
| img2img | 圖生圖 | `init_image`（輸入檔名）、`denoise`（0～1，預設 0.6 上下）、`size_mode:"auto"\|"fixed"`、`pixels` |
| inpaint | 局部重繪 | `init_image`、`mask`（遮罩檔名，白色＝要重畫）、`denoise`（預設 1.0）、`inpaint:{method, area:"full"\|"masked", grow, blur, padding}`。**只重畫遮罩附近要寫 `area:"masked"`**，預設是整張 |
| outpaint | 擴圖 | `init_image`、`outpaint:{top, bottom, left, right, feather}`（像素） |
| multiref | 多圖參考（只限 qwen21） | `refs:[{image, role?}]`（第 1 張決定構圖和尺寸）、`size_mode:"auto"`、`pixels`（輸出像素數，例如原圖寬×高）、`ref_pixels`。提示詞用 `<image1>`、`<image2>` 指名 |
| upscale | 放大 | `init_image`、`upscale:{upscaler, scale, refine, denoise}` |
| sheet | 角色設定圖（多視圖） | `sheet:{req, ref}` |
| diff | 差分（同一張改表情、小地方） | `init_image`、`diff:{…}`，看生成頁的「生圖玩法」 |
| detail | 修臉修手（另一個 API：POST /api/detail） | `{params:原圖參數, init_image, what:"face"\|"hand"\|"both", threshold?, denoise?, extra?}` |
| rembg | 去背 | `init_image` |
| video | 生影片（LTX-2.3 或匯入的影片工作流） | `prompt`、`init_image`（可選，有就是圖生影片）、`video_seconds`（1～10）、`video_res:"480p"\|"720p"`（其他值一律當 720p）、`video_preview`。影片模型選 H3 時要改用「H3 影片台」 |

附加功能：
- `hires:{enabled:true, scale:1.5, denoise:0.4, upscaler}`：高解析修復（txt2img、img2img）。
- `control:{enabled:true, type:"any"|"lineart"|"scribble"|"depth", preprocess:"canny"|"depth"|"none", strength, end, image, invert}`：構圖控制，**只對 anima 的 txt2img／img2img 有效**，其他家族會被忽略。
- `pose_control`：Qwen 姿勢參考，只對 qwen21 有效。
- `layout:[{type:"character"|"object"|"text", desc, text?, box:[x0,y0,x1,y1]}]`：MOSS 的版面框，座標是 0～1 的比例。
- `count` 最多 32；送出途中某張失敗時，前面幾張已經在排隊，回應卻是錯誤，記得 `anima_jobs` 看一下。

取消與佇列：`POST /api/interrupt`（停目前這張）、`POST /api/cancel {job}`（取消一個任務，正在跑的會中斷）、`POST /api/clear_queue`（清空等待中的，要確認）、`POST /api/jobs/retry {job, new_seed?}`、`POST /api/free`（ComfyUI 釋放顯存）。

## 輸入檔（init_image、mask、refs、素材）

ComfyUI 只讀它自己 input 資料夾裡的檔：
- 圖庫的圖：`POST /api/to_input {id}` → `{name, width, height}`（影片不行）。
- 電腦上的檔：`anima_upload {path, kind:"image"|"mask"}` → `{name, …}`；上傳 PNG 時還會讀出圖裡存的生成參數（`params`）。
- 看輸入檔：`GET /input/<name>`。
- H3 影片台的素材另外走 `/api/h3/media`（見 H3 那段）。

## 圖庫

- 搜尋：`anima_gallery`（= `GET /api/gallery?q=&mode=&model=&family=&lora=&fav=1&from=&to=&sort=&limit=&offset=`）。`q` 搜提示詞和想法。
- 一張的完整資料：`anima_image {id}`（= `GET /api/image/<id>`）；原圖 `GET /img/<id>`、縮圖 `GET /thumb/<id>`。
- 我的最愛：`POST /api/image/<id> {fav:true}`。
- 批次：`POST /api/images/batch {action:"fav"|"unfav"|"restore"|"trash"|"purge", ids:[…]}`。trash＝移到回收區，purge＝永久刪除（都要確認）。
- 篩選選單的值：`GET /api/gallery/facets`。
- 匯出 zip：`POST /api/export {ids:[…]}`。
- 圖檔裡（PNG metadata）存著完整參數，讀回來重畫最準。

## 提示詞

**Anima**（動漫）：
- 順序：品質 → 評級 → 人數 → 角色 → 作品 → 畫師 → 其他 tag → 英文句子。例：`masterpiece, best quality, score_7, explicit, 1girl, 1boy, ...`。
- **一定寫評級**：`safe`／`sensitive`／`nsfw`／`explicit`。aesthetic 版模型不要寫 score_ tag。
- tag 小寫、空格分隔，括號要跳脫：`lusamine \(pokemon\)`。畫師前面加 `@`。
- 多人、誰對誰做什麼、左右位置，用英文句子寫，至少兩句；每個角色的特徵寫完整（tag 會套到所有人身上）。
- Danbooru 上不存在的 tag 沒效果；不確定就改寫成英文句子。
- 文字只畫得出單字或短句。

**Qwen 2.1**：
- 文生圖：一段英文，像在描述一張已經完成的畫：`The image is a vertical realistic photograph of …`（動漫寫 `An anime illustration of …`）。媒材＋主體＋背景 → 位置姿勢 → 臉 → 頭髮 → 每件衣服的顏色材質 → 光線 → 整體氣氛。不要寫 masterpiece、8K 這種品質詞。
- 改圖／多圖參考：可以用中文指令。兩張以上用 `<image1>`、`<image2>` 指名誰是底圖、各取什麼；要保留的用一句「其他部分保持不變」；人物寫「保留臉、髮型和身材」。

**MOSS**：英文描述；要畫的字用引號寫出來；版面用 `layout` 框。

**AI 改寫（不想自己寫時）**：`POST /api/pe/rewrite {text, …}` 是 SSE 串流（事件 status、reasoning、content、zh_delta、result、error），用 `anima_api` 呼叫會拿到整段串流文字，取最後的 result。改寫用本機 llama-server（9B／35B），第一次要載入幾十秒。`GET /api/pe/status` 看狀態、`POST /api/pe/stop` 關掉讓出顯存。
`GET /api/poses`：成人體位彙整（110 筆，含驗證過的 tag 和英文幾何描述），寫雙人體位先查這裡。

**反推**：`POST /api/tagger {id}`（圖庫編號）或 `{name}`（輸入檔名）→ Danbooru tag 和分數。

## LoRA、模型、Civitai

- LoRA 清單和觸發詞：`anima_status {loras:true}`；備註：`POST /api/loras/meta`。
- 不要的 LoRA：`POST /api/loras/delete {name}`（移到 `<資料>\待刪除\LoRA\`，不是真的刪；要確認；有任務在排隊時不給搬）。
- Civitai 搜尋：`GET /api/civitai/search?query=…&base=Anima&sort=Most Downloaded&period=AllTime&nsfw=1&tag=&cursor=`；下載：`POST /api/civitai/download {modelId, versionId, base}`（要確認），進度 `GET /api/downloads`。
- 模型總覽：`GET /api/models/inventory`；外部模型資料夾 `GET /api/models/dirs`。
- 匯入的生圖工作流：`GET /api/image/workflows`；影片工作流：`GET /api/video/workflows`。
- 影片工作流的對應與參數：`GET /api/video/workflows/{id}`（自動判斷結果、文字欄位、Load Image、全部欄位）；改：`POST /api/video/workflows/{id} {map:{prompt?:[[節點,欄位]], image?:"節點"|"", values:{"節點.欄位":值}, pins:[{key:"節點.欄位", label}]} | null}`（要確認）。生成時 `params.wf_overrides {"節點.欄位":值}` 調釘選的欄位；`params.video_engine:"h3", h3_model` 讓「動起來」改用本機 H3（有 GGUF 量化版就優先）。

## 提示詞庫（整套設定＋片段）

- `GET /api/lib`：全部（整套設定 kind=set、片段 kind=snippet，有資料夾、標籤、適用模型、置頂）。
- 存一筆：`POST /api/lib {id?, kind:"set"|"snippet", name, folder?, tags?:[…], family?, fav?, note?, data, image_id?}`（有 id＝改那筆，只送要改的欄位也可以；`data` 是整套生成參數或片段文字；`image_id` 拿圖庫那張當縮圖，`thumb:null` 拿掉縮圖）。
- 刪：`DELETE /api/lib/<id>`（要確認）。用過一次記一下：`POST /api/lib/used {id}`。

## 資產庫（角色、場景、道具…全站共用）

資產跟提示詞庫是同一張表（`/api/lib`），`kind` 多了 `char`（角色）、`scene`（場景）、`frame`（首幀／姿勢）、`outfit`（服裝）、`prop`（道具）、`fx`（特效）、`sound`（聲音）、`shot`（拍攝單範本）。左側欄「03 資產庫」管理；生成、導演分鏡、H3 影片台、漫畫、助手的文字框上面有「資產」抽屜。
- 新增／修改：`POST /api/lib {kind:"char", name, data:{look_zh?, look_en?, tags_anima?:[…], voice?, lang?, layout?:{top,bottom,left,right,fg,mid,bg,light}, text?}}`。不認得的鍵會丟掉；`tags_anima` 自動轉小寫、底線換空白，回應的 `unverified` 列出 tag 表裡找不到的（照樣存）。角色會自動配一個 `cid`（導演台用的角色 id）。
- 加檔：`POST /api/assets/<id>/file {input:"input 裡的檔名" | gallery_id, role}`；role 是圖片用途 `src`（原圖）、`sheet`（多視圖・穿衣）、`face`（臉部特寫表）、`sheet_nude`、`detail`、`pose`、`outfit`、`other`，`"audio"`＝音檔（mp3、wav、flac、ogg、m4a）。檔案存在 `data\assets\<id>_<n>.<副檔名>`，第一張圖自動當縮圖。加 `replace:true` 時換掉這個用途的第一張（舊的搬待刪除），不是再加一張。
- 拿掉檔：`POST /api/assets/<id>/file/remove {file}`；讀檔：`GET /api/assets/file/<file>`；放進 ComfyUI input：`POST /api/assets/<id>/to_input {file}` → `{name, width, height}`。
- 拿去用：`POST /api/assets/<id>/apply {family}` → `{text, images, warn, voice, lang}`，照模型轉換：

| family | text | images |
|---|---|---|
| `anima` | tag＋一句外觀英文 | 全部（給前端選當底圖或構圖控制，各 1 張） |
| `moss` | 外觀（英文，沒有就中文） | 不帶 |
| `qwen21` | 外觀 | 照用途排序，最多 10 張；超過 4 張會有 `warn` |
| `h3` | 中文外觀；也帶 `voice`、`lang` | 照用途排序，最多 9 張 |
| `ltx` | 外觀英文；也帶 `voice`、`lang` | 第一張原圖 |
| `comic` | tag＋外觀英文 | 不帶 |

  場景有填物件位置時，`text` 後面多一句「位置：上方 X；左邊 Y」（anima、ltx、comic 用英文 `Position: top: X`）。
- 圖片／音檔清單由伺服器維護，普通存檔只接受改圖片用途；從整套設定或片段轉成資產時不繼承其中的檔名。修改角色會保留既有 `cid`（舊匯入資料沒有 cid 時保留 `lib<id>` 身分）。
- 抽屜套用 Qwen 時依序處理資產，先複製圖片，再依實際加入的編號寫標記；已滿 10 張只插文字，總張數超過 4 張會提醒。H3／LTX 的聲音、語言會連同角色名字插進文字框；H3 的圖片接入仍留待影片台合併。
- 資產頁儲存／加檔期間暫時停用編輯區與換筆操作；選檔後先存表單再加檔。拿掉或換檔若搬移失敗會保留原紀錄，若資料庫寫入失敗會嘗試搬回舊檔；失敗原因會回報。
- 刪：`DELETE /api/lib/<id>`；資產會把整筆 JSON（`資產.json`）和檔案搬到 `<資料根目錄>\待刪除\資產庫\<名字>_<時間>\`，不會真的刪。
- 導演台的舊角色卡（`data\director\characters.json`）第一次開站時自動搬進資產庫（舊檔不動，搬完寫 `characters.migrated`）；`/api/director/chars*` 照舊能用，現在讀寫的是 `kind=char` 的資產。

### 角色設定圖工坊（做多視角設定圖、存成角色）

網頁：生成頁四視圖模式「＋ 做新角色設定圖」、資產庫角色「做設定圖」、導演台角色設定卡、圖片動作「做設定圖」都開同一個視窗（`ui\js\charsheet.js`）。流程照下面自己做也可以：
1. 定稿（一張全身正面站好的角色圖）：有圖就 `POST /api/to_input {id}`；只有文字就 `POST /api/charsheet/prompt {kind:"pose", family}` 拿補字，接在描述後面用 txt2img 畫（832×1216）。
2. 展開：`POST /api/charsheet/prompt {kind:"turnaround"|"face", desc?, family}` → `{prompt, width, height}`（轉身圖 1664×928、臉部特寫表 1344×1344）；用 `mode:"multiref"`、`refs:[{image: 定稿的 input 檔名}]`、`size_mode:"fixed"` 送 Qwen 2.1（官方 Turbo 8 步、CFG 1、euler／simple）。`<image1>` 就是定稿。
3. 裸體版（選填）：轉身圖用 `mode:"sheet"`、`sheet:{req: 四視圖編輯的全裸句}`。
4. 外觀：`POST /api/director/describe {image}`；tag：`POST /api/charsheet/tags {name}` → `{tags}`（反推後拿掉姿勢、表情、背景、人數）。
5. 存：`POST /api/lib {kind:"char", name, data:{look_en, look_zh, tags_anima}}`，再逐張 `POST /api/assets/<id>/file {gallery_id|input, role, replace:true}`：定稿 `src`、轉身圖 `sheet`、臉部 `face`、裸體 `sheet_nude`。

## 漫畫台

一整頁分格漫畫：選版型、每格寫景別／內容／台詞／狀聲詞 → **MOSS-Image 一次畫完整頁**（格子、台詞、狀聲詞都在同一張圖裡）。
- `GET /api/comic/meta`：版型（L3、L4、L4w、L5、L6、K4…，每格的位置名稱）、景別、對話框位置的選項。
- `GET /api/comic/projects`、`GET /api/comic/project/<id>`、`POST /api/comic/project/new {title, copy_from?}`。
- 改內容：`POST /api/comic/project {id, title?, layout?, trigger?, cast?（角色外貌）, light?, mood?, panels:[{shot, what, line, bubble, sfx}], count?}`。`what` 寫英文畫面內容（這格沒寫 what 就不畫）。
- 預覽組好的提示詞：`POST /api/comic/prompts {project}`。
- 畫：`POST /api/comic/run {id, count?}`；停：`POST /api/comic/stop {id}`；結果在專案的 `runs`（圖庫編號）。

## 導演台（長劇情 → 分段影片 → 接成長片）

- 角色卡：`GET /api/director/chars`、`POST /api/director/chars {id?, name, desc, desc_zh, src?|src_id?, sheet?|sheet_id?}`；看圖寫外觀 `POST /api/director/describe {image}`。
- 專案：`GET /api/director/projects`、`POST /api/director/project/new`、`GET /api/director/project/<id>`、`POST /api/director/project {…改過的欄位}`（執行中不能存）。
- 寫分鏡：`POST /api/director/write {id, what:"plan"|"shots"|"shot", index?}`（用本機 35B 語言模型）。
- 執行：`POST /api/director/run {id, from?, only?, concat?, skip_done?}` → 每段畫第一格 → 圖生影片 → 接成長片進圖庫。停：`POST /api/director/stop`。只接片：`POST /api/director/concat`。
- 進度從 websocket 送（type `director`）；用 `GET /api/director/project/<id>` 輪詢段落狀態也可以。

## 生圖助手（用中文說需求，它自己寫提示詞、畫、看圖、修改）

- `POST /api/agent/say {id?, text, images?:[{name, width, height}], settings?}`：沒有 id 就開新對話；正在跑時是插話。
- `GET /api/agent/sessions`、`GET /api/agent/session/<id>`（對話和每輪的圖）、`POST /api/agent/stop {id}`。
- 設定：`POST /api/agent/session/settings {id, …}`（腦袋 9b／35b／雲端、輪數、每輪張數、自動重畫、讓它挑 LoRA）。
- 你自己就能做助手的事，通常直接用 `anima_generate` 比較好控制；使用者想看助手跑時才用它。

## 影片台（拍攝單＋H3 短片／長片）
導演頁的「影片」分頁（2026-10-24 起，原本的「H3 影片」「長片」兩個分頁合成一個）：上面是**拍攝單**，下面是短片（1 段）或長片（2 段以上）。拍攝單填角色、首幀、參考圖、場景、鏡位、聲音、每段的時間軸，程式照固定結構組成 H3 提示詞，再套用到下面。

- 拍攝單格式：`{v:1, title, lang:"zh"|"en", cast:[{asset_id, speaker:"S1".., name, look_zh, look_en, voice, lang}]（最多 4）, first:{file, asset_id, gallery_id}, refs:{on, items:[{file, asset_id, who}]}（最多 8，預設不送）, scene:{text, layout:{top,bottom,left,right,fg,mid,bg,light}}, style, camera, sound:{ambient, music}, early（自動提早 1 秒，預設 true）, segments:[{secs(5～15), beats:[{from, to, action, who, lang, line, sfx}], prompt, mirror, manual}]（最多 30）}`。檔名都是 input 裡的檔名（先 `/api/to_input` 或 `/api/assets/{id}/to_input` 放進去）。
- 時間規則：第 2 段起開頭 1.6 秒是上一段的尾巴（寫「延續上一段的同一個動作」）；後面還有段的話，最後 0.7 秒是交棒區（寫「動作繼續」）。這兩塊不放新動作。`early` 開著時每一截往前挪 1 秒（H3 的動作常晚出來），夾在能放的範圍內。
- `GET /api/shotsheet/meta` → `{cheat:{view, move}（鏡位小抄：[按鈕字, 中文, 英文]）, rules:{danger, danger_user}, limits}`。
- `POST /api/shotsheet/compose {sheet}` → `{sheet（整理過）, segments:[{prompt（拍攝單的語言）, mirror（另一種語言）}], estimate:[{gpu, secs, usd}]}`。不花錢。
- `POST /api/shotsheet/check {sheet, prompts}` → `{issues:[{seg, rule, level, word, msg}]}`：1 氣氛詞、2 防止句（台詞 `<d>` 裡不算）、3 危險字、4 動作放進尾巴或交棒區、5 動作沒寫部位或位置、6 方向動作後面沒落點、7 勾了參考圖但提示詞缺 `<Picture n>`、8 時間軸重疊／空太久／超過段長（error）。全部只是提醒。
- `POST /api/shotsheet/danger {words}`：使用者自己加的危險字（存 `data\h3_sheet_danger.json`，最多 200 個）。
- `POST /api/shotsheet/polish {sheet, seg, prompt, brain:"9b"|"35b"|"cloud"}` → `{prompt, mirror}`：AI 潤飾一段（系統提示可在設定頁改，編號 `agent_h3_sheet`）。
- `POST /api/shotsheet/template {name, sheet}`：存成資產庫的拍攝單範本（`kind:"shot"`，拿掉這次的檔案和提示詞，只留資產連結和時間軸）。
- 字表和預估價在 `resources\h3\sheet_rules.json`、`resources\h3\estimate.json`。

### 短片：H3 影片台（MiniMax H3，雲端或本機）

**素材板（`h3_mode:"board"`，網頁用的就是這個；任何素材組合都能疊在同一支）**：`items:[{kind:"image"|"video"|"audio", name, use, secs?, audio?, lora?}]` 照素材板順序。use：圖 `ref`（參考：角色、服裝、場景…）／`anchor`（釘在 `secs` 秒，-1＝最後一幀）；影片 `ref`（參考，`audio:true` 連原聲）／`continue`（從它結尾接著拍）／`guide`（整段改造，`lora`：swap／vfx／style／""）／`control`（骨架控制，再給 `control_type`、`control_strength`）；聲音 `ref`（音色、配樂）／`anchor`（原封不動放在 `secs` 秒，畫面對嘴）。另有 `lora_mode:"live"`（動態桌布）。編號規則：有任何參考素材或首尾以外的釘圖 → 所有圖照順序是 `<Picture n>`；否則首幀 `<Picture 1>`、尾幀 `<Picture 2>`。`<Audio n>` 先算參考影片的原聲再算參考聲音；接續、改造、骨架影片和釘住的聲音不編號。上限：參考圖 9、參考影片 3、參考聲音 3、合計 12、釘圖 6、接續／改造／骨架合起來 1 段。設計見原始碼 `design\H3素材板_設計.md`。

舊的 11 種玩法（`h3_mode`）照舊能用：t2v 文生影片、i2v 圖生影片（首幀）、fl2v 首尾幀、ref2v 多素材參考（圖 ≤9、影片 ≤3、聲音 ≤3）、keys 多關鍵幀（2～6 張各帶秒數）、continue 接續上一支、control 動作控制（骨架／深度／線稿）、swap 換角色、vfx 特效改片、style 換畫風、live 動態桌布。
- `GET /api/h3/info`：39 個舊範本（每個有說明、要填的欄位和英文預設值，可以參考寫法）、模式、雲端狀態、可用模型與 LoRA、`local.selflift`／`cloud_selflift`。
- 素材：`POST /api/h3/media {gallery_id}` 或 `{file_name, data_b64}` → `{name, kind, w, h, secs, audio}`。
- 寫提示詞（可選）：`POST /api/h3/write {idea, mode, seconds, media:[{label, role, name?}], brain:"9b"|"35b"|"cloud"}` → `{prompt}`。素材板：`mode:"board"`（再給 `path`、`plan`）→ `{plan:{summary, style, notes, shots:[{start, camera, picture, lines:[{speaker, to, lang, text, offscreen}], sound}], soundscape, music}}`（腦袋沒照格式回時是 `{prompt}`）；分鏡要自己組成官方格式（網頁 `ui\js\h3.js` 的 `assemble()`），或你自己直接寫完整提示詞。
- 生成：`POST /api/h3/generate {params, count, where:"cloud"|"local"}` → `{task}`。params：`h3_mode, template, prompt, seconds, aspect, quality, items?, lora_mode?, first?, last?, prev?, continue_audio?, source?, src_wh?, keep_audio?, refs:{images, videos, video_audio, audios}, keys:[{image, secs}], control_type?, control_strength?, model?, steps(8), sampler("res_multistep"), scheduler("simple"), two_pass?, selflift?（SelfLift 兩段取樣：前半 0.6 倍解析度、後半原解析度，取樣器強制 euler、至少 4 步，不能跟 two_pass 一起；要裝 SelfLiftH3Sampler 節點，`/api/h3/info` 的 `local.selflift`／`cloud_selflift` 看有沒有）, speedup?（INT8 注意力＋sol-attn 稀疏注意力）, ff_chunks?, seed, loras`。進度 websocket type `h3`；完成後影片進圖庫。停：`POST /api/h3/stop {task}`。
- **角色的聲音**：素材板的角色圖可以寫聲音描述（例：「少女聲，偏低，性感知性」），網頁組提示詞時照官方格式寫在那個人每句台詞的 `<d>` 前面（`says in …: <d>…</d>`），不放角色定義（放那裡會被 H3 當台詞念出來）。要每支片同一把聲音：把一段聲音放進素材板當「取音色」（聲音 `use:"ref"`、`role:"voice"`、給 S1…）。
- **聲音庫**（角色的專屬聲音存起來）：`GET /api/voices` → `{voices:[{id, name, desc, file, source, created}], tts:{ready, why?, voice_field?}}`；`POST /api/voices {name, desc, file_name, data_b64}` 存一段；`GET /api/voices/{id}/file` 拿檔案（再送 `/api/h3/media {file_name, data_b64}` 放進素材板）；`DELETE /api/voices/{id}` 搬到 `待刪除\聲音庫`；`POST /api/voices/tts {name, desc, text}` 用 TTS 工作流照描述做一段、存進聲音庫（要先 `POST /api/voices/tts_workflow {file_name, data_b64}` 匯入 ComfyUI 的 TTS 工作流：文字欄位寫 `{{text}}`、聲音描述欄位寫 `{{voice}}`、要有 SaveAudio 這類節點；還沒用真的 TTS 節點實測過）。
- **雲端**：`where:"cloud"` 要先開雲端機器（`GET /api/agent/cloud` 看狀態和價格，`POST /api/agent/cloud/start` 開機要確認，A6000／A40 大約每小時 US$0.59）。用完一定要提醒使用者關機（關機＝刪機，也要確認）。

### 長片：一段一段接著拍（只能用雲端）
- 一條長片＝好幾段（每段 5～15 秒，預設 10）。第 1 段用首幀（可不放）開拍，第 2 段起直接吃上一段的 AV latent 接著拍（社群 Herrgotts H3 Infinite 節點，生圖站自己帶、第一次開拍時裝到雲端）。每段拍完自動切掉重疊的開頭、定住的尾巴，用拆幀台檢查硬剪接和跳點（只標出來）；全部拍好在本機用 ffmpeg 接成一支進圖庫。
- `GET /api/h3/chains`；`GET /api/h3/chain/{id}`（多 `est`＝還沒拍的段約要算幾秒、`running`）。
- `POST /api/h3/chain/save {chain}`：沒 id 就新建。chain：`title, aspect, quality, look（角色外觀，英文）, scene, style, voice（寫在每句台詞前）, sound, ref（角色參考圖）, first（第 1 段首幀）, refs:[檔名…]（拍攝單的參考圖，最多 8，每段都接 qwen_reference_1..N；有它就不用 ref）, sheet:{…}（拍攝單原樣保留，≤200 KB；網頁打開這條長片時會帶回上面）, segments:[{secs, text, lines:[{at, lang, text, who?}], last?（尾幀，預設不放）}]`；圖先用 `/api/h3/media` 放進 input，填回傳的 `name`。每段拍好的結果（status、files、check…）以存檔為準，送的不算；有段拍好後不能改比例、畫質；拍攝中不能存。
- `POST /api/h3/chain/run {id, from?}`（**花錢，先問使用者**）：從第一個還沒拍好的段開始；`from`＝從第幾段（0 起算）重拍，後面的段一起作廢。雲端沒開回錯誤（不會自動開機）。進度 websocket `{"type":"h3chain", id, seg, state:"running|seg_done|done|error|stopped", msg}`。
- `POST /api/h3/chain/stop {id}`、`POST /api/h3/chain/join {id}`（再接一次，不花錢）、`POST /api/h3/chain/delete {id}`（搬到 `待刪除\H3長片\`）。
- 段的影片：`GET /api/h3/chain/{id}/file/seg01_end.mp4`（`_cut`＝接片用、切掉尾巴；`_end`＝保留結尾）、`final.mp4`。每段的 `check:{sid, cuts, jumps}`：sid 是拆幀台的那一份，可以接著用拆幀台的 sheet／diff 逐格看。
- 寫法：換場景、換姿勢寫成動作（轉身、起身、低頭擋住鏡頭），不要每段都釘不同狀態的尾幀（模型會在半路瞬移）。

## 影音工作台：剪輯台（FableCut）

- 用 `fablecut_*` 工具剪（先 `fablecut_status`、讀 `fablecut_docs` 需要的段落，再用 `fablecut_patch_project` 改，`fablecut_frame` 看畫面，`fablecut_export` 匯出）。剪輯台網頁在使用者的「導演 → 剪輯台」分頁，看得到你即時改。
- 圖庫的圖或影片送進剪輯台素材：`POST /api/studio/import {id}`（素材名稱 `anima_<圖庫編號>.mp4／.png`）。
- 匯出的影片收進圖庫：`GET /api/studio/exports` 看清單 → `POST /api/studio/exports/save {name:"檔名.mp4"}`。
- 使用者鎖住（locked）的片段不要改。

## 影音工作台：拆幀台（逐幀看影片、修壞掉的幀）

幀號從 1 開始，這份裡第 n 幀＝(n-1)/fps 秒；只拆一段時，原片秒數＝`range.start`＋(n-1)/fps（對照表、分析都直接標原片秒數）。
1. 找影片：圖庫的用 `anima_gallery {mode:"video"}`；**電腦裡任何影片都可以**（不用是生圖站做的，原檔不動）。
2. 拆開：`POST /api/studio/frames/split {id}`（圖庫）或 `{path:"E:/Download/x.mp4"}`（外部檔），可加：
   - `start`、`end`（秒）：只拆一段。沒有固定幀數上限（2026-10-24 拿掉原本的 3600），只看硬碟：每幀約每像素 1.5 位元組（1080p 約 3MB），拆完要留 5GB，不夠會回錯並建議縮小或抽樣。
   - `fps`：每秒只取幾幀（例：整支 8 分鐘用 `fps:2` 先粗看 960 張，再挑段落用原幀率拆）。
   - `max_h`：原圖最高幾像素（1080p 直式影片建議 600～720，省硬碟又夠看）。
   回 `{id:拆幀編號, frames, fps, width, height, audio, range}`；已經拆過的 `GET /api/studio/frames`。網頁是 `POST /api/studio/frames/split_file?name=&start=&end=&fps=&max_h=`（內容是影片檔本身）。
3. 看（用 `anima_api` 打這些會直接回圖）：
   - 對照表 `GET …/<拆幀編號>/sheet?from=&to=&cols=&step=&h=&crop=`：每格標幀號（黃）＋原片秒數（藍），一次最多 100 格。`step` 隔幾幀取一張；`h` 每格高（>160 讀原圖，最大 1080）；`crop=x,y,w,h`（0～1 比例）只看畫面一塊，放大看手、嘴、接觸點。
   - 分析 `GET …/<拆幀編號>/analyze`（加 `?full=1` 才有每幀陣列）：`cuts` 硬剪接、`jumps` 小跳動（接縫、掉幀、閃一下）、`shots` 鏡頭段落與秒數、`dups` 重複幀比例與最常見間隔（看出補幀／幀率轉換）、`loud_db` 每幀音量。
   - 時間軸圖 `GET …/<拆幀編號>/graph?from=&to=&w=`：灰長條＝每幀變化量，紅線＝硬剪接，橘線＝小跳動，藍點＝重複幀，綠線＝音量，底下是原片秒數。
   - 差異圖 `GET …/<拆幀編號>/diff?a=&b=&h=&crop=`：兩幀並排＋差異熱度圖（越亮越紅黃＝變越多；b 不給＝下一幀）。用來看剪接是硬切還是溶接、接縫哪裡跳、哪些部位在動。
   - 單幀原圖 `GET …/<拆幀編號>/f/<n>`。
   建議順序：analyze → graph 看全貌 → 每個 cut／jump 用 diff 和前後 ±10 幀的 sheet 看清楚 → 要看細節再 crop。
4. 修：`POST /api/studio/frames/<拆幀編號>/edit` 帶 `{n, op:"blend"}`（前後平均）、`{n, op:"copy", from}`、`{n, op:"gallery", image_id}`（換成圖庫的圖）、`{n, op:"restore"}`。要重畫某一幀：`POST …/to_input {n}` → `{name}` 當 `init_image` 用 inpaint／img2img 畫好，再用 op gallery 換進去。
5. 接回：`POST /api/studio/frames/<拆幀編號>/build` → 新影片進圖庫（原本的聲音、同樣 fps）。
改之前先說要改哪幾幀、為什麼；改完用 sheet 再看一次。

## 系統、設定、雲端

- `GET /api/system`：版本、顯示卡、顯存、記憶體、硬碟。`GET /api/state`：`anima_status` 的原始資料。
- 設定：`GET /api/state` 的 `settings`（不含金鑰）；改設定 `POST /api/settings`（要確認，不要動預設負面詞、預設值）。
- 雲端（給生圖助手和 H3 用）：`GET /api/agent/cloud`。開機、關機、改設定都要確認。
- 雲端選卡：`GET /api/agent/cloud` 的 `gpus` 是能選的卡（推薦三張＋RunPod 目錄自動抓的 48GB 以上 NVIDIA 卡；`stock` High／Medium／Low，空字串＝現在租光；`preset:false` 的還沒實測）。`GET /api/agent/cloud/gpus` 馬上重抓（平常每 10 分鐘自動）。開機帶 `{confirm:true, gpu:<key>}`。
- websocket `ws://…/ws` 會推送進度（type：image、finish、progress、queue、director、comic、h3、agent…）；MCP 不需要，輪詢 API 就好。

## 已知的坑

- 參數缺了不會報錯的：txt2img 缺 width 會變 256、缺 steps 會變 0（`anima_generate` 會補，`anima_api` 直接打 /api/generate 時要自己給）。
- LoRA 家族不合、`control` 用在非 anima、`pose_control` 用在非 qwen21、`count` 超過 32：都不會報錯，只是沒效果。
- 同一個 ComfyUI 同時載 Anima＋Qwen 會把 32GB 記憶體吃光卡住：換家族前 `POST /api/free`（漫畫台、生成會自己處理大部分情況）。
- 影片生成前會自動釋放顯存，第一次載入模型比較久（幾十秒到幾分鐘）。
- AI 改寫的 llama-server 吃 5～6GB 顯存，按生成前生圖站會自動關掉它。
- 9B 小模型分不清左右、會漏看，精細的判斷用 35B 或你自己看圖。
