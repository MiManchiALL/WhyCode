import {
  createHighlighterCore,
  type LanguageRegistration,
  type TokensResult,
} from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import githubDark from 'shiki/themes/github-dark.mjs'
import githubLight from 'shiki/themes/github-light.mjs'
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react'
import type { FileDiffLine } from './file-change-presentation.ts'
import { useScrollArea } from './use-scroll-area.ts'

interface PooledHighlighter {
  promise: ReturnType<typeof createHighlighterCore>
  uses: number
  lastUsed: number
}

const MAX_IDLE_HIGHLIGHTERS = 6
const MAX_HIGHLIGHT_SOURCE_CHARS = 160_000
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

type HighlightLanguage = keyof typeof LANGUAGE_LOADERS

const highlighterPool = new Map<HighlightLanguage, PooledHighlighter>()

export function SyntaxCode({
  path,
  lines,
  focusLine = null,
  scroll = true,
  className = '',
}: {
  path: string
  lines: readonly FileDiffLine[]
  focusLine?: number | null
  scroll?: boolean
  className?: string
}) {
  const source = useMemo(() => lines.map((line) => line.text).join('\n'), [lines])
  const highlighted = useHighlightedCode(path, source)
  const { ref: scrollRef, onScroll, overscrollBehaviorY } = useScrollArea(lines, { enabled: scroll })

  useEffect(() => {
    if (focusLine === null) return
    const frame = window.requestAnimationFrame(() => {
      const container = scrollRef.current
      const row = container?.querySelector<HTMLElement>(`[data-focus-line="${focusLine}"]`)
      if (!container || !row) return
      const top = row.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop
      container.scrollTop = Math.max(0, top - container.clientHeight * 0.32)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusLine, lines])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{ overscrollBehaviorY }}
      className={`wc-code-scroll wc-scrollbar min-h-0 ${scroll ? 'overflow-auto' : 'overflow-visible'} ${className}`}
    >
      <div className="wc-code-lines min-w-max py-1 font-mono text-xs leading-5">
        {lines.length === 0 ? (
          <div className="px-3 py-6 text-center text-[var(--wc-faint)]">空文件</div>
        ) : lines.map((line, index) => {
          const displayLine = line.kind === 'removed' ? line.oldLine : line.newLine
          const focus = line.kind !== 'removed' && line.newLine === focusLine
          return (
            <div
              key={line.id}
              data-tone={line.kind}
              data-focus-line={focus ? String(focusLine) : undefined}
              className="wc-code-line flex min-w-full"
            >
              <span className="wc-code-line-number sticky left-0 w-14 shrink-0 select-none pr-3 text-right tabular-nums">
                {displayLine ?? ''}
              </span>
              <code className="block min-w-0 flex-1 whitespace-pre pr-5">
                <HighlightedLine
                  tokens={highlighted?.tokens[index]}
                  fallback={line.text}
                />
              </code>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HighlightedLine({
  tokens,
  fallback,
}: {
  tokens: TokensResult['tokens'][number] | undefined
  fallback: string
}) {
  if (!tokens) return <>{fallback || ' '}</>
  return <>{tokens.map((token, index) => (
    <span key={`${token.offset}:${index}`} style={token.htmlStyle as CSSProperties}>
      {token.content}
    </span>
  ))}</>
}

function useHighlightedCode(path: string, source: string): TokensResult | null {
  const [result, setResult] = useState<TokensResult | null>(null)
  useEffect(() => {
    let active = true
    setResult(null)
    const language = languageForPath(path)
    if (!language || source.length > MAX_HIGHLIGHT_SOURCE_CHARS) {
      return () => { active = false }
    }
    void highlightSource(source, language).then((next) => {
      if (active) setResult(next)
    }).catch(() => {
      // 未知语法或高亮器加载失败时保留即时纯文本，不阻塞文件阅读。
    })
    return () => { active = false }
  }, [path, source])
  return result
}

async function highlightSource(
  source: string,
  language: HighlightLanguage,
): Promise<TokensResult> {
  const entry = acquireHighlighter(language)
  try {
    const highlighter = await entry.promise
    return highlighter.codeToTokens(source, {
      lang: language,
      themes: { light: 'github-light', dark: 'github-dark' },
    })
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

function languageForPath(path: string): HighlightLanguage | null {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const aliases: Record<string, string> = {
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
  const candidate = aliases[name] ?? aliases[extension] ?? extension
  if (candidate in LANGUAGE_LOADERS) return candidate as HighlightLanguage
  return null
}
