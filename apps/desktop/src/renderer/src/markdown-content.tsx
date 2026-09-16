import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { SourceIcon } from './source-capsules.tsx'
import { Streamdown, type Components } from 'streamdown'
import { MarkdownAnchor, MarkdownUnorderedList } from './markdown-elements.ts'
import {
  markdownPluginsFor,
  markdownRemarkPlugins,
  normalizeMathDelimiters,
} from './markdown-rendering.ts'
import {
  findSourceCapsule,
  isInlineSourceLabel,
  normalizeSourceUrl,
  sourceKindForUrl,
} from './markdown-sources.ts'

const MARKDOWN_CONTROLS = { table: { fullscreen: false } } as const
const LINK_SAFETY = { enabled: false } as const

export const MarkdownContent = memo(function MarkdownContent({
  text,
  streaming = false,
  renderMath,
}: {
  text: string
  streaming?: boolean
  renderMath?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const highlightedRef = useRef<HTMLElement | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const staticReady = useDeferredStaticMarkdown(streaming)
  const effectiveStreaming = streaming || !staticReady
  const mathEnabled = !effectiveStreaming && (renderMath ?? true)
  const renderedText = useMemo(
    () => mathEnabled ? normalizeMathDelimiters(text) : text,
    [mathEnabled, text],
  )

  const clearHighlight = useCallback(() => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = null
    highlightedRef.current?.classList.remove('wc-source-highlight')
    highlightedRef.current = null
  }, [])

  useEffect(() => clearHighlight, [clearHighlight])

  const revealSource = useCallback((url: string): boolean => {
    const target = rootRef.current ? findSourceCapsule(rootRef.current, url) : null
    if (!target) return false
    clearHighlight()
    target.classList.add('wc-source-highlight')
    highlightedRef.current = target
    highlightTimerRef.current = setTimeout(clearHighlight, 3_000)
    target.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'end',
    })
    return true
  }, [clearHighlight])

  const components = useMemo<Components>(() => ({
    ul: ({ node, className, children, ...props }) => {
      return <MarkdownUnorderedList {...props} node={node} className={className}>{children}</MarkdownUnorderedList>
    },
    a: ({ node: _node, children, className, href, onClick, ...props }) => {
      const sourceUrl = normalizeSourceUrl(href)
      const inlineSource = Boolean(sourceUrl && isInlineSourceLabel(textFromChildren(children)))
      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event)
        if (event.defaultPrevented || !inlineSource || !sourceUrl) return
        // “[来源]”是回答内导航，不在来源尚未渲染或模型漏列时意外打开网页。
        event.preventDefault()
        revealSource(sourceUrl)
      }
      return (
        <MarkdownAnchor
          {...props}
          node={_node}
          href={href}
          className={className}
          inlineSource={inlineSource}
          {...(sourceUrl
            ? {
                'data-source-url': sourceUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
              }
            : {})}
          onClick={handleClick}
          title={inlineSource ? '跳转到回答末尾的对应来源' : undefined}
        >
          {sourceUrl ? <SourceIcon kind={sourceKindForUrl(sourceUrl)} /> : null}
          <span className={inlineSource ? 'sr-only' : 'wc-source-label'}>{children}</span>
        </MarkdownAnchor>
      )
    },
  }), [revealSource])

  return (
    <div ref={rootRef} className="wc-markdown">
      <Streamdown
        className="wc-markdown-content"
        mode={effectiveStreaming ? 'streaming' : 'static'}
        controls={MARKDOWN_CONTROLS}
        components={components}
        linkSafety={LINK_SAFETY}
        plugins={markdownPluginsFor(mathEnabled)}
        remarkPlugins={effectiveStreaming ? undefined : markdownRemarkPlugins()}
      >
        {renderedText}
      </Streamdown>
    </div>
  )
})

/**
 * 最终事件先提交轻量的运行态收尾；完整 Markdown/TeX 在浏览器空闲阶段升级。
 * 历史静态正文首次打开仍直接渲染，不引入二次闪烁。
 */
function useDeferredStaticMarkdown(streaming: boolean): boolean {
  const [ready, setReady] = useState(!streaming)
  useEffect(() => {
    if (streaming) {
      setReady(false)
      return
    }
    if (ready) return
    const commit = () => startTransition(() => setReady(true))
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(commit, { timeout: 250 })
      return () => window.cancelIdleCallback(id)
    }
    const id = window.setTimeout(commit, 0)
    return () => window.clearTimeout(id)
  }, [ready, streaming])
  return ready
}

function textFromChildren(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (!Array.isArray(children)) return ''
  return children.map(textFromChildren).join('')
}
