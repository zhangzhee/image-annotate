// 图片标注 - Tauri 桌面端入口（Windows / macOS / Linux 共用）
// 前端为根目录的 web 核心（index.html + css/ + js/），由 tauri.conf.json 的 frontendDist 指定。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    image_annotate_lib::run()
}
