fn main() {
    // 主視窗的網頁來自內建伺服器（外部網址），自訂指令要登記成權限，capabilities\main.json 才能開放
    let app = tauri_build::AppManifest::new().commands(&["hide_window", "quit_app"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app))
        .expect("tauri-build 失敗");
}
