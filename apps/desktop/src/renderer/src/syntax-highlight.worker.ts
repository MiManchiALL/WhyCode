import {
  createHighlighterCore,
  type LanguageRegistration,
} from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import githubDark from 'shiki/themes/github-dark.mjs'
import githubLight from 'shiki/themes/github-light.mjs'
import type { HighlightRequest, HighlightResponse } from './syntax-highlighting.ts'

interface PooledHighlighter {
  promise: ReturnType<typeof createHighlighterCore>
  uses: number
  lastUsed: number
}

const MAX_IDLE_HIGHLIGHTERS = 6
const LANGUAGE_LOADERS = {
  bash: () => import('shiki/langs/bash.mjs').then(module => module.default),
  c: () => import('shiki/langs/c.mjs').then(module => module.default),
  cpp: () => import('shiki/langs/cpp.mjs').then(module => module.default),
  csharp: () => import('shiki/langs/csharp.mjs').then(module => module.default),
  css: () => import('shiki/langs/css.mjs').then(module => module.default),
  diff: () => import('shiki/langs/diff.mjs').then(module => module.default),
  dockerfile: () => import('shiki/langs/dockerfile.mjs').then(module => module.default),
  go: () => import('shiki/langs/go.mjs').then(module => module.default),
  html: () => import('shiki/langs/html.mjs').then(module => module.default),
  java: () => import('shiki/langs/java.mjs').then(module => module.default),
  javascript: () => import('shiki/langs/javascript.mjs').then(module => module.default),
  json: () => import('shiki/langs/json.mjs').then(module => module.default),
  jsonc: () => import('shiki/langs/jsonc.mjs').then(module => module.default),
  jsx: () => import('shiki/langs/jsx.mjs').then(module => module.default),
  kotlin: () => import('shiki/langs/kotlin.mjs').then(module => module.default),
  markdown: () => import('shiki/langs/markdown.mjs').then(module => module.default),
  php: () => import('shiki/langs/php.mjs').then(module => module.default),
  powershell: () => import('shiki/langs/powershell.mjs').then(module => module.default),
  python: () => import('shiki/langs/python.mjs').then(module => module.default),
  ruby: () => import('shiki/langs/ruby.mjs').then(module => module.default),
  rust: () => import('shiki/langs/rust.mjs').then(module => module.default),
  scss: () => import('shiki/langs/scss.mjs').then(module => module.default),
  sql: () => import('shiki/langs/sql.mjs').then(module => module.default),
  svelte: () => import('shiki/langs/svelte.mjs').then(module => module.default),
  toml: () => import('shiki/langs/toml.mjs').then(module => module.default),
  tsx: () => import('shiki/langs/tsx.mjs').then(module => module.default),
  typescript: () => import('shiki/langs/typescript.mjs').then(module => module.default),
  vue: () => import('shiki/langs/vue.mjs').then(module => module.default),
  xml: () => import('shiki/langs/xml.mjs').then(module => module.default),
  yaml: () => import('shiki/langs/yaml.mjs').then(module => module.default),
} satisfies Record<string, () => Promise<LanguageRegistration[]>>

export type HighlightLanguage = keyof typeof LANGUAGE_LOADERS

const highlighterPool = new Map<HighlightLanguage, PooledHighlighter>()

const pending = new Set<number>()
self.onmessage = (event: MessageEvent<HighlightRequest>) => {
  const request = event.data
  if (request.type === 'cancel') { pending.delete(request.id); return }
  pending.add(request.id)
  void highlightSource(request.source, request.language, request.id).catch(() => {
    self.postMessage({ id: request.id, tokens: null } satisfies HighlightResponse)
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
    })
    // 语法状态包含引擎对象，跨线程只传递显示所需的 token 字段。
    const result: HighlightResponse = { id, tokens: tokens.map(line => line.map(token => ({
      content: token.content, offset: token.offset, htmlStyle: token.htmlStyle,
    }))) }
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
      promise: LANGUAGE_LOADERS[language]().then((registrations) => createHighlighterCore({
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
