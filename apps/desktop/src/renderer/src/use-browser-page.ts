import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { browserAddress, isBrowserUrl, type BrowserLease, type BrowserShortcut } from '../../shared/browser.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'

export interface BrowserPageState {
  url: string; title: string; loading: boolean; ready: boolean; back: boolean; forward: boolean
  error: string | null; zoom: number; match: { current: number; total: number } | null
}
interface Props {
  active: boolean
  url: string
  onNavigate: (url: string, title: string) => void
  onOpen: (url: string) => void
  onShortcut: (command: BrowserShortcut) => void
}

export function useBrowserPage(props: Props) {
  const feedback = useConversationFeedback()
  const callbacks = useRef(props)
  callbacks.current = props
  const initialUrl = useRef(props.url)
  const element = useRef<WebviewTag | null>(null)
  const ready = useRef(false)
  const [started, setStarted] = useState(props.active)
  const [lease, setLease] = useState<BrowserLease | null>(null)
  const [state, setState] = useState<BrowserPageState>({ url: props.url, title: '', loading: false,
    ready: false, back: false, forward: false, error: null, zoom: 1, match: null })
  useEffect(() => { if (props.active) setStarted(true) }, [props.active])
  useEffect(() => {
    if (props.active && ready.current && element.current) {
      const zoom = element.current.getZoomFactor()
      setState(value => ({ ...value, zoom }))
    }
  }, [props.active])
  useEffect(() => {
    if (!started) return
    let cancelled = false
    let current: BrowserLease | null = null
    void window.whycode.acquireBrowser().then(value => {
      if (cancelled) { window.whycode.releaseBrowser(value.id); return }
      current = value; setLease(value)
    }).catch(error => { if (!cancelled) setState(value => ({ ...value, error: String(error) })) })
    return () => { cancelled = true; ready.current = false; if (current) window.whycode.releaseBrowser(current.id) }
  }, [started])

  useEffect(() => {
    const webview = element.current
    if (!lease || !webview) return
    let closed = false
    let bootstrapped = false
    let firstDocument = true
    const removers: (() => void)[] = []
    const listen = (name: string, handler: (event: Event) => void) => {
      webview.addEventListener(name, handler)
      removers.push(() => webview.removeEventListener(name, handler))
    }
    const update = () => {
      if (closed || !ready.current) return
      const rawUrl = webview.getURL()
      if (firstDocument && isBrowserUrl(rawUrl)) {
        // 租约空白页只负责启动 guest，不属于用户的浏览历史。
        webview.clearHistory()
        firstDocument = false
      }
      const url = rawUrl.startsWith('about:blank#') ? 'about:blank' : rawUrl
      const title = url === 'about:blank' ? '' : webview.getTitle().slice(0, 256)
      setState(value => ({ ...value, url, title, ready: true, back: webview.canGoBack(),
        forward: webview.canGoForward(), zoom: webview.getZoomFactor() }))
      if (!rawUrl.startsWith('about:blank#')) callbacks.current.onNavigate(url, title)
    }
    listen('dom-ready', () => {
      ready.current = true
      update()
      if (bootstrapped) return
      bootstrapped = true
      if (initialUrl.current !== 'about:blank') navigate(initialUrl.current)
    })
    listen('did-start-loading', () => setState(value => ({ ...value, loading: true })))
    listen('did-stop-loading', () => { setState(value => ({ ...value, loading: false })); update() })
    listen('did-start-navigation', event => {
      if ((event as Event & { isMainFrame: boolean }).isMainFrame) setState(value => ({ ...value, error: null }))
    })
    for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated']) listen(name, update)
    listen('did-fail-load', event => {
      const failure = event as Event & { isMainFrame: boolean; errorCode: number; errorDescription: string; validatedURL: string }
      if (!failure.isMainFrame || failure.errorCode === -3) return
      setState(value => ({ ...value, loading: false, url: failure.validatedURL,
        error: `页面加载失败（${failure.errorDescription}），请检查网址或网络后重试` }))
    })
    listen('render-process-gone', () => {
      setState(value => ({ ...value, loading: false, error: '网页进程已退出，请刷新重试' }))
    })
    listen('found-in-page', event => {
      const { result } = event as Event & { result: { activeMatchOrdinal: number; matches: number } }
      setState(value => ({ ...value, match: { current: result.activeMatchOrdinal, total: result.matches } }))
    })
    const unsubscribe = window.whycode.onBrowserEvent(event => {
      if (event.id !== lease.id) return
      if (event.type === 'open') callbacks.current.onOpen(event.url)
      else if (event.type === 'shortcut') callbacks.current.onShortcut(event.command)
      else feedback(event.error ? 'error' : 'info', event.message, true)
    })
    return () => { closed = true; ready.current = false; removers.forEach(remove => remove()); unsubscribe() }
  }, [lease, feedback])

  const run = (action: (webview: WebviewTag) => void) => {
    if (!ready.current || !element.current) return
    try { action(element.current) } catch (error) { feedback('error', error instanceof Error ? error.message : String(error)) }
  }
  const navigate = (address: string) => {
    let url: string
    try { url = browserAddress(address) } catch (error) { feedback('error', (error as Error).message); return }
    if (!ready.current) {
      initialUrl.current = url
      setState(value => ({ ...value, url, loading: true }))
      return
    }
    run(webview => {
      setState(value => ({ ...value, error: null, url, loading: true }))
      // 导航失败由 did-fail-load 单一投影；旧 loadURL 的拒绝不能覆盖新导航。
      void webview.loadURL(url).catch(() => {})
    })
  }
  const reload = (ignoreCache = false) => run(webview => {
    setState(value => ({ ...value, error: null }))
    if (ignoreCache) webview.reloadIgnoringCache(); else webview.reload()
  })
  const zoom = (factor: number) => run(webview => {
    const value = Math.max(0.25, Math.min(3, Math.round(factor * 100) / 100))
    webview.setZoomFactor(value); setState(state => ({ ...state, zoom: value }))
  })
  const find = (text: string, forward = true, next = false) => run(webview => {
    if (text) webview.findInPage(text, { forward, findNext: next })
    else { webview.stopFindInPage('clearSelection'); setState(value => ({ ...value, match: null })) }
  })
  const external = () => {
    if (lease) void window.whycode.openBrowserExternally(lease.id).catch(error => feedback('error', String(error)))
  }
  return { element, lease, state, run, navigate, reload, zoom, find, external }
}
