import { createRoot } from 'react-dom/client'
// 关闭内置 TypeScript 服务要拿到它自己的默认配置实例；语言高亮等能力仍由主入口注册。
import { typescriptDefaults } from 'monaco-editor/languages/features/typescript/register'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import App from './App'
import './index.css'

// Monaco 需要一个 worker 来处理分词与滚动等基础能力；语义能力全部来自后台语言服务。
self.MonacoEnvironment = {
  getWorker(_workerId: string, _label: string) {
    return new editorWorker()
  },
}

// 关掉 Monaco 内置的 TypeScript 语言服务：只保留语法高亮。
// 否则内置服务会给出与后台语言服务重复、且读不到本地项目的补全与诊断。
const typescriptMode = typescriptDefaults
typescriptMode.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true })
typescriptMode.setModeConfiguration({
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
})

createRoot(document.getElementById('root')!).render(<App />)
