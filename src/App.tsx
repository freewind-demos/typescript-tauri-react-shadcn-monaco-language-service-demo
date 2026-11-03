// 界面：左侧项目文件、右侧打开的标签页与 Monaco 编辑区。
// 所有 TypeScript 语义能力都来自后台的 language server，这里只负责把文件、模型和请求接起来。
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import * as monaco from 'monaco-editor'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { LspSession, type LspDiagnostic } from '@/lib/lsp'
import { applyDiagnostics, bindLspToMonaco } from '@/lib/lsp-monaco'

// 后端返回的项目文件项，absolute 用于读写，relative 用于展示。
type ProjectFile = { absolute: string; relative: string }

// .tsx 在 Monaco 里是独立语言 id，必须和 .ts 分开
function languageOf(path: string): string {
  return path.endsWith('.tsx') ? 'typescriptreact' : 'typescript'
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

// 关键步骤写进后端日志：桌面端没有控制台可看，出问题时只能靠日志定位。
function report(message: string): void {
  void invoke('log_message', { message }).catch(() => {})
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const sessionRef = useRef<LspSession | null>(null)
  // path -> Monaco model，一个文件只建一次模型，切换标签页只是换 model
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>())
  const disposablesRef = useRef<monaco.IDisposable[]>([])
  const diagnosticCountsRef = useRef(new Map<string, number>())
  // 供编辑器快捷键调用，避免快捷键回调闭包里拿到过期的状态
  const saveRef = useRef<() => void>(() => {})
  // 项目切换令牌：只有最新一次打开请求可以继续，旧的直接丢弃
  const projectTokenRef = useRef(0)

  const [projectRoot, setProjectRoot] = useState('')
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [tabs, setTabs] = useState<string[]>([])
  const [activePath, setActivePath] = useState('')
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState('')
  const [diagnosticCount, setDiagnosticCount] = useState(0)

  // 语言服务推送诊断时，画到对应文件的编辑区并更新统计
  const handleDiagnostics = useCallback((uri: string, diagnostics: LspDiagnostic[]) => {
    applyDiagnostics(uri, diagnostics)
    diagnosticCountsRef.current.set(uri, diagnostics.length)
    let total = 0
    for (const count of diagnosticCountsRef.current.values()) total += count
    setDiagnosticCount(total)
  }, [])

  // 取模型：优先用已建好的，否则读磁盘内容建一个，并告诉语言服务这份文档已打开
  const ensureModel = useCallback(async (path: string) => {
    const existing = modelsRef.current.get(path)
    if (existing) return existing

    const text = await invoke<string>('read_text_file', { path })
    const languageId = languageOf(path)
    const uri = monaco.Uri.file(path)
    const model = monaco.editor.createModel(text, languageId, uri)
    modelsRef.current.set(path, model)
    sessionRef.current?.didOpen(uri.toString(), languageId, text)

    model.onDidChangeContent(() => {
      // 未保存的编辑也要同步给语言服务，否则补全与诊断会基于旧内容
      sessionRef.current?.didChange(uri.toString(), model.getValue())
      setDirtyPaths((previous) => {
        if (previous.has(path)) return previous
        const next = new Set(previous)
        next.add(path)
        return next
      })
    })

    return model
  }, [])

  // 切到某个文件：建模型、换编辑器内容、把标签页放到最前
  const activateFile = useCallback(
    async (path: string) => {
      const editor = editorRef.current
      if (!editor) return
      const model = await ensureModel(path)
      editor.setModel(model)
      setTabs((previous) => (previous.includes(path) ? previous : [...previous, path]))
      setActivePath(path)
      editor.focus()
    },
    [ensureModel],
  )

  // 转到定义时调用：目标文件可能还没打开，先加载并切过去，Monaco 才能在它上面定位光标
  const openFileForNavigation = useCallback(
    async (path: string) => {
      const editor = editorRef.current
      if (!editor) return
      const model = await ensureModel(path)
      editor.setModel(model)
      setTabs((previous) => (previous.includes(path) ? previous : [...previous, path]))
      setActivePath(path)
    },
    [ensureModel],
  )

  // 保存当前文件：把编辑器里的文本写回磁盘，并清掉未保存标记
  const saveActive = useCallback(async () => {
    if (!activePath) return
    const model = modelsRef.current.get(activePath)
    if (!model) return
    await invoke('write_text_file', { path: activePath, content: model.getValue() })
    setDirtyPaths((previous) => {
      if (!previous.has(activePath)) return previous
      const next = new Set(previous)
      next.delete(activePath)
      return next
    })
  }, [activePath])

  useEffect(() => {
    saveRef.current = saveActive
  }, [saveActive])

  // 停掉旧会话并清空模型，切换项目时避免上一份语言服务残留
  const resetWorkspace = useCallback(() => {
    for (const disposable of disposablesRef.current) disposable.dispose()
    disposablesRef.current = []
    editorRef.current?.setModel(null)
    for (const model of modelsRef.current.values()) model.dispose()
    modelsRef.current.clear()
    diagnosticCountsRef.current.clear()
    setDiagnosticCount(0)
    setTabs([])
    setActivePath('')
    setDirtyPaths(new Set())
  }, [])

  // 打开一个项目：起语言服务、挂语言能力、列出文件、默认打开入口文件
  const openProject = useCallback(
    async (root: string) => {
      // 用户可能连续点“打开文件夹”，只让最后一次生效，避免前一次的握手被中途弃掉
      const token = ++projectTokenRef.current
      resetWorkspace()
      await sessionRef.current?.stop()
      if (token !== projectTokenRef.current) return

      setStatus('正在启动 TypeScript 语言服务…')
      report(`open project ${root}`)

      const session = new LspSession({ onDiagnostics: handleDiagnostics })
      sessionRef.current = session
      try {
        await session.start(root)
      } catch (error) {
        if (token === projectTokenRef.current) {
          setStatus(`语言服务启动失败：${String(error)}`)
          report(`start failed: ${String(error)}`)
        }
        return
      }
      if (token !== projectTokenRef.current) {
        await session.stop()
        return
      }
      report('language service ready')
      disposablesRef.current = bindLspToMonaco(session, { openFileForNavigation })

      const list = await invoke<ProjectFile[]>('list_project_files', { root })
      if (token !== projectTokenRef.current) return
      setProjectRoot(root)
      setFiles(list)
      setStatus('TypeScript 语言服务已连接')

      const entry = list.find((file) => file.relative.endsWith('src/main.ts')) ?? list[0]
      if (entry) await activateFile(entry.absolute)
    },
    [activateFile, handleDiagnostics, openFileForNavigation, resetWorkspace],
  )

  // 选目录：用系统文件对话框挑一个 TypeScript 项目
  const pickFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: '选择 TypeScript 项目目录' })
    if (typeof selected === 'string') await openProject(selected)
  }, [openProject])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const editor = monaco.editor.create(container, {
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      model: null,
    })
    editorRef.current = editor

    // Cmd/Ctrl+S 保存；Cmd/Ctrl+B 跳到定义，沿用 IDEA 的习惯
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => {
      void editor.getAction('editor.action.revealDefinition')?.run()
    })

    // 启动即打开 demo 自带的样例项目，界面默认态就能看到补全与跳转的效果
    report('app mounted')
    window.addEventListener('error', (event) => report(`window error: ${event.message}`))
    window.addEventListener('unhandledrejection', (event) => report(`unhandled rejection: ${String(event.reason)}`))
    void (async () => {
      const sampleRoot = await invoke<string>('sample_project_path')
      report(`sample project: ${sampleRoot}`)
      await openProject(sampleRoot)
    })()

    return () => {
      editor.dispose()
    }
    // 初始化只跑一次，后续切项目走 openProject
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeDirty = dirtyPaths.has(activePath)

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Button size="sm" variant="outline" onClick={() => void pickFolder()}>
          打开文件夹
        </Button>
        <span className="truncate text-xs text-muted-foreground">{projectRoot}</span>
        <div className="ml-auto flex items-center gap-3">
          {diagnosticCount > 0 && (
            <span className="text-xs text-destructive">{diagnosticCount} 个问题</span>
          )}
          <Button size="sm" disabled={!activeDirty} onClick={() => void saveActive()}>
            保存
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r">
          <ScrollArea className="flex-1">
            <ul className="p-1">
              {files.map((file) => (
                <li key={file.absolute}>
                  <button
                    type="button"
                    onClick={() => void activateFile(file.absolute)}
                    className={cn(
                      'w-full truncate rounded-sm px-2 py-1 text-left text-xs hover:bg-accent',
                      file.absolute === activePath && 'bg-accent text-accent-foreground',
                    )}
                  >
                    {file.relative}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-2">
            {tabs.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => void activateFile(path)}
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-accent',
                  path === activePath && 'bg-accent text-accent-foreground',
                )}
              >
                {baseName(path)}
                {dirtyPaths.has(path) && <span className="text-[10px]">●</span>}
              </button>
            ))}
          </div>
          <div ref={containerRef} className="min-h-0 flex-1" />
        </main>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t px-3 text-[11px] text-muted-foreground">
        <span>{status}</span>
        {activePath && <span className="truncate">{activePath}</span>}
      </footer>
    </div>
  )
}
