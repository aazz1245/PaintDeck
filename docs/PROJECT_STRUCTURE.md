# 繪匣 PaintDeck 项目结构拆解

本文档对应仓库当前版本 `26.1117.4`，用于说明项目的目录职责、运行时组件、请求链路、数据存储和常见修改入口。模型文件、ComfyUI 本体和用户数据不属于 Git 仓库源码的一部分。

## 1. 总体架构

绘匣由四层组成。

```text
桌面外壳 Tauri
    |
    +-- 内建 Rust HTTP/WebSocket 服务，默认 127.0.0.1:8190
    |       |
    |       +-- 静态网页 ui/
    |       +-- REST API /api/*
    |       +-- 实时事件 /ws
    |       +-- SQLite 与文件数据
    |
    +-- ComfyUI，默认 127.0.0.1:8188
            |
            +-- 节点图提交、队列、进度、预览和输出文件
```

桌面版和无头版使用同一套 Rust 服务和网页。桌面版由 Tauri 创建窗口、系统托盘和生命周期管理，无头版只启动 `anima-server`，浏览器通过 HTTP 访问它。

一次文生图请求的主要链路如下。

```text
ui/js/gen.js
  -> POST /api/generate
  -> src-tauri/src/server/api_gen.rs
  -> src-tauri/src/graphs.rs 生成 ComfyUI API 节点图
  -> src-tauri/src/comfy.rs 或 src-tauri/src/nodes.rs
  -> ComfyUI /prompt
  -> ComfyUI 回传队列、进度和图片
  -> Hub 广播 /ws
  -> ui/js/main.js 分发事件
  -> gen.js、gallery.js、queue.js 更新界面和数据库记录
```

## 2. 顶层目录

| 目录或文件 | 职责 |
|---|---|
| `src-tauri/` | Rust 服务、桌面程序、模型处理、API 路由和测试 |
| `ui/` | 原生 ES module 网页界面，不使用前端打包工具 |
| `resources/` | 随程序发布的提示词、词库、工作流、节点、模型清单和第三方资源 |
| `tools/` | 维护脚本、资源生成脚本、打包辅助脚本和模型检查工具 |
| `tests/` | 前端 Node.js 测试和少量 Python 测试 |
| `docs/` | 截图、项目说明和维护文档 |
| `vendor/` | 不进入 Git 的大体积运行时文件，例如 ONNX Runtime 和 7-Zip |
| `src-tauri/Cargo.toml` | Rust 依赖、二进制入口、编译 profile 和功能开关 |
| `src-tauri/tauri.conf.json` | Tauri 窗口、网页目录、资源目录和安装包配置 |
| `README.md` | 面向用户的功能说明、安装、编译和简要目录 |

根目录的 `anima-app.exe`、`anima-server.exe`、`onnxruntime.dll`、`7zr.exe` 和大型压缩包属于本地运行或发布产物。它们不应作为源码修改提交。

## 3. Rust 后端

### 3.1 启动入口

| 文件 | 作用 |
|---|---|
| `src-tauri/src/main.rs` | Windows/Linux 桌面版入口。抢占端口、读取配置、启动内建服务、创建 Tauri 窗口和系统托盘，并负责关闭自己启动的 ComfyUI |
| `src-tauri/src/bin/anima-server.rs` | 无头服务入口。读取环境变量或命令行配置，只启动 HTTP 服务，不依赖 Tauri 桌面功能 |
| `src-tauri/src/lib.rs` | 注册共享 Rust 模块，供桌面入口、无头入口和测试复用 |
| `src-tauri/src/launcher.rs` | 启动、停止和监控 ComfyUI 进程 |
| `src-tauri/src/setup.rs` | 第一次启动精灵、依赖安装、模型和节点安装、升级迁移 |
| `src-tauri/src/paths.rs` | 统一计算数据根目录、网页、资源、ComfyUI、数据库、输入输出和模型目录 |

桌面版默认使用端口 `8190`。开发时运行 `anima-server` 默认使用 `8191`，可以通过 `ANIMA_PORT` 覆盖。ComfyUI 默认地址是 `http://127.0.0.1:8188`，通过 `COMFY_URL` 覆盖。

### 3.2 服务层和路由

`src-tauri/src/server/mod.rs` 是 API 总入口，主要负责以下职责。

- 创建 `App` 共享状态，集中持有路径、数据库、ComfyUI 客户端、工作节点池、AI 改写服务、助手和后台任务服务。
- 在 `router()` 中注册 REST 路由和静态文件服务。
- 通过 `only_local` 限制本机来源，避免内建服务被任意网页调用。
- 通过 `update_gate` 在程序更新或缓存清理期间阻止会修改数据的请求。
- 通过 `/ws` 建立实时事件连接。
- 启动后台模型目录刷新、tag 索引加载、旧图片导入和迁移任务。

服务端 API 按功能拆分在 `src-tauri/src/server/api_*.rs`。常见入口如下。

| API 文件 | 主要功能 |
|---|---|
| `api_gen.rs` | 状态、生成、任务、队列、中断、参数准备和工作流导出 |
| `api_models.rs` | 模型目录、扫描、导入、放置、下载和 ComfyUI 重启 |
| `api_gallery.rs` | 图片上传、图库查询、缩略图、输入图和批量操作 |
| `api_lib.rs` | 提示词库的整套设置、片段、文件夹、排序和缩略图 |
| `api_assets.rs` | 角色、场景、道具、声音和其他资产 |
| `api_misc.rs` | LoRA 元数据、预览图、封面、tag、系统维护和重置 |
| `api_wf.rs` | 导入的 ComfyUI 图像工作流和内建功能替换 |
| `api_video.rs`、`api_h3.rs`、`api_h3chain.rs` | 视频工作流、H3 短片和长片接续 |
| `api_director.rs` | 导演台、项目、角色卡、分镜和长片任务 |
| `api_comic.rs`、`api_colorbook.rs` | 漫画台和整本黑白漫画上色 |
| `api_agent.rs`、`api_agent_tools.rs` | 生图助手会话、工具调用和 LoRA 学习 |
| `api_pe.rs`、`api_llm.rs` | 本地 AI 改写、翻译、云端模型和 API 预设 |
| `api_train.rs`、`train_run.rs`、`train_ms.rs` | LoRA 训练项目、本地训练器、远程训练机和云端训练 |
| `api_hub.rs`、`api_cloud.rs`、`api_runninghub.rs` | 下载中心、云端显卡、工作节点和 RunningHub |
| `api_studio.rs`、`api_mixdesk.rs`、`api_video_review.rs` | FableCut、拆帧、混音和影片审片 |
| `api_sdapi.rs` | A1111 兼容接口，供 SillyTavern 等外部客户端调用 |

### 3.3 模型和 ComfyUI 适配

| 文件 | 作用 |
|---|---|
| `comfy.rs` | ComfyUI HTTP/WebSocket 客户端，负责对象信息、队列、提交、进度和预览 |
| `nodes.rs` | 主节点、其他本地显卡节点和远程 ComfyUI 节点池 |
| `graphs.rs` | 将统一生成参数转换为 ComfyUI API 节点图，并处理不同模型家族和生成模式 |
| `families.rs` | 从模型或 LoRA 文件判断 Anima、Qwen、MOSS、Krea、SDXL 等家族 |
| `image_wf.rs`、`video_wf.rs` | 保存的图像和视频工作流格式、字段映射和导入导出 |
| `model_dirs.rs` | 外部模型目录、扫描结果和重启提示 |
| `lora_cover.rs` | LoRA 封面来源、内置缩略图和预览图索引 |
| `pe.rs` | llama-server 生命周期、改写、翻译和本地模型连接 |
| `tagger.rs`、`tags.rs`、`tagclean.rs` | 图片反推、tag 索引、中文对照和提示词清理 |

`graphs.rs` 是模型行为的核心边界。新增模型族或改变采样、控制图、LoRA 注入时，优先在模型族和节点图生成层处理，不要把工作流判断塞进通用 HTTP 路由或网页组件。

### 3.4 状态、事件和持久化

`src-tauri/src/hub.rs` 使用 Tokio broadcast channel 保存服务器到网页的事件通道。事件分为两类。

- JSON 文本事件，例如 `hello`、`comfy`、`queue`、`progress`、`image`、`finish`、`download` 和后台功能事件。
- ComfyUI 预览图等二进制事件。

`src-tauri/src/db.rs` 负责 SQLite。核心表包括 `images`、`jobs`、`presets`、`lora_meta` 和 `prompt_lib`。读写数据库的逻辑应留在数据库模块或对应 API 模块，前端只通过 API 读写。

`src-tauri/src/paths.rs` 计算的主要运行时位置如下。

| 路径 | 内容 |
|---|---|
| `data/anima.db` | 图库、任务、提示词库和 LoRA 元数据 |
| `data/settings.json` | 应用设置、模型与工作流设置 |
| `data/thumbs/` | 图库和资产缩略图 |
| `data/previews/` | 用户替换的 LoRA 预览图 |
| `ComfyUI/input/` | 输入图和姿势控制图 |
| `ComfyUI/output/` | ComfyUI 输出图和绘匣回收区 |
| `resources/` | 随程序发布的只读资源 |

## 4. 网页前端

### 4.1 入口和公共基础

| 文件 | 作用 |
|---|---|
| `ui/index.html` | 单页应用的页面、表单、弹窗、模态框和各功能区 DOM |
| `ui/js/main.js` | 初始化所有模块、切页、读取 `/api/state`、建立 `/ws`、分发实时事件 |
| `ui/js/state.js` | 保存当前页面、服务器状态和共享应用对象 |
| `ui/js/util.js` | DOM 工具、API 请求、弹窗、Toast、本地存储、拖放和文件选择 |
| `ui/js/deck.js` | 顶栏、状态栏、生成按钮、系统托盘相关界面 |
| `ui/js/dock.js` | 生成页和其他页面的可拖动、可收起停靠面板 |
| `ui/js/i18n.js`、`ui/i18n/en.json` | 繁中、简中和英文界面切换 |
| `ui/css/app.css` | 全局主题、控件、卡片、面板和布局 |
| `ui/css/play.css`、`ui/css/motion.css`、`ui/css/mixdesk.css` | 图像玩法、动效和混音台样式 |

网页是原生 ES module。新增模块后通常需要同时在 `ui/index.html` 提供 DOM，在 `ui/js/main.js` 导入并初始化，在事件分发处接入相关 WebSocket 消息。

### 4.2 主要页面模块

| 页面模块 | 入口文件 | 后端对应 |
|---|---|---|
| 生成页 | `gen.js` | `api_gen.rs`、`graphs.rs` |
| 图库 | `gallery.js` | `api_gallery.rs` |
| 资产库 | `assets.js`、`assetdrawer.js` | `api_assets.rs`、`api_lib.rs` |
| LoRA 库 | `loras.js` | `api_misc.rs`、ComfyUI-Lora-Manager |
| 下载中心 | `hub.js` | `api_hub.rs`、`api_models.rs` |
| 提示词词库 | `taglib.js`、`taglibpage.js` | `api_misc.rs` |
| AI 改写和 API | `pe.js`、`llm.js` | `api_pe.rs`、`api_llm.rs` |
| 生图助手 | `agent.js`、`agentui.js` | `api_agent.rs`、`api_agent_tools.rs` |
| 导演台 | `director.js`、`studio.js` | `api_director.rs`、`api_studio.rs` |
| H3 视频 | `h3.js`、`h3chain.js` | `api_h3.rs`、`api_h3chain.rs` |
| 漫画台 | `comic.js`、`colorbook.js` | `api_comic.rs`、`api_colorbook.rs` |
| 训练台 | `train.js` | `api_train.rs`、`train_run.rs` |
| 拆帧和混音 | `framepick.js`、`ui/js/mixdesk/` | `api_studio.rs`、`api_mixdesk.rs` |

生成页 `gen.js` 持有当前模型、模式、LoRA、提示词和参数状态。它负责把表单状态整理成 `/api/generate` 请求，后端再依据模型族和模式生成节点图。不要让其他页面直接修改 ComfyUI 节点图，跨页面复用生成应调用生成模块提供的参数或入口。

LoRA 页面有两套用途。

- ComfyUI-Lora-Manager iframe 用于完整的 LoRA 文件管理、配方和管理器功能。
- 绘匣清单用于模型家族筛选、分类、标签、收藏、预览图和加入生成页。

两套视图共享服务器返回的 LoRA 元数据和生成页 LoRA 状态。修改 LoRA 管理时需要同时检查 `loras.js`、`gen.js`、`api_misc.rs` 和相关 UI 测试。

## 5. 资源目录

| 位置 | 内容 |
|---|---|
| `resources/agent/` | 助手、Anima、Qwen、MOSS、H3 和提示词模式的系统提示词 |
| `resources/extras/workflows/` | 内建图像工作流和导出模板 |
| `resources/extras/anima_*_nodes/` | 绘匣附带的 ComfyUI 自定义节点 |
| `resources/extras/comfy_moss/` | MOSS 相关 ComfyUI 补充代码或资源 |
| `resources/extras/fablecut/` | FableCut 剪辑台和绘匣 MCP 工具 |
| `resources/tags/` | Danbooru、WeiLin、中文对照和转换后的词库 |
| `resources/poses/` | 姿势数据、3D 参考和控制图 |
| `resources/h3/` | H3 拍摄单、模板和估算数据 |
| `resources/share/` | 模型下载清单、LoRA 说明、内置封面和镜像信息 |
| `resources/train/` | 训练小助手和训练相关资源 |

资源是程序行为的一部分。修改提示词默认值、模型清单、词库或内置工作流时，应同步检查对应的 Rust `include_str!`、启动迁移和测试。

## 6. 测试和质量检查

### Rust

```powershell
cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
```

Rust 测试位于 `src-tauri/tests/` 和各模块的 `#[cfg(test)]` 区域。重点类型如下。

- `api_routes.rs` 检查 API 路由和请求响应。
- `golden_*.rs` 对比节点图、提示词和旧版兼容结果。
- `golden_db.rs` 检查 SQLite 数据迁移和持久化。
- `setup_reuse.rs`、`official_turbo.rs`、`update_guard.rs` 检查安装、默认参数和更新保护。

### 前端

```powershell
node --test tests/*.test.cjs
node --check ui/js/main.js
node --check ui/js/gen.js
node --check ui/js/loras.js
```

前端测试多数使用 Node `vm` 建立轻量 DOM mock。页面结构改动时，相关测试通常需要同步补齐元素 mock，避免只在真实浏览器中才发现空节点或事件没有绑定。

## 7. 常见改动落点

| 需求 | 首先检查 |
|---|---|
| 新增或修改生成模式 | `ui/index.html`、`ui/js/gen.js`、`src-tauri/src/server/api_gen.rs`、`src-tauri/src/graphs.rs` |
| 新增模型家族或自动默认参数 | `families.rs`、`graphs.rs`、`gen.js`、`tests/model_prompt_defaults.test.cjs` |
| 修改 LoRA 显示、筛选或预览图 | `ui/js/loras.js`、`ui/js/gen.js`、`api_misc.rs`、`tests/lora_library_ui.test.cjs` |
| 修改提示词库或资产分类 | `ui/js/library.js`、`ui/js/assets.js`、`api_lib.rs`、`api_assets.rs`、`db.rs` |
| 增加 API | 对应 `server/api_*.rs`、`server/mod.rs` 路由、前端调用和 API 测试 |
| 增加实时进度事件 | 后端发送 `Hub` 消息、`ui/js/main.js` 分发、功能模块消费 |
| 修改模型目录或下载 | `paths.rs`、`model_dirs.rs`、`api_models.rs`、`hub.js` |
| 修改内建工作流 | `resources/extras/workflows/`、`wf_import.rs`、`graphs.rs` 和 golden 测试 |
| 修改安装、更新或桌面行为 | `main.rs`、`setup.rs`、`updater.rs`、`tauri.conf.json` |
| 修改界面翻译 | HTML/JS 原文、`tools/i18n_extract.py`、`tools/i18n/`、`ui/i18n/en.json` |

## 8. 开发和发布边界

- ComfyUI 是外部运行时。绘匣只负责调用它的 API、管理模型目录和生成节点图。
- `comfy.rs`、`graphs.rs` 等后端模块不应承担 UI、数据库页面状态或桌面窗口逻辑。
- `ui/` 不应直接读写 SQLite 或模型文件。文件操作应通过 Rust API 完成。
- 用户数据位于 `data/` 和 ComfyUI 的输入输出目录，升级源码时不应覆盖这些目录。
- `cargo tauri build` 使用 `src-tauri/tauri.conf.json` 的 `frontendDist` 和资源映射打包 `ui/`、`resources/` 与运行时文件。
- Windows 安装包、`target/`、模型权重和本地密钥不属于源码提交内容。

## 9. 最短排查路径

遇到网页打不开时，先确认 `anima-app` 或 `anima-server` 是否监听 `8190` 或开发端口，再访问 `/api/state`。

遇到 ComfyUI 连接问题时，检查 `COMFY_URL`、ComfyUI 的 `/system_stats` 和 `/object_info`，再看后端控制台的连接日志。

遇到生成参数不生效时，先看 `gen.js` 的 `collectParams()`，再看 `api_gen.rs` 的参数准备和 `graphs.rs` 的节点图，最后检查 ComfyUI 对应节点的实际输入。

遇到数据丢失或分类异常时，先备份 `data/anima.db` 和 `data/settings.json`，然后检查对应 API、数据库表和前端本地存储，避免直接复制整个项目目录覆盖用户数据。
