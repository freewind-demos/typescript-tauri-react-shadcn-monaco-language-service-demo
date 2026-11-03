// 把 LSP 的协议结果翻译成 Monaco 能显示的补全列表、悬浮提示和跳转目标。
// 这一层是纯映射：不自己算类型，也不缓存语言服务的答案。
import * as monaco from 'monaco-editor'
import {
  uriToPath,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspSession,
  type Position,
  type Range,
} from './lsp'

// Monaco 里 .ts 与 .tsx 是两种语言 id，补全、悬浮、跳转都要同时挂上去。
const LANGUAGE_IDS = ['typescript', 'typescriptreact']

export type LspBindingOptions = {
  // 跳转目标可能还没打开：先加载文件并切到前台，再把结果交给 Monaco 定位
  openFileForNavigation: (path: string) => Promise<void>
}

// Monaco 的位置与 LSP 的位置只差 0/1 起始，转换集中在两处，避免各处手写 ±1 出错。
function toLspPosition(position: monaco.Position): Position {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

function toMonacoRange(range: Range): monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  )
}

// LSP 的 CompletionItemKind 与 Monaco 的 CompletionItemKind 编号不同，必须查表转换。
function toCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 2:
      return monaco.languages.CompletionItemKind.Method
    case 3:
      return monaco.languages.CompletionItemKind.Function
    case 4:
      return monaco.languages.CompletionItemKind.Constructor
    case 5:
      return monaco.languages.CompletionItemKind.Field
    case 6:
      return monaco.languages.CompletionItemKind.Variable
    case 7:
      return monaco.languages.CompletionItemKind.Class
    case 8:
      return monaco.languages.CompletionItemKind.Interface
    case 9:
      return monaco.languages.CompletionItemKind.Module
    case 10:
      return monaco.languages.CompletionItemKind.Property
    case 11:
      return monaco.languages.CompletionItemKind.Unit
    case 12:
      return monaco.languages.CompletionItemKind.Value
    case 13:
      return monaco.languages.CompletionItemKind.Enum
    case 14:
      return monaco.languages.CompletionItemKind.Keyword
    case 15:
      return monaco.languages.CompletionItemKind.Snippet
    case 16:
      return monaco.languages.CompletionItemKind.Color
    case 17:
      return monaco.languages.CompletionItemKind.File
    case 18:
      return monaco.languages.CompletionItemKind.Reference
    case 19:
      return monaco.languages.CompletionItemKind.Folder
    case 20:
      return monaco.languages.CompletionItemKind.EnumMember
    case 21:
      return monaco.languages.CompletionItemKind.Constant
    case 22:
      return monaco.languages.CompletionItemKind.Struct
    case 23:
      return monaco.languages.CompletionItemKind.Event
    case 24:
      return monaco.languages.CompletionItemKind.Operator
    case 25:
      return monaco.languages.CompletionItemKind.TypeParameter
    default:
      return monaco.languages.CompletionItemKind.Text
  }
}

// 诊断严重级别：LSP 用 1-4，Monaco 用位掩码 8/4/2/1。
function toMarkerSeverity(severity: number | undefined): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error
    case 2:
      return monaco.MarkerSeverity.Warning
    case 3:
      return monaco.MarkerSeverity.Info
    default:
      return monaco.MarkerSeverity.Hint
  }
}

// LSP 的悬浮内容有四种写法，统一转成 Monaco 的 Markdown 数组。
function toHoverContents(contents: LspHover['contents']): monaco.IMarkdownString[] {
  if (typeof contents === 'string') return [{ value: contents }]
  if (Array.isArray(contents)) {
    return contents.map((entry) =>
      typeof entry === 'string' ? { value: entry } : { value: `\`\`\`${entry.language}\n${entry.value}\n\`\`\`` },
    )
  }
  return [{ value: contents.value }]
}

// 补全项可能在 textEdit 里给出替换范围和带占位符的文本，这决定了补全后光标停在哪。
function toSuggestion(
  item: LspCompletionItem,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): monaco.languages.CompletionItem {
  const label = typeof item.label === 'string' ? item.label : item.label.label
  const word = model.getWordUntilPosition(position)
  const fallbackRange = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  )
  const insertText = item.textEdit?.newText ?? item.insertText ?? label
  const documentation =
    typeof item.documentation === 'string' ? item.documentation : item.documentation?.value

  return {
    label: { label, detail: item.labelDetails?.detail, description: item.labelDetails?.description },
    kind: toCompletionKind(item.kind),
    detail: item.detail,
    documentation: documentation ? { value: documentation } : undefined,
    insertText,
    // 语言服务给出 snippet 格式时按占位符插入，否则原样插入
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    filterText: item.filterText,
    sortText: item.sortText,
    preselect: item.preselect,
    range: item.textEdit ? toMonacoRange(item.textEdit.range) : fallbackRange,
  }
}

// 转到定义的结果有三种形态：单个位置、位置数组、带目标范围的链接。
function toLocations(
  result: LspLocation | LspLocation[] | LspLocationLink[] | null,
): Array<{ uri: string; range: Range }> {
  if (!result) return []
  const list = Array.isArray(result) ? result : [result]
  return list.map((entry) =>
    'targetUri' in entry
      ? { uri: entry.targetUri, range: entry.targetSelectionRange }
      : { uri: entry.uri, range: entry.range },
  )
}

// 补全结果有两种包装形式：裸数组或 items 对象，统一取出数组。
function toCompletionItems(
  result: LspCompletionItem[] | { items: LspCompletionItem[] } | null | undefined,
): LspCompletionItem[] {
  if (!result) return []
  return Array.isArray(result) ? result : (result.items ?? [])
}

// 注册补全、悬浮、转到定义三类语言能力，返回可用于整体注销的 disposables。
export function bindLspToMonaco(
  session: LspSession,
  options: LspBindingOptions,
): monaco.IDisposable[] {
  const completionProvider = monaco.languages.registerCompletionItemProvider(LANGUAGE_IDS, {
    // 输入这些字符后自动弹出补全，覆盖成员访问、字符串导入路径与泛型写法
    triggerCharacters: ['.', '"', "'", '`', '/', '@', '<'],
    async provideCompletionItems(model, position) {
      const uri = model.uri.toString()
      const lspPosition = toLspPosition(position)
      const items = toCompletionItems(await session.completion(uri, lspPosition))
      // 项目刚连上时 tsserver 还在建索引，空结果不代表真的没有候选，多试几次
      if (items.length === 0 && session.isWarmingUp()) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 600))
          items.push(...toCompletionItems(await session.completion(uri, lspPosition)))
          if (items.length > 0) break
        }
      }
      return { suggestions: items.map((item) => toSuggestion(item, model, position)) }
    },
  })

  const hoverProvider = monaco.languages.registerHoverProvider(LANGUAGE_IDS, {
    async provideHover(model, position) {
      const hover = await session.hover(model.uri.toString(), toLspPosition(position))
      if (!hover) return null
      return {
        contents: toHoverContents(hover.contents),
        range: hover.range ? toMonacoRange(hover.range) : undefined,
      }
    },
  })

  const definitionProvider = monaco.languages.registerDefinitionProvider(LANGUAGE_IDS, {
    async provideDefinition(model, position) {
      const result = await session.definition(model.uri.toString(), toLspPosition(position))
      const locations = toLocations(result)
      if (locations.length === 0) return null

      // 目标文件往往还没打开，先让界面加载它，Monaco 随后才能在该文件的 model 上定位
      await options.openFileForNavigation(uriToPath(locations[0].uri))

      return locations.map((location) => ({
        uri: monaco.Uri.parse(location.uri),
        range: toMonacoRange(location.range),
      }))
    },
  })

  return [completionProvider, hoverProvider, definitionProvider]
}

// 把语言服务推送的诊断画到对应文件的编辑区，其他来源的诊断不受影响。
export function applyDiagnostics(uri: string, diagnostics: LspDiagnostic[]): void {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri))
  if (!model) return
  monaco.editor.setModelMarkers(
    model,
    'lsp',
    diagnostics.map((diagnostic) => ({
      severity: toMarkerSeverity(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source,
      startLineNumber: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endLineNumber: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
    })),
  )
}
