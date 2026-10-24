//! 不開視窗、只跑網頁伺服器（開發、跟舊版比對 API 用）。
//! 環境變數：ANIMA_ROOT（必填）、ANIMA_WEB、COMFY_ROOT、ANIMA_PORT（預設 8191，舊版佔 8190）、COMFY_URL（預設 http://127.0.0.1:8188）
#[tokio::main]
async fn main() {
    let Some(paths) = anima_app::paths::Paths::from_env() else {
        eprintln!("要設環境變數 ANIMA_ROOT（生圖站資料根目錄）");
        std::process::exit(2);
    };
    let port: u16 = std::env::var("ANIMA_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8191);
    let comfy = std::env::var("COMFY_URL").unwrap_or_else(|_| "http://127.0.0.1:8188".into());
    let app = match anima_app::server::start(paths, &comfy).await {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    // 測試精靈的 API（例如影音工作台的「下載剪輯工具」）：ANIMA_SETUP_CONFIG＝測試用的 config.json 路徑。不設就不掛
    let r = match std::env::var_os("ANIMA_SETUP_CONFIG").filter(|p| !p.is_empty()) {
        Some(cfg) => {
            let wizard = anima_app::setup::Setup::new(std::path::Path::new(&cfg), &app.paths.res);
            anima_app::server::attach_setup(&app, wizard.clone());
            let web = app.paths.web.clone();
            anima_app::server::router(app).merge(anima_app::setup::router(wizard, &web))
        }
        None => anima_app::server::router(app),
    };
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("佔不到 port {port}：{e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = anima_app::server::serve_on(r, listener).await {
        eprintln!("伺服器停止：{e}");
        std::process::exit(1);
    }
}
