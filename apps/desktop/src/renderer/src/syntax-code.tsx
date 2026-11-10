import {
  startTransition,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { requestHighlight, type HighlightedLines } from './syntax-highlighting.ts'
import { renderCodeLines } from './syntax-code-html.ts'
import type { FileDiffLine } from './file-change-presentation.ts'
import { useScrollArea } from './use-scroll-area.ts'
import type { FileLineLocation } from './right-panel-state.ts'
import { CodeReviewContext, CodeReviewControls } from './code-review.tsx'
import { codeExcerpt, readCodeRange, selectCodeRange } from './code-selection.ts'

export function SyntaxCode({
  path,
  lines,
  location,
  onLocated,
  diff = false,
  scroll = true,
  wrap = false,
  className = '',
}: {
  path: string
  lines: readonly FileDiffLine[]
  location?: FileLineLocation
  onLocated?: () => void
  diff?: boolean
  scroll?: boolean
  wrap?: boolean
  className?: string
}) {
  const source = useMemo(() => lines.map((line) => line.text).join('\n'), [lines])
  const highlighted = useHighlightedCode(path, source)
  const body = useRef<HTMLDivElement>(null)
  const previousLines = useRef<readonly FileDiffLine[]>(undefined)
  const review = useContext(CodeReviewContext)
  const { ref: scrollRef, onScroll, overscrollBehaviorY } = useScrollArea(lines, { enabled: scroll })

  useLayoutEffect(() => {
    const root = body.current!
    // Worker 着色会替换文本节点。仅恢复替换前仍存在的原生选区，保留拖选方向。
    const selection = previousLines.current === lines ? readCodeRange(root) : null
    previousLines.current = lines
    root.innerHTML = renderCodeLines(lines, highlighted)
    if (selection) selectCodeRange(root, selection)
  }, [lines, highlighted])

  useLayoutEffect(() => {
    if (!location) return
    const root = body.current!, container = scrollRef.current!
    const start = location.line - 1
    const last = Math.min(location.endLine ?? location.line, lines.length) - 1
    const row = root.querySelector<HTMLElement>(`[data-code-row="${start}"]`)
    if (row && last >= start) {
      container.focus({ preventScroll: true })
      selectCodeRange(root, { start: { row: start, offset: 0 }, end: { row: last, offset: lines[last]!.text.length || 1 }, backward: false })
      const top = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTop = Math.max(0, top - container.clientHeight * 0.32)
    }
    onLocated?.()
  }, [location, lines, onLocated, scrollRef])

  return (
    <div
      ref={scrollRef}
      tabIndex={-1}
      data-code-review={review ? true : undefined}
      data-wrap={wrap}
      onScroll={onScroll}
      onCopy={event => {
        if (!review) return
        const range = body.current && readCodeRange(body.current)
        const excerpt = range && codeExcerpt(lines, range, diff)
        if (excerpt) { event.preventDefault(); event.clipboardData.setData('text/plain', excerpt.text) }
      }}
      style={{ overscrollBehaviorY }}
      className={`wc-code-scroll wc-scrollbar relative min-h-0 ${scroll ? 'overflow-auto' : 'overflow-visible'} ${className}`}
    >
      <div ref={body} className={`wc-code-lines ${wrap ? 'w-full' : 'min-w-max'} py-1 font-mono`} />
      {review && <CodeReviewControls review={review} path={path} lines={lines} diff={diff} body={body} highlighted={highlighted} />}
    </div>
  )
}

export function useHighlightedCode(path: string, source: string, enabled = true): HighlightedLines | null {
  const [result, setResult] = useState<{ path: string; source: string; lines: HighlightedLines } | null>(null)
  useEffect(() => {
    setResult(null)
    if (!enabled) return
    return requestHighlight(path, source, lines => {
      startTransition(() => setResult({ path, source, lines }))
    })
  }, [path, source, enabled])
  return enabled && result?.path === path && result.source === source ? result.lines : null
}
