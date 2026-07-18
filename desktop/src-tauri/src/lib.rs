// 图片标注 - Tauri 库入口（run() 由 main.rs 调用）

use std::process::Command;

/// 用系统默认程序打开指定路径（文件夹或文件）。
/// Windows → explorer.exe，macOS → open，Linux → xdg-open。
#[tauri::command]
fn open_in_system(path: String) -> Result<(), String> {
    let r = if cfg!(target_os = "windows") {
        // explorer.exe 可以直接打开路径；/root, 参数让它在根节点显示
        Command::new("explorer.exe").arg(&path).spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&path).spawn()
    } else {
        Command::new("xdg-open").arg(&path).spawn()
    };
    match r {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("无法打开 {}: {}", path, e)),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![open_in_system])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
