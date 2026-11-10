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
import { codeRowAt, renderCodeLines } from './syntax-code-html.ts'
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
  const [focused, setFocused] = useState<FileLineLocation | null>(null)
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

  useLayoutEffect(() => setFocused(null), [lines])

  useLayoutEffect(() => {
    if (!focused) return
    const root = body.current!
    const mark = (active: boolean) => {
      for (let row = focused.line - 1; row < (focused.endLine ?? focused.line); row++) {
        codeRowAt(root, row)?.toggleAttribute('data-line-focus', active)
      }
    }
    mark(true)
    return () => mark(false)
  }, [focused, highlighted, lines])

  useEffect(() => {
    if (!focused) return
    const root = body.current!
    const doc = root.ownerDocument
    const selecting = () => {
      const selection = doc.getSelection()
      if (selection && !selection.isCollapsed && root.contains(selection.anchorNode)) setFocused(null)
    }
    doc.addEventListener('selectionchange', selecting)
    return () => doc.removeEventListener('selectionchange', selecting)
  }, [focused])

  useLayoutEffect(() => {
    if (!location) return
    const root = body.current!, container = scrollRef.current!
    const row = codeRowAt(root, location.line - 1)
    if (row) {
      container.focus({ preventScroll: true })
      root.ownerDocument.getSelection()?.removeAllRanges()
      setFocused({ line: location.line, endLine: Math.min(location.endLine ?? location.line, lines.length) })
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
      onPointerDown={event => {
        if (!review || event.button !== 0 || !(event.target instanceof Element) || event.target.closest('button')) return
        const row = event.target.closest<HTMLElement>('[data-code-row]')
        if (row && body.current?.contains(row)) {
          event.currentTarget.focus({ preventScroll: true })
          setFocused({ line: Number(row.dataset.codeRow) + 1 })
        }
      }}
      onBlur={event => { if (event.target === event.currentTarget) setFocused(null) }}
      onScroll={onScroll}
      onCopy={event => {
        if (!review) return
        const range = body.current && readCodeRange(body.current)
        const text = range ? codeExcerpt(lines, range, diff)?.text
          : focused && lines.slice(focused.line - 1, focused.endLine ?? focused.line).map(row => row.text).join('\n')
        if (text != null) { event.preventDefault(); event.clipboardData.setData('text/plain', text) }
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
