# typescript-tauri-react-shadcn-monaco-language-service-demo

## 简介

用 Tauri + React + shadcn/ui + Monaco Editor 搭一个最小 IDE 原型：编辑器本身不含 TypeScript 分析能力，补全、悬浮提示、跨文件跳转定义与错误诊断全部来自本机运行的真实 TypeScript 语言服务。

目的只有一个：验证「轻量桌面编辑器 + 后台语言服务」这条路线能不能撑起日常写 TypeScript 的基本体验。

## 快速开始

### 环境要求

- Node.js 20 以上
- pnpm
- Rust 工具链（`rustc`、`cargo`）

### 运行

```bash
pnpm install
pnpm start
```

`pnpm start` 会启动 Vite 开发服务器与 Tauri 窗口。窗口打开后自动加载 `samples/typescript-project` 样例项目，并打开 `src/main.ts`。

试用点：

- 在 `console.log(user.name)` 的 `user.` 后面按 `Ctrl+Space`，候选里应出现 `id`、`name`、`email`。
- 把光标放在 `rename` 上按 `Cmd+B`（macOS）或 `Ctrl+B`，应跳到 `src/api.ts` 里的函数定义。
- 把鼠标停在 `user` 上，应显示 `const user: User`。
- 随便制造一个类型错误，左下角状态栏右侧会出现问题数量，对应位置有红色波浪线。
- 修改内容后标签页出现 `●`，按 `Cmd/Ctrl+S` 保存。

只跑前端（不开桌面窗口）：`pnpm dev`。

打包桌面应用：先 `pnpm build`，再 `pnpm tauri build`。

## 注意事项

- 语言服务用本机 `node` 启动，路径为项目内的 `node_modules/typescript-language-server/lib/cli.mjs`。想指向别的安装位置，设置环境变量 `TS_LANGUAGE_SERVER_ENTRY`；想换 node 可执行文件，设置 `NODE_BINARY`。
- 只支持 TypeScript 与 TSX。JS、JSON、CSS 没有接入语义能力，只有语法高亮。
- 首版只做单项目、单窗口；没有终端、Git、调试、全局搜索、扩展系统。
- 首次打开项目后 tsserver 需要一点点时间建索引，这几秒内的补全会自动重试，不是卡死。
- 直接执行 `src-tauri/target/debug/monaco-lsp-demo` 会白屏：debug 构建默认加载 `devUrl`。要么用 `pnpm start`，要么用 `pnpm tauri build` 出的应用。

## 教程

### 为什么要接语言服务

Monaco 自带一个跑在 Web Worker 里的 TypeScript 服务，能补全、能诊断。但它只看得到你喂给它的文件：它不知道你项目里的 `tsconfig.json`、不会去读磁盘上的其它文件、也解析不了 `node_modules` 里的类型。想让它像一个 IDE，就得自己把整个项目连同依赖一起塞进浏览器，代价很大。

换一条路：把分析交给官方那套工具链。

```
Monaco Editor (WebView)
      │  补全 / 悬浮 / 定义
      ▼
LSP 客户端（src/lib/lsp.ts）
      │  JSON-RPC 报文
      ▼
Tauri 后端（src-tauri/src/lib.rs）
      │  stdin / stdout
      ▼
typescript-language-server → tsserver
```

`tsserver` 就是 VS Code 用的那个 TypeScript 语言服务，它本来就跑在 Node 里，能读磁盘、能读 `tsconfig.json`、能解析 `node_modules`。`typescript-language-server` 在它外面套一层标准 LSP 协议，于是任何支持 LSP 的编辑器都能用上同一套分析能力。

Monaco 只负责显示：它把「用户按了 Ctrl+Space」翻译成一句 LSP 请求，把返回的候选渲染成下拉列表。一行类型推断的代码都没写在自己手里。

### 三条关键链路

**启动**。`openProject` 让后端 `node cli.mjs --stdio` 起一个子进程，工作目录设为项目根目录；同时把这两个文件接到 vscode-jsonrpc 的 `MessageReader` / `MessageWriter` 接口上，得到一条标准 JSON-RPC 连接，然后发 `initialize` 握手。

**报文分帧**。LSP 走的是 `Content-Length: N\r\n\r\n{json}` 格式，这个 N 是字节数而不是字符数。后端 `pump_stdout` 严格按字节读取，前端 `TauriMessageWriter` 也按字节写头。按行读会在消息体里带换行时截断，这是自制 LSP 通道最常见的坑。

**文档同步**。打开文件时发 `textDocument/didOpen`，之后每次改动发 `textDocument/didChange`，且用全文同步（`TextDocumentSyncKind.Full`）。这一点决定了「未保存的编辑也能参与分析」：你把 `email: string` 改成 `number`，光标还没离开，另一处引用它的类型提示就已经变了。

### 为什么关掉 Monaco 内置的 TypeScript 服务

`src/main.tsx` 里把内置 TS 服务的 `modeConfiguration` 全部设为 `false`。不关的话，同一份代码会得到两套补全候选、两套诊断，而且内置那套读不到项目，结果经常是错的。我们只留它的语法高亮。

### 坐标换算只有一处

LSP 的行列从 0 开始，Monaco 从 1 开始。这种偏移写散在十个地方必然出错，所以 `src/lib/lsp.ts` 与 `src/lib/lsp-monaco.ts` 里的 `toLspPosition` / `toMonacoRange` 是唯一的换算入口。补全项、悬浮、定义结果都从这里过。

### 补全项的形状

LSP 的 `CompletionItem` 和 Monaco 的 `languages.CompletionItem` 不是一一对应：种类编号不同（`toCompletionKind` 查表），文本可能藏在 `textEdit.newText` 里，带占位符的片段要设 `InsertAsSnippet` 才生效。`toSuggestion` 把这些差异收在一个函数里。

### 跨文件跳转为什么要多一步

语言服务返回的目标可能是一个还没打开的文件。Monaco 只能在已存在的 model 上定位光标，所以 `provideDefinition` 先让界面把目标文件加载成 model 并切过去，再把位置交给 Monaco。少了这一步，跳转在文件未打开时会静默失败。

### 已知取舍

- 语言服务进程随应用启动、随项目切换重启、随应用退出被杀，不做多项目常驻。
- 只实现了 `completion` / `hover` / `definition` 与诊断推送，`references`、`rename`、`signatureHelp` 都能按同一套映射补上，但没做。
- 生产打包依赖编译期嵌入前端资源，所以改完前端要先 `pnpm build` 再编译 Rust。
