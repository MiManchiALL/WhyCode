import type { ThemedToken } from 'shiki/core'
import type { HighlightLanguage } from './syntax-highlight.worker.ts'

export type HighlightTokens = Pick<ThemedToken, 'content' | 'offset' | 'htmlStyle'>[][]
export type HighlightRequest = { type: 'highlight'; id: number; source: string; language: HighlightLanguage }
  | { type: 'cancel'; id: number }
export interface HighlightResponse { id: number; tokens: HighlightTokens | null }
interface HighlightWorker {
  worker: Worker
  pending: Map<number, (tokens: HighlightTokens) => void>
  users: number
}

const MAX_HIGHLIGHT_SOURCE_CHARS = 160_000
let shared: HighlightWorker | null = null
let nextId = 0

/** 可见代码视图共享 Worker；最后一个视图关闭时释放语法与未完成计算。 */
export function requestHighlight(path: string, source: string, receive: (tokens: HighlightTokens) => void): () => void {
  const language = languageForPath(path)
  if (!language || source.length > MAX_HIGHLIGHT_SOURCE_CHARS) return () => {}
  const service = shared ?? createWorker()
  if (!service) return () => {}
  service.users++
  const id = ++nextId
  service.pending.set(id, receive)
  service.worker.postMessage({ type: 'highlight', id, source, language } satisfies HighlightRequest)
  return () => {
    if (service.pending.delete(id)) service.worker.postMessage({ type: 'cancel', id } satisfies HighlightRequest)
    if (--service.users === 0) dispose(service)
  }
}

function createWorker(): HighlightWorker | null {
  try {
    const worker = new Worker(new URL('./syntax-highlight.worker.ts', import.meta.url), { type: 'module' })
    const service: HighlightWorker = { worker, pending: new Map(), users: 0 }
    worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
      const { id, tokens } = event.data
      const receive = service.pending.get(id)
      service.pending.delete(id)
      if (tokens) receive?.(tokens)
    }
    worker.onerror = () => dispose(service)
    shared = service
    return service
  } catch { return null } // Worker 无法启动时仍保留可读的纯文本。
}

function dispose(service: HighlightWorker): void {
  service.worker.terminate()
  service.pending.clear()
  if (shared === service) shared = null
}

function languageForPath(path: string): HighlightLanguage | null {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const aliases: Record<string, HighlightLanguage> = {
    bash: 'bash',
    c: 'c',
    cpp: 'cpp',
    csharp: 'csharp',
    css: 'css',
    diff: 'diff',
    go: 'go',
    html: 'html',
    java: 'java',
    javascript: 'javascript',
    json: 'json',
    jsonc: 'jsonc',
    kotlin: 'kotlin',
    markdown: 'markdown',
    php: 'php',
    powershell: 'powershell',
    python: 'python',
    ruby: 'ruby',
    rust: 'rust',
    scss: 'scss',
    sql: 'sql',
    svelte: 'svelte',
    toml: 'toml',
    typescript: 'typescript',
    yaml: 'yaml',
    cjs: 'javascript',
    cs: 'csharp',
    cshtml: 'html',
    dockerfile: 'dockerfile',
    h: 'c',
    hpp: 'cpp',
    js: 'javascript',
    jsx: 'jsx',
    kt: 'kotlin',
    kts: 'kotlin',
    md: 'markdown',
    mjs: 'javascript',
    ps1: 'powershell',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'bash',
    ts: 'typescript',
    tsx: 'tsx',
    vue: 'vue',
    xml: 'xml',
    yml: 'yaml',
  }
  if (Object.hasOwn(aliases, name)) return aliases[name]!
  return Object.hasOwn(aliases, extension) ? aliases[extension]! : null
}
