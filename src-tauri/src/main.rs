// 阻止 Windows 发布版额外弹出控制台窗口，勿删。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  monaco_lsp_demo_lib::run();
}
