import { createHighlighterCore, stringifyTokenStyle } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import githubDark from 'shiki/themes/github-dark.mjs'
import githubLight from 'shiki/themes/github-light.mjs'
import { LANGUAGE_LOADERS, type HighlightLanguage } from './syntax-highlight-languages.ts'
import { escapeCodeHtml } from './syntax-code-html.ts'
import type { HighlightRequest, HighlightResponse } from './syntax-highlighting.ts'

interface PooledHighlighter {
  promise: ReturnType<typeof createHighlighterCore>
  uses: number
  lastUsed: number
}

const MAX_IDLE_HIGHLIGHTERS = 6

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
