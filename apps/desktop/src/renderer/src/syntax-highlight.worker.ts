import {
  createHighlighterCore,
  stringifyTokenStyle,
  type LanguageRegistration,
} from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import githubDark from 'shiki/themes/github-dark.mjs'
import githubLight from 'shiki/themes/github-light.mjs'
import { escapeCodeHtml } from './syntax-code-html.ts'
import type { HighlightRequest, HighlightResponse } from './syntax-highlighting.ts'

interface PooledHighlighter {
  promise: ReturnType<typeof createHighlighterCore>
  uses: number
  lastUsed: number
}

const MAX_IDLE_HIGHLIGHTERS = 6
const LANGUAGE_LOADERS = {
  asciidoc: () => import('shiki/langs/asciidoc.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  bibtex: () => import('shiki/langs/bibtex.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  clojure: () => import('shiki/langs/clojure.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  csv: () => import('shiki/langs/csv.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  erlang: () => import('shiki/langs/erlang.mjs'),
  fish: () => import('shiki/langs/fish.mjs'),
  fsharp: () => import('shiki/langs/fsharp.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  http: () => import('shiki/langs/http.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  julia: () => import('shiki/langs/julia.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  log: () => import('shiki/langs/log.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  nix: () => import('shiki/langs/nix.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  rst: () => import('shiki/langs/rst.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  'system-verilog': () => import('shiki/langs/system-verilog.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vb: () => import('shiki/langs/vb.mjs'),
  verilog: () => import('shiki/langs/verilog.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
} satisfies Record<string, () => Promise<{ default: LanguageRegistration[] }>>

export type HighlightLanguage = keyof typeof LANGUAGE_LOADERS

const highlighterPool = new Map<HighlightLanguage, PooledHighlighter>()

const pending = new Set<number>()
self.onmessage = (event: MessageEvent<HighlightRequest>) => {
  const request = event.data
  if (request.type === 'cancel') { pending.delete(request.id); return }
  pending.add(request.id)
  void highlightSource(request.source, request.language, request.id).catch(() => {
    self.postMessage({ id: request.id, lines: null } satisfies HighlightResponse)
  }).finally(() => pending.delete(request.id))
}

async function highlightSource(
  source: string,
  language: HighlightLanguage,
  id: number,
): Promise<void> {
  const entry = acquireHighlighter(language)
  try {
    const highlighter = await entry.promise
    if (!pending.has(id)) return
    const { tokens } = highlighter.codeToTokens(source, {
      lang: language,
      themes: { light: 'github-light', dark: 'github-dark' },
      tokenizeMaxLineLength: 2_000,
    })
    // 静态片段在线程内转义、序列化，避免主线程复制 token 对象并创建逐 token 的 React 树。
    const result: HighlightResponse = { id, lines: tokens.map(line => line.map(token =>
      `<span style="${escapeCodeHtml(stringifyTokenStyle(token.htmlStyle ?? {}))}">${escapeCodeHtml(token.content)}</span>`,
    ).join('')) }
    self.postMessage(result)
  } finally {
    entry.uses--
    entry.lastUsed = performance.now()
    trimHighlighterPool()
  }
}

function acquireHighlighter(language: HighlightLanguage): PooledHighlighter {
  let entry = highlighterPool.get(language)
  if (!entry) {
    entry = {
      promise: LANGUAGE_LOADERS[language]().then(({ default: registrations }) => createHighlighterCore({
        langs: registrations,
        themes: [githubLight, githubDark],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      })),
      uses: 0,
      lastUsed: performance.now(),
    }
    highlighterPool.set(language, entry)
    void entry.promise.catch(() => {
      if (highlighterPool.get(language) === entry) highlighterPool.delete(language)
    })
  }
  entry.uses++
  entry.lastUsed = performance.now()
  return entry
}

function trimHighlighterPool(): void {
  if (highlighterPool.size <= MAX_IDLE_HIGHLIGHTERS) return
  const idle = [...highlighterPool.entries()]
    .filter(([, entry]) => entry.uses === 0)
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
  while (highlighterPool.size > MAX_IDLE_HIGHLIGHTERS) {
    const oldest = idle.shift()
    if (!oldest) return
    const [language, entry] = oldest
    if (!highlighterPool.delete(language)) continue
    void entry.promise.then((highlighter) => highlighter.dispose()).catch(() => {})
  }
}
