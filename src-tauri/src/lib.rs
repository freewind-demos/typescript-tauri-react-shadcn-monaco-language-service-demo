// 后端只做三件事：读文件、起 TypeScript 语言服务进程、在前后端之间转发 LSP 报文。
// 所有 TypeScript 语义分析都交给 language server（tsserver），Rust 侧不碰代码解析。
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{Emitter, Manager, State};

// 语言服务子进程及其标准输入。标准输出被独立线程读走，不放在这里。
struct LspProcess {
  child: Child,
  stdin: ChildStdin,
}

// 全局只保留一个语言服务实例；切换项目时先杀掉旧的再起新的。
#[derive(Default)]
struct LspState(Mutex<Option<LspProcess>>);

// 项目文件列表里的一项：absolute 供读写文件用，relative 供界面展示用。
#[derive(serde::Serialize)]
struct ProjectFile {
  absolute: String,
  relative: String,
}

// 编译期项目根目录（即 src-tauri 的上一级），用它定位 demo 自带的样例项目与语言服务入口。
fn project_root() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("src-tauri 一定在项目根目录内")
    .to_path_buf()
}

// 语言服务入口脚本，优先用环境变量覆盖，方便换成自己机器上的安装路径。
fn server_entry() -> PathBuf {
  match std::env::var("TS_LANGUAGE_SERVER_ENTRY") {
    Ok(value) => PathBuf::from(value),
    Err(_) => project_root()
      .join("node_modules/typescript-language-server/lib/cli.mjs"),
  }
}

// 递归收集 .ts/.tsx 文件，跳过依赖与构建产物目录，避免把整个 node_modules 灌给界面。
fn collect_files(root: &Path, dir: &Path, out: &mut Vec<ProjectFile>) {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return;
  };
  for entry in entries.flatten() {
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().to_string();
    if path.is_dir() {
      if matches!(
        name.as_str(),
        "node_modules" | ".git" | "dist" | "target" | ".turbo"
      ) {
        continue;
      }
      collect_files(root, &path, out);
      continue;
    }
    if !(name.ends_with(".ts") || name.ends_with(".tsx")) {
      continue;
    }
    let relative = path
      .strip_prefix(root)
      .unwrap_or(&path)
      .to_string_lossy()
      .to_string();
    out.push(ProjectFile {
      absolute: path.to_string_lossy().to_string(),
      relative,
    });
  }
}

// 列出项目内的 TypeScript 文件，前端用它渲染左侧文件列表。
#[tauri::command]
fn list_project_files(root: String) -> Result<Vec<ProjectFile>, String> {
  let root_path = PathBuf::from(&root);
  if !root_path.is_dir() {
    return Err(format!("不是有效目录: {root}"));
  }
  let mut files = Vec::new();
  collect_files(&root_path, &root_path, &mut files);
  files.sort_by(|a, b| a.relative.cmp(&b.relative));
  Ok(files)
}

// 读取单个文件的全文，打开文件时调用。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
  std::fs::read_to_string(&path).map_err(|error| format!("读取 {path} 失败: {error}"))
}

// 保存文件时调用，覆盖写入全文。
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
  std::fs::write(&path, content).map_err(|error| format!("写入 {path} 失败: {error}"))
}

// 返回 demo 自带样例项目的绝对路径，界面一启动就能直接打开它试用。
#[tauri::command]
fn sample_project_path() -> String {
  project_root()
    .join("samples/typescript-project")
    .to_string_lossy()
    .to_string()
}

// 从子进程标准输出里按 LSP 报文头切出完整消息，再交给前端。
// 必须按 Content-Length 的字节数读取：按行读会在消息体含换行时截断。
fn pump_stdout(app: tauri::AppHandle, reader: impl Read) {
  let mut reader = BufReader::new(reader);
  loop {
    let mut content_length: usize = 0;
    loop {
      let mut line = String::new();
      match reader.read_line(&mut line) {
        Ok(0) | Err(_) => return,
        Ok(_) => {}
      }
      let header = line.trim_end();
      if header.is_empty() {
        break;
      }
      if let Some(value) = header.strip_prefix("Content-Length:") {
        content_length = value.trim().parse().unwrap_or(0);
      }
    }
    if content_length == 0 {
      continue;
    }
    let mut body = vec![0u8; content_length];
    if reader.read_exact(&mut body).is_err() {
      return;
    }
    let message = String::from_utf8_lossy(&body).to_string();
    let _ = app.emit("lsp-message", message);
  }
}

// 前端把关键步骤写进后端日志，出问题时能在日志文件里看到卡在哪一步。
#[tauri::command]
fn log_message(message: String) {
  log::info!("[ui] {message}");
}

// 启动语言服务：node <cli.mjs> --stdio，工作目录设为被打开的项目根目录。
#[tauri::command]
fn lsp_start(app: tauri::AppHandle, state: State<'_, LspState>, root: String) -> Result<(), String> {
  log::info!("[lsp] start root={root}");
  let mut guard = state.0.lock().map_err(|_| "状态锁失效".to_string())?;
  if let Some(mut previous) = guard.take() {
    let _ = previous.child.kill();
    let _ = previous.child.wait();
  }

  let entry = server_entry();
  if !entry.is_file() {
    return Err(format!("找不到语言服务入口: {}", entry.display()));
  }
  let node = std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string());
  let mut child = Command::new(&node)
    .arg(&entry)
    .arg("--stdio")
    .current_dir(&root)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit())
    .spawn()
    .map_err(|error| format!("启动 {node} 失败: {error}"))?;

  let stdin = child.stdin.take().ok_or("无法获取语言服务标准输入")?;
  let stdout = child.stdout.take().ok_or("无法获取语言服务标准输出")?;
  log::info!("[lsp] spawned entry={} node={node}", entry.display());
  std::thread::spawn(move || pump_stdout(app, stdout));

  *guard = Some(LspProcess { child, stdin });
  Ok(())
}

// 把前端发来的一条 LSP 消息按协议补上报文头后写入子进程标准输入。
#[tauri::command]
fn lsp_send(state: State<'_, LspState>, message: String) -> Result<(), String> {
  let mut guard = state.0.lock().map_err(|_| "状态锁失效".to_string())?;
  let process = guard.as_mut().ok_or("语言服务尚未启动")?;
  let bytes = message.as_bytes();
  write!(process.stdin, "Content-Length: {}\r\n\r\n", bytes.len())
    .map_err(|error| format!("写入报文头失败: {error}"))?;
  process
    .stdin
    .write_all(bytes)
    .and_then(|_| process.stdin.flush())
    .map_err(|error| format!("写入报文失败: {error}"))
}

// 停止语言服务并回收进程，切换项目或退出时调用。
#[tauri::command]
fn lsp_stop(state: State<'_, LspState>) -> Result<(), String> {
  let mut guard = state.0.lock().map_err(|_| "状态锁失效".to_string())?;
  if let Some(mut process) = guard.take() {
    let _ = process.child.kill();
    let _ = process.child.wait();
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(LspState::default())
    .invoke_handler(tauri::generate_handler![
      list_project_files,
      read_text_file,
      write_text_file,
      sample_project_path,
      log_message,
      lsp_start,
      lsp_send,
      lsp_stop
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        // 同时写 stdout 与日志文件：直接跑二进制调试时能立刻看到输出
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .targets([
              tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
              tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
            ])
            .build(),
        )?;
      }
      log::info!("[app] setup finished");
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  // 退出时杀掉语言服务，避免留下孤儿 node 进程。
  app.run(|handle, event| {
    if let tauri::RunEvent::Exit = event {
      if let Some(state) = handle.try_state::<LspState>() {
        if let Ok(mut guard) = state.0.lock() {
          if let Some(mut process) = guard.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
          }
        }
      }
    }
  });
}
