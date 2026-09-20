import {
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
} from 'react'
import { SourceIcon } from './source-capsules.tsx'
import { Streamdown, type Components } from 'streamdown'
import { MarkdownAnchor, MarkdownUnorderedList } from './markdown-elements.ts'
import { MarkdownTable } from './markdown-table.tsx'
import { ResponseSourcesContext } from './response-presentation.ts'
import { normalizeSourceUrl, WEB_SOURCE_CITATION_MARKER } from '@whycode/core/web-source'
import {
  markdownPluginsFor,
  markdownRemarkPlugins,
  MARKDOWN_REHYPE_PLUGINS,
  normalizeMathDelimiters,
} from './markdown-rendering.ts'
import {
  findSourceCapsule,
  sourceKindForUrl,
} from './markdown-sources.ts'

const MARKDOWN_CONTROLS = { table: false } as const
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
  const response = useContext(ResponseSourcesContext)
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

  useEffect(() => clearHighlight, [clearHighlight, response])

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
    table: MarkdownTable,
    ul: ({ node, className, children, ...props }) => {
      return <MarkdownUnorderedList {...props} node={node} className={className}>{children}</MarkdownUnorderedList>
    },
    a: (props) => <MarkdownLink {...props} onSourceClick={revealSource} />,
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
        remarkPlugins={markdownRemarkPlugins(effectiveStreaming)}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      >
        {renderedText}
      </Streamdown>
    </div>
  )
})

/** 链接直接订阅回答投影，流式块缓存也能在正常完成时切换到引用展示。 */
function MarkdownLink({ children, href, onClick, onSourceClick, 'data-source-citation-url': citationUrl, ...props }:
  ComponentProps<typeof MarkdownAnchor> & { onSourceClick: (url: string) => void; 'data-source-citation-url'?: string }) {
  const response = useContext(ResponseSourcesContext)
  const sourceUrl = normalizeSourceUrl(href)
  const source = citationUrl ? response?.sources.find(source => source.url === citationUrl) : undefined
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || !source || !sourceUrl) return
    event.preventDefault()
    onSourceClick(sourceUrl)
  }
  return <MarkdownAnchor
    {...props}
    href={href}
    inlineSource={!!source}
    {...(sourceUrl ? { 'data-source-url': sourceUrl, target: '_blank', rel: 'noreferrer noopener' } : {})}
    onClick={handleClick}
    title={source ? `跳转到来源：${source.title}` : props.title === WEB_SOURCE_CITATION_MARKER ? undefined : props.title}
  >
    {source ? <>
      <SourceIcon kind={sourceKindForUrl(source.url)} />
      <span className="sr-only">来源：{source.title}</span>
    </> : children}
  </MarkdownAnchor>
}

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
