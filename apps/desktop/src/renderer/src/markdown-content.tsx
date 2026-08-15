import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type ReactNode,
} from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Copy, ExternalLink, FileText, GitBranch, Globe2 } from 'lucide-react'
import { Streamdown, type Components } from 'streamdown'
import {
  markdownPluginsFor,
  normalizeDisplayMathFences,
} from './markdown-rendering.ts'
import {
  externalSourcesFromList,
  findSourceCapsule,
  isInlineSourceLabel,
  normalizeSourceUrl,
  sourceKindForUrl,
  type MarkdownSource,
  type SourceKind,
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
  const mathEnabled = renderMath ?? !streaming
  const renderedText = useMemo(
    () => mathEnabled ? normalizeDisplayMathFences(text) : text,
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
      const sources = externalSourcesFromList(node)
      if (!sources) return <ul {...props} className={className}>{children}</ul>
      return (
        <div className="wc-source-list" role="list" aria-label="来源">
          {sources.map((source, index) => (
            <div className="wc-source-item" role="listitem" key={`${source.url}:${index}`}>
              <SourceCapsule source={source} />
            </div>
          ))}
        </div>
      )
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
        <a
          {...props}
          href={href}
          className={joinClasses(className, inlineSource && 'wc-inline-source')}
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
        </a>
      )
    },
  }), [revealSource])

  return (
    <div ref={rootRef} className="wc-markdown">
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        controls={MARKDOWN_CONTROLS}
        components={components}
        linkSafety={LINK_SAFETY}
        plugins={markdownPluginsFor(mathEnabled)}
      >
        {renderedText}
      </Streamdown>
    </div>
  )
})

function SourceIcon({ kind }: { kind: SourceKind }) {
  const Icon = kind === 'git' ? GitBranch : kind === 'document' ? FileText : Globe2
  return <Icon className="wc-source-link-icon" aria-hidden="true" />
}

function SourceCapsule({ source }: { source: MarkdownSource }) {
  const copyLink = () => {
    void navigator.clipboard.writeText(source.url).catch(() => undefined)
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="wc-source-capsule"
          data-source-capsule-url={source.url}
          aria-label={`查看来源：${source.title}`}
        >
          <SourceIcon kind={source.kind} />
          <span className="wc-source-label">{source.title}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="wc-menu-content wc-source-menu-content"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <DropdownMenu.Label className="wc-source-menu-heading">
            <span className="wc-source-menu-icon" aria-hidden="true">
              <SourceIcon kind={source.kind} />
            </span>
            <span className="wc-source-menu-summary">
              <span className="wc-source-menu-title">{source.title}</span>
              <span className="wc-source-menu-domain">{source.domain}</span>
            </span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="wc-source-menu-separator" />
          <DropdownMenu.Item asChild className="wc-menu-item">
            <a href={source.url} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={14} aria-hidden="true" />
              打开来源
            </a>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="wc-menu-item" onSelect={copyLink}>
            <Copy size={14} aria-hidden="true" />
            复制链接
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function textFromChildren(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (!Array.isArray(children)) return ''
  return children.map(textFromChildren).join('')
}

function joinClasses(...values: Array<string | false | undefined>): string | undefined {
  const value = values.filter(Boolean).join(' ')
  return value || undefined
}
