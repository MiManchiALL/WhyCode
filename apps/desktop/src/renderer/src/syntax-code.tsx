import {
  startTransition,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { requestHighlight, type HighlightedLines } from './syntax-highlighting.ts'
import { renderCodeLines } from './syntax-code-html.ts'
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
  const markup = useMemo(
    () => ({ __html: renderCodeLines(lines, highlighted, focusLine) }),
    [lines, highlighted, focusLine],
  )
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
      {/* 内容只来自转义后的源码与内部高亮结果；不把 HTML 源文件当作页面执行。 */}
      <div
        className={`wc-code-lines ${wrap ? 'w-full' : 'min-w-max'} py-1 font-mono`}
        dangerouslySetInnerHTML={markup}
      />
    </div>
  )
}

function useHighlightedCode(path: string, source: string): HighlightedLines | null {
  const [result, setResult] = useState<HighlightedLines | null>(null)
  useEffect(() => {
    setResult(null)
    return requestHighlight(path, source, lines => {
      startTransition(() => setResult(lines))
    })
  }, [path, source])
  return result
}
