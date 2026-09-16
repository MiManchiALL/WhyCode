import {
  startTransition,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react'
import { requestHighlight, type HighlightTokens } from './syntax-highlighting.ts'
import type { FileDiffLine } from './file-change-presentation.ts'
import { useScrollArea } from './use-scroll-area.ts'

export function SyntaxCode({
  path,
  lines,
  focusLine = null,
  scroll = true,
  wrap = false,
  className = '',
}: {
  path: string
  lines: readonly FileDiffLine[]
  focusLine?: number | null
  scroll?: boolean
  wrap?: boolean
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
      data-wrap={wrap}
      onScroll={onScroll}
      style={{ overscrollBehaviorY }}
      className={`wc-code-scroll wc-scrollbar min-h-0 ${scroll ? 'overflow-auto' : 'overflow-visible'} ${className}`}
    >
      <div className={`wc-code-lines ${wrap ? 'w-full' : 'min-w-max'} py-1 font-mono text-xs leading-5`}>
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
              <code className={`block min-w-0 flex-1 pr-5 ${wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}>
                <HighlightedLine
                  tokens={highlighted?.[index]}
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
  tokens: HighlightTokens[number] | undefined
  fallback: string
}) {
  if (!tokens) return <>{fallback || ' '}</>
  return <>{tokens.map((token, index) => (
    <span key={`${token.offset}:${index}`} style={token.htmlStyle as CSSProperties}>
      {token.content}
    </span>
  ))}</>
}

function useHighlightedCode(path: string, source: string): HighlightTokens | null {
  const [result, setResult] = useState<HighlightTokens | null>(null)
  useEffect(() => {
    setResult(null)
    return requestHighlight(path, source, tokens => {
      startTransition(() => setResult(tokens))
    })
  }, [path, source])
  return result
}
