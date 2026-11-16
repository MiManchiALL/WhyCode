import type { HighlightLanguage } from './syntax-highlight-languages.ts'

/** 高亮 Worker 生成的已转义行内标记，不包含原始文件 HTML。 */
export type HighlightedLines = string[]
export type HighlightRequest = { type: 'highlight'; id: number; source: string; language: HighlightLanguage }
  | { type: 'cancel'; id: number }
export interface HighlightResponse { id: number; lines: HighlightedLines | null }
interface HighlightWorker {
  worker: Worker
  pending: Map<number, (lines: HighlightedLines) => void>
  users: number
}

const MAX_HIGHLIGHT_SOURCE_CHARS = 160_000
let shared: HighlightWorker | null = null
let nextId = 0

/** 可见代码视图共享 Worker；最后一个视图关闭时释放语法与未完成计算。 */
export function requestHighlight(path: string, source: string, receive: (lines: HighlightedLines) => void): () => void {
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
      const { id, lines } = event.data
      const receive = service.pending.get(id)
      service.pending.delete(id)
      if (lines) receive?.(lines)
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

const LANGUAGE_ALIASES: Record<HighlightLanguage, string[]> = {
  asciidoc: ['adoc'],
  bash: ['sh', 'shell', 'shellscript', 'zsh'],
  bat: ['batch', 'cmd'],
  bibtex: ['bib'],
  c: ['h'],
  clojure: ['clj', 'cljc', 'cljs', 'edn'],
  cmake: ['cmakelists.txt'],
  cpp: ['c++', 'cc', 'cxx', 'hh', 'hpp', 'hxx'],
  csharp: ['c#', 'cs'],
  css: [],
  csv: [],
  dart: [],
  diff: ['patch'],
  dockerfile: [],
  dotenv: ['env'],
  elixir: ['ex', 'exs'],
  erlang: ['erl', 'hrl'],
  fish: [],
  fsharp: ['f#', 'fs', 'fsi', 'fsx'],
  go: [],
  graphql: ['gql'],
  groovy: ['gradle'],
  haskell: ['hs'],
  hcl: ['terraform', 'tf', 'tfvars'],
  html: ['htm', 'xhtml', 'cshtml'],
  http: [],
  ini: ['cfg', 'conf', 'properties'],
  java: [],
  javascript: ['js', 'cjs', 'mjs'],
  json: ['ipynb', 'jsonl', 'ndjson'],
  jsonc: [],
  jsx: [],
  julia: ['jl'],
  kotlin: ['kt', 'kts'],
  latex: ['tex', 'sty', 'cls'],
  less: [],
  log: [],
  lua: [],
  make: ['makefile', 'gnumakefile', 'mk'],
  markdown: ['md'],
  mdx: [],
  nix: [],
  perl: ['pl', 'pm'],
  php: [],
  powershell: ['ps1', 'psd1', 'psm1', 'pwsh'],
  proto: ['protobuf'],
  python: ['py', 'pyi', 'pyw'],
  r: [],
  rst: ['restructuredtext'],
  ruby: ['rb', 'rake', 'gemspec'],
  rust: ['rs'],
  scala: ['sc'],
  scss: [],
  sql: [],
  svelte: [],
  swift: [],
  'system-verilog': ['systemverilog', 'sv', 'svh'],
  toml: [],
  tsx: [],
  typescript: ['ts', 'cts', 'mts'],
  vb: ['vbnet'],
  verilog: ['v', 'vh'],
  vue: [],
  xml: ['plist', 'svg', 'xsd', 'xsl', 'xslt'],
  yaml: ['yml'],
}

const languagesByName = new Map<string, HighlightLanguage>()
for (const language of Object.keys(LANGUAGE_ALIASES) as HighlightLanguage[]) {
  languagesByName.set(language, language)
  for (const alias of LANGUAGE_ALIASES[language]) languagesByName.set(alias, language)
}

function languageForPath(path: string): HighlightLanguage | null {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  if (name.startsWith('.env.')) return 'dotenv'
  return languagesByName.get(name) ?? languagesByName.get(name.slice(name.lastIndexOf('.') + 1)) ?? null
}
