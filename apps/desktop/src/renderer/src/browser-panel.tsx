import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowLeftRight, Copy, ExternalLink, Globe, LoaderCircle, MoreHorizontal, Plus, Minus, RefreshCw, Search, X, MousePointer2 } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { WebviewTag } from 'electron'
import { browserShortcut, isExternalBrowserUrl, type BrowserLease, type BrowserShortcut } from '../../shared/browser.ts'
import { BROWSER_VIEWPORT } from '../../shared/browser-agent.ts'
import type { RightPanelPage } from './right-panel-state.ts'
import { useBrowserPage } from './use-browser-page.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'
import { useBrowserReference } from './use-browser-reference.ts'
import { BrowserReferenceEditor } from './browser-reference-editor.tsx'
import type { BrowserReferenceImage } from '../../shared/browser-reference.ts'
import type { ImageDraft } from './image-draft.ts'
import { useRefreshFeedback } from './use-refresh-feedback.ts'

type BrowserPage = Extract<RightPanelPage, { kind: 'browser' }>
interface Props {
  page: BrowserPage; active: boolean
  lease: BrowserLease; navigationRevision: number; agent: boolean
  switchView?: () => void
  onNavigate: (url: string) => void
  runtimeId: string
  canReference: boolean
  onReference: (image: BrowserReferenceImage, replaceId?: string) => boolean
  referenceDrafts: readonly ImageDraft[]
  onChange: (url: string, title: string) => void
  onReferenceHandled: () => void
  onOpen: (url: string) => void
  onClose: () => void
}

export function BrowserPanel({ page, active, lease, navigationRevision, agent, switchView, onNavigate, runtimeId, canReference, onReference, referenceDrafts, onChange, onReferenceHandled, onOpen, onClose }: Props) {
  const addressRef = useRef<HTMLInputElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const [address, setAddress] = useState(page.url === 'about:blank' ? '' : page.url)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const feedback = useConversationFeedback()
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const browser = useBrowserPage({ active, lease, navigationRevision, url: page.url,
    workspaceRuntimeId: page.workspaceFile ? runtimeId : undefined,
    onNavigate: (url, title) => { if (url !== page.url || title !== page.title) onChange(url, title) },
    onOpen, onShortcut: command => { if (active) shortcut(command) },
  })
  const reference = useBrowserReference({ leaseId: browser.lease?.id, pageId: page.id, active, drafts: referenceDrafts,
    available: canReference && browser.state.ready && !browser.state.error && browser.state.url !== 'about:blank',
    url: browser.state.url, loading: browser.state.loading, request: page.referenceRequest,
    onRequestHandled: onReferenceHandled, onAdd: onReference,
    focusPage: () => browser.element.current?.focus() })
  const { state } = browser
  const refresh = useRefreshFeedback(state.loading)
  useEffect(() => {
    if (document.activeElement !== addressRef.current) setAddress(state.url === 'about:blank' ? '' : state.url)
  }, [state.url])
  useEffect(() => {
    if (finding && state.ready && !state.loading) browser.find(query)
  }, [finding, state.url, state.ready, state.loading])
  useEffect(() => {
    if (!active) return
    if (finding) findRef.current?.focus()
    else if (state.ready && state.url === 'about:blank' && page.url === 'about:blank') addressRef.current?.focus()
  }, [active, finding, state.ready])
  const shortcut = (command: BrowserShortcut) => {
    switch (command) {
      case 'address': addressRef.current?.focus(); addressRef.current?.select(); break
      case 'find': setFinding(true); findRef.current?.focus(); findRef.current?.select(); break
      case 'new-tab': onOpen('about:blank'); break
      case 'close-tab': onClose(); break
      case 'reload':
      case 'reload-clean':
        if (state.ready) void refresh.run(() => { if (agent) onNavigate(state.url); else browser.reload(command === 'reload-clean') })
        break
      case 'back': if (!agent) browser.run(view => { if (view.canGoBack()) view.goBack() }); break
      case 'forward': if (!agent) browser.run(view => { if (view.canGoForward()) view.goForward() }); break
      case 'zoom-in': if (!agent) browser.zoom(state.zoom + 0.1); break
      case 'zoom-out': if (!agent) browser.zoom(state.zoom - 0.1); break
      case 'zoom-reset': if (!agent) browser.zoom(1); break
      case 'escape':
        if (reference.mode !== 'off') reference.escape()
        else if (finding) { setFinding(false); browser.find(''); browser.element.current?.focus() }
        else if (state.loading && !agent) browser.run(view => view.stop())
        else { setAddress(state.url === 'about:blank' ? '' : state.url); browser.element.current?.focus() }
        break
    }
  }
  const copy = () => { void navigator.clipboard.writeText(state.url).then(() => feedback('success', '已复制网址'), error => feedback('error', String(error))) }
  const nextMatch = (forward: boolean) => browser.find(query, forward, true)
  return <section aria-label={agent ? 'Agent 浏览器' : '内置浏览器'} data-agent={agent} className="wc-browser-panel flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wc-surface)]"
    onKeyDown={event => {
      if (event.defaultPrevented) return
      const command = browserShortcut({ key: event.key, control: event.ctrlKey, meta: event.metaKey,
        alt: event.altKey, shift: event.shiftKey, isComposing: event.nativeEvent.isComposing })
      if (command) { event.preventDefault(); event.stopPropagation(); shortcut(command) }
    }}>
    <div className="flex min-w-0 shrink-0 items-center gap-0.5 border-b border-[var(--wc-line)] px-2 py-2">
      <button className="wc-preview-action" title="后退 (Alt+←)" aria-label="后退" disabled={agent || !state.ready || !state.back} onClick={() => shortcut('back')}><ArrowLeft size={15} /></button>
      <button className="wc-preview-action" title="前进 (Alt+→)" aria-label="前进" disabled={agent || !state.ready || !state.forward} onClick={() => shortcut('forward')}><ArrowRight size={15} /></button>
      <button className="wc-preview-action" title={state.loading && !agent ? '停止加载' : '刷新 (Ctrl+R)'} aria-label={state.loading && !agent ? '停止加载' : '刷新网页'}
        disabled={!state.ready || ((agent || !state.loading) && refresh.busy)} aria-busy={refresh.busy}
        onClick={() => state.loading && !agent ? browser.run(view => view.stop()) : shortcut('reload')}>
        {state.loading && !agent ? <X size={15} /> : <RefreshCw size={15} className={refresh.busy ? 'animate-spin' : ''} />}
      </button>
      <form className="mx-1 flex min-w-0 flex-1 items-center rounded-lg bg-black/[0.035] px-2 focus-within:ring-1 focus-within:ring-[var(--wc-line)]"
        onSubmit={event => { event.preventDefault(); if (agent) onNavigate(address); else browser.navigate(address); browser.element.current?.focus() }}>
        <span className="mr-1.5 shrink-0 text-[var(--wc-faint)]" role="status" aria-label={state.loading ? '正在加载网页' : '网页'}>
          {state.loading ? <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" /> : <Globe size={13} />}
        </span>
        <input ref={addressRef} value={address} onChange={event => setAddress(event.target.value)} onFocus={event => event.target.select()}
          className="h-8 min-w-0 flex-1 bg-transparent text-xs text-[var(--wc-ink)] outline-none placeholder:text-[var(--wc-faint)]"
          aria-label="网址或搜索" placeholder="输入网址或搜索" spellCheck={false} autoCapitalize="off" autoCorrect="off"
          onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} />
      </form>
      {switchView && <button className="wc-preview-action wc-browser-view-toggle !w-auto gap-1 px-1.5" onClick={switchView}
        title={agent ? '正在查看 Agent 网页；切换到我的网页' : '切换到 Agent 正在操作的网页'} aria-label={agent ? '切换到我的网页' : '切换到 Agent 网页'} aria-pressed={agent}>
        <span className="wc-browser-view-dot" aria-hidden /><span className="text-xs">{agent ? 'Agent' : '我的网页'}</span><ArrowLeftRight size={12} />
      </button>}
      <button className={`wc-preview-action !w-auto gap-1 px-1.5 ${reference.mode !== 'off' ? 'wc-browser-reference-active' : ''}`}
        title="引用网页元素或区域" aria-label="引用网页元素或区域" aria-pressed={reference.mode !== 'off'}
        disabled={!canReference || !state.ready || state.loading || !!state.error || state.url === 'about:blank'}
        onClick={() => { setFinding(false); browser.find(''); reference.toggle() }}><MousePointer2 size={15} /><span className="wc-browser-reference-label text-xs">引用</span></button>
      <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="wc-preview-action" aria-label="浏览器操作" title="浏览器操作"><MoreHorizontal size={16} /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="wc-menu-content min-w-48" align="end" sideOffset={6}
          onCloseAutoFocus={event => { if (finding) event.preventDefault() }}>
          <DropdownMenu.Item className="wc-menu-item" onSelect={() => onOpen('about:blank')}><Plus size={14} />新标签页</DropdownMenu.Item>
          <DropdownMenu.Item className="wc-menu-item" disabled={!state.ready} onSelect={() => shortcut('find')}><Search size={14} />在页面中查找</DropdownMenu.Item>
          <DropdownMenu.Item className="wc-menu-item" disabled={state.url === 'about:blank'} onSelect={copy}><Copy size={14} />复制网址</DropdownMenu.Item>
          <DropdownMenu.Item className="wc-menu-item" disabled={!state.ready || !isExternalBrowserUrl(state.url)} onSelect={browser.external}><ExternalLink size={14} />在系统浏览器中打开</DropdownMenu.Item>
          <DropdownMenu.Separator className="wc-menu-separator" />
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-[var(--wc-muted)]" aria-label="网页缩放">
            <span className="mr-auto">{agent ? '固定视口' : '缩放'}</span>
            <button className="wc-preview-action" aria-label="缩小网页" disabled={agent || !state.ready || state.zoom <= 0.25} onClick={() => shortcut('zoom-out')}><Minus size={14} /></button>
            <button className="wc-focus-ring min-w-12 rounded px-1 py-1" disabled={agent || !state.ready} title="重置缩放" onClick={() => shortcut('zoom-reset')}>{agent ? '100%' : `${Math.round(state.zoom * 100)}%`}</button>
            <button className="wc-preview-action" aria-label="放大网页" disabled={agent || !state.ready || state.zoom >= 3} onClick={() => shortcut('zoom-in')}><Plus size={14} /></button>
          </div>
          <DropdownMenu.Item className="wc-menu-item" disabled={agent || !state.ready} onSelect={() => browser.run(view => view.openDevTools())}>开发者工具</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
    {finding && <div className="flex min-w-0 items-center gap-1 border-b border-[var(--wc-line)] px-3 py-1.5 text-xs">
      <input ref={findRef} className="wc-focus-ring h-7 min-w-0 flex-1 rounded bg-transparent px-1" placeholder="在页面中查找" aria-label="在页面中查找"
        value={query} onChange={event => { setQuery(event.target.value); browser.find(event.target.value) }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); nextMatch(!event.shiftKey) } }} />
      <span className="whitespace-nowrap text-[var(--wc-faint)]" role="status">{state.match ? `${state.match.current}/${state.match.total}` : ''}</span>
      <button className="wc-preview-action" aria-label="上一个匹配" disabled={!query} onClick={() => nextMatch(false)}><ArrowUp size={14} /></button>
      <button className="wc-preview-action" aria-label="下一个匹配" disabled={!query} onClick={() => nextMatch(true)}><ArrowDown size={14} /></button>
      <button className="wc-preview-action" aria-label="关闭查找" onClick={() => shortcut('escape')}><X size={14} /></button>
    </div>}
    {reference.mode !== 'off' && <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--wc-line)] px-3 text-xs text-[var(--wc-muted)]" role="status">
      <span className="min-w-0 flex-1 truncate" title="点击元素，拖拽框选区域 · Ctrl 多选 · ↑ 选父元素">{reference.mode === 'restoring' ? '正在恢复引用…' : reference.mode === 'picking' ? '点击元素，拖拽框选区域 · Ctrl 多选 · ↑ 选父元素' : '同一条批注可描述多个目标'}</span>
      {reference.mode === 'picking' && reference.captures.length > 0 && <button className="wc-reference-secondary" onClick={reference.finishPicking}>完成选择 ({reference.captures.length})</button>}
      <button className="wc-preview-action" title="退出引用" aria-label="退出引用" onClick={reference.cancel}><X size={14} /></button>
    </div>}
    <div className="wc-browser-viewport relative flex min-h-0 flex-1 flex-col">
      <div ref={setStage} className="relative flex min-h-0 flex-1 flex-col overflow-auto bg-white" aria-busy={state.loading}>
        <div className="relative min-h-0 w-full flex-1" style={agent ? { minWidth: BROWSER_VIEWPORT.width, minHeight: BROWSER_VIEWPORT.height } : undefined}>
          {browser.lease && <webview ref={node => { browser.element.current = node as unknown as WebviewTag | null }}
            src={`about:blank#${browser.lease.id}`} partition={browser.lease.partition} allowpopups={'true' as unknown as boolean}
            style={agent ? { display: 'flex', position: 'absolute', width: BROWSER_VIEWPORT.width, height: '100%' }
              : { display: 'flex', position: 'absolute', width: '100%', height: '100%' }} aria-label="网页内容" />}
        </div>
        {(state.error || state.url === 'about:blank') && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--wc-surface)] px-6 text-center text-sm text-[var(--wc-muted)]">
          <Globe size={26} className="text-[var(--wc-faint)]" />
          <p className="max-w-sm break-words">{state.error ?? '输入网址，浏览网页或打开本机开发服务'}</p>
          {state.error && state.ready && <button className="wc-focus-ring flex items-center gap-2 rounded-lg border border-[var(--wc-line)] px-3 py-1.5" disabled={refresh.busy} aria-busy={refresh.busy}
            onClick={() => shortcut('reload')}><RefreshCw size={14} className={refresh.busy ? 'animate-spin' : ''} />重新加载</button>}
        </div>}
        <BrowserReferenceEditor reference={reference} boundary={stage} />
      </div>
      {active && <div key={agent ? 'agent' : 'user'} className="wc-browser-view-reveal" aria-hidden />}
    </div>
  </section>
}
