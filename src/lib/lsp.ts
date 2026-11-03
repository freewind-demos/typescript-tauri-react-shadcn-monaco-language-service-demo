// LSP 客户端：把 Tauri 后端转发的报文接成一条 JSON-RPC 连接，并提供补全/悬浮/跳转/诊断的请求方法。
// 这里只做协议往返，不关心 Monaco 的 UI；把协议结果映射成编辑器能力的是 lsp-monaco.ts。
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
// 用 browser 入口：它在导入时安装浏览器运行时的抽象层，主入口在 WebView 里会报
// "No runtime abstraction layer installed"，导致消息无法分派。
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageConnection,
} from 'vscode-jsonrpc/browser'

export type Position = { line: number; character: number }
export type Range = { start: Position; end: Position }

export type LspLocation = { uri: string; range: Range }
export type LspLocationLink = { targetUri: string; targetSelectionRange: Range }

export type LspDiagnostic = {
  range: Range
  message: string
  severity?: number
  source?: string
}

export type LspCompletionItem = {
  label: string | { label: string; detail?: string; description?: string }
  kind?: number
  detail?: string
  labelDetails?: { detail?: string; description?: string }
  documentation?: string | { kind: string; value: string }
  insertText?: string
  insertTextFormat?: number
  filterText?: string
  sortText?: string
  preselect?: boolean
  textEdit?: { newText: string; range: Range }
  textEditText?: string
}

export type LspHover = {
  contents: string | { kind: string; value: string } | Array<string | { language: string; value: string }>
  range?: Range
}

// 把本地绝对路径转成 LSP 使用的 file:// URI，保留中文与空格的可读性交给 encodeURI 处理。
export function pathToUri(path: string): string {
  return `file://${encodeURI(path).replace(/[?#]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`
}

// 反向转换：语言服务返回的 URI 换回本机路径，用来读文件、开标签页。
export function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''))
}

// 从 Tauri 事件里收报文。Rust 侧已按 Content-Length 切好帧，这里只需反序列化成 JSON-RPC 对象。
class TauriMessageReader extends AbstractMessageReader {
  private unlisten: UnlistenFn | undefined
  // 事件监听是异步注册的；发 initialize 之前必须等它就绪，否则服务端的首次响应会丢
  readonly ready: Promise<void>
  private markReady: () => void = () => {}

  constructor() {
    super()
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve
    })
  }

  listen(callback: DataCallback): Disposable {
    let disposed = false
    void listen<string>('lsp-message', (event) => {
      if (disposed) return
      let message: Message
      try {
        message = JSON.parse(event.payload) as Message
      } catch {
        // 语言服务偶发输出非 JSON 内容时忽略，不打断整条连接
        return
      }
      try {
        callback(message)
      } catch (error) {
        // 分派失败会让请求永远等不到回复，必须把错误留在日志里
        void invoke('log_message', { message: `lsp dispatch failed: ${String(error)}` })
      }
    }).then((unlisten) => {
      if (disposed) unlisten()
      else this.unlisten = unlisten
      this.markReady()
    })

    return {
      dispose: () => {
        disposed = true
        this.unlisten?.()
        this.unlisten = undefined
      },
    }
  }
}

// 把 JSON-RPC 消息交给 Rust 写入子进程标准输入。用队列保证发送顺序，避免并发写乱序。
class TauriMessageWriter extends AbstractMessageWriter {
  private queue: Promise<void> = Promise.resolve()

  write(message: Message): Promise<void> {
    const payload = JSON.stringify(message)
    this.queue = this.queue.then(() => invoke('lsp_send', { message: payload })).then(() => undefined)
    return this.queue
  }

  end(): void {
    // 底层进程由 lsp_stop 命令终止，这里无需额外动作
  }
}

export type LspSessionHooks = {
  // 语言服务主动推送的诊断结果
  onDiagnostics: (uri: string, diagnostics: LspDiagnostic[]) => void
}

// 一个项目对应一个会话：启动子进程、初始化、维护文档版本号。
export class LspSession {
  private connection: MessageConnection | null = null
  private versions = new Map<string, number>()
  private rootUri = ''
  private hooks: LspSessionHooks
  private startedAt = 0

  constructor(hooks: LspSessionHooks) {
    this.hooks = hooks
  }

  // tsserver 读完 tsconfig、建好项目需要一段时间；期间补全会返回空。
  // 界面用这个窗口判断“是否值得再等一等重试”，避免把冷启动当成真的没有补全。
  isWarmingUp(): boolean {
    return Date.now() - this.startedAt < 15000
  }

  // 启动语言服务并完成 LSP 握手，握手成功后才允许发文档相关请求。
  async start(rootPath: string): Promise<void> {
    this.startedAt = Date.now()
    await invoke('lsp_start', { root: rootPath })

    const reader = new TauriMessageReader()
    const connection = createMessageConnection(reader, new TauriMessageWriter(), {
      error: (message) => console.error('[lsp]', message),
      warn: (message) => console.warn('[lsp]', message),
      info: (message) => console.info('[lsp]', message),
      log: (message) => console.log('[lsp]', message),
    })
    this.connection = connection
    this.rootUri = pathToUri(rootPath)

    connection.onNotification('textDocument/publishDiagnostics', (params: { uri: string; diagnostics?: LspDiagnostic[] }) => {
      this.hooks.onDiagnostics(params.uri, params.diagnostics ?? [])
    })

    // 语言服务会向客户端发这些请求，宿主不实现对应功能时按“无操作”应答，否则它会一直等待。
    connection.onRequest('client/registerCapability', () => null)
    connection.onRequest('client/unregisterCapability', () => null)
    connection.onRequest('window/workDoneProgress/create', () => null)
    connection.onRequest('window/showMessageRequest', () => null)
    connection.onRequest('workspace/applyEdit', () => ({ applied: false }))
    // TypeScript 语言服务会问格式化参数，返回默认值即可满足它
    connection.onRequest('workspace/configuration', () => [{ tabSize: 2, insertSpaces: true }])
    connection.onRequest('workspace/workspaceFolders', () => [{ uri: this.rootUri, name: 'workspace' }])
    connection.onNotification('window/logMessage', () => {})
    connection.onNotification('$/typescriptVersion', () => {})

    connection.listen()
    // 等事件监听真正注册好再握手，避免丢掉第一包响应
    await reader.ready

    await connection.sendRequest('initialize', {
      processId: null,
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: 'workspace' }],
      capabilities: {
        // 全文同步：每次改动直接把整份文本发过去，省掉增量区间计算
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              labelDetailsSupport: true,
            },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    })
    connection.sendNotification('initialized', {})
  }

  // 打开文档：告诉语言服务这份文件的初始内容，之后它才能对未保存的编辑做分析。
  didOpen(uri: string, languageId: string, text: string): void {
    this.versions.set(uri, 1)
    this.connection?.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    })
  }

  // 内容变化：全文同步，版本号递增。
  didChange(uri: string, text: string): void {
    const version = (this.versions.get(uri) ?? 0) + 1
    this.versions.set(uri, version)
    this.connection?.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
  }

  didClose(uri: string): void {
    this.versions.delete(uri)
    this.connection?.sendNotification('textDocument/didClose', { textDocument: { uri } })
  }

  completion(uri: string, position: Position) {
    return this.connection?.sendRequest<LspCompletionItem[] | { items: LspCompletionItem[] } | null>(
      'textDocument/completion',
      { textDocument: { uri }, position, context: { triggerKind: 1 } },
    )
  }

  hover(uri: string, position: Position) {
    return this.connection?.sendRequest<LspHover | null>('textDocument/hover', {
      textDocument: { uri },
      position,
    })
  }

  definition(uri: string, position: Position) {
    return this.connection?.sendRequest<LspLocation | LspLocation[] | LspLocationLink[] | null>(
      'textDocument/definition',
      { textDocument: { uri }, position },
    )
  }

  // 关闭连接并杀掉子进程，切换项目或卸载界面时调用。
  async stop(): Promise<void> {
    this.connection?.dispose()
    this.connection = null
    this.versions.clear()
    await invoke('lsp_stop')
  }
}
