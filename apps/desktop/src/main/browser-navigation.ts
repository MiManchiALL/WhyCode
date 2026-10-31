import { setTimeout as delay } from 'node:timers/promises'
import type { WebContents } from 'electron'
import { browserLoadErrorMessage } from '../shared/browser.ts'

type Phase = 'preparing' | 'requested' | 'loading' | 'committed' | 'ready'
interface DocumentState {
  phase: Phase
  error?: Error
  retained?: { ready: boolean; error?: Error }
}

export class BrowserNavigationInterruptedError extends Error {
  constructor(cause: Error) {
    super('网页导航未完成：请求已中止、被新的请求替代或转为下载；不能确认目标页面已加载。', { cause })
  }
}

/** 每个 guest 的主文档就绪与加载失败单源；资源加载可在 DOM 就绪后继续。 */
export class BrowserNavigation {
  private request = 0
  private closed = false
  // 租约在启动空白页的 dom-ready 后建立；该空白页不代表用户目标已就绪。
  private document: DocumentState = { phase: 'preparing' }

  constructor(private readonly guest: WebContents) {
    guest.on('did-start-navigation', this.started)
    guest.on('did-navigate', this.committed)
    guest.on('did-navigate-in-page', this.inPage)
    guest.on('dom-ready', this.domReady)
    guest.on('did-fail-load', this.failed)
    guest.on('did-stop-loading', this.stopped)
  }

  get error(): Error | undefined {
    const { error, retained } = this.document
    return error instanceof BrowserNavigationInterruptedError && retained?.ready ? retained.error : error
  }

  private get ready(): boolean {
    return !this.error && (this.document.phase === 'ready'
      || (this.document.error instanceof BrowserNavigationInterruptedError && this.document.retained?.ready === true))
  }

  begin(): number {
    this.newDocument('preparing')
    return ++this.request
  }

  check(request: number): void {
    if (this.closed || this.guest.isDestroyed()) throw new Error('浏览器标签已关闭')
    if (request !== this.request) throw new BrowserNavigationInterruptedError(new Error('网页导航已被新的请求替代'))
  }

  fail(request: number, error: unknown): void {
    if (!this.closed && request === this.request) this.document.error = error instanceof Error ? error : new Error(String(error))
  }

  async load(request: number, url: string, signal?: AbortSignal): Promise<void> {
    this.check(request)
    signal?.throwIfAborted()
    const document = this.document
    document.phase = 'requested'
    try {
      // 导航等待在 DOM 就绪时结束；loadURL 继续加载资源，其迟到结果不能覆盖新文档。
      void this.guest.loadURL(url).catch(error => {
        if (this.closed || request !== this.request || document !== this.document || document.error) return
        let failure = error instanceof Error ? error : new Error(String(error))
        if ('errno' in failure && typeof failure.errno === 'number' && 'code' in failure && typeof failure.code === 'string'
          && 'url' in failure && typeof failure.url === 'string') {
          if (failure.errno === -3 || failure.errno === -2) {
            if (document.phase === 'ready') return
            failure = new BrowserNavigationInterruptedError(failure)
          }
          else failure = new Error(browserLoadErrorMessage(failure.errno, failure.code, failure.url), { cause: error })
        }
        document.error = failure
      })
      await this.wait(signal, request)
    } catch (error) {
      if (signal?.aborted && request === this.request && !this.closed && !this.guest.isDestroyed()) this.guest.stop()
      throw error
    }
  }

  async wait(signal?: AbortSignal, request?: number): Promise<void> {
    const deadline = Date.now() + 10_000
    do {
      signal?.throwIfAborted()
      this.check(request ?? this.request)
      const error = request === undefined ? this.error : this.document.error
      if (error) throw error
      if (this.ready) return
      await delay(50, undefined, { signal })
    } while (Date.now() < deadline)
    throw new Error('网页主文档尚未就绪，请重新观察或导航重试')
  }

  close(): void {
    this.closed = true
    this.guest.removeListener('did-start-navigation', this.started)
    this.guest.removeListener('did-navigate', this.committed)
    this.guest.removeListener('did-navigate-in-page', this.inPage)
    this.guest.removeListener('dom-ready', this.domReady)
    this.guest.removeListener('did-fail-load', this.failed)
    this.guest.removeListener('did-stop-loading', this.stopped)
  }

  private newDocument(phase: Phase): void {
    const current = this.document
    // 新文档提交前保留此前文档的状态，供停止或下载后恢复；不累积导航链。
    const retained = ['preparing', 'requested', 'loading'].includes(current.phase) ? current.retained
      : { ready: current.phase === 'ready', error: current.error }
    this.document = { phase, retained }
  }

  private readonly started = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!event.isMainFrame || event.isSameDocument) return
    if (this.document.phase === 'preparing') this.request++
    if (this.document.phase !== 'requested') this.newDocument('loading')
    else this.document.phase = 'loading'
  }
  private readonly committed = () => {
    if (this.document.phase !== 'loading') return
    this.document.phase = 'committed'
    delete this.document.retained
  }
  private readonly domReady = () => {
    // 旧 DOM 在新导航提交前仍可能发事件；只能接受本轮已提交文档的就绪。
    if (this.document.phase === 'committed' && !this.document.error) this.document.phase = 'ready'
  }
  private readonly inPage = (_event: Electron.Event, _url: string, mainFrame: boolean) => {
    if (mainFrame && this.document.phase === 'requested' && this.document.retained?.ready) {
      this.document = { phase: 'ready', error: this.document.retained.error }
    }
  }
  private readonly failed = (_event: Electron.Event, code: number, description: string, url: string, mainFrame: boolean) => {
    if (mainFrame && code !== -3) this.document.error = new Error(browserLoadErrorMessage(code, description, url))
  }
  private readonly stopped = () => {
    if (['requested', 'loading'].includes(this.document.phase) && !this.document.error) {
      this.document.error = new BrowserNavigationInterruptedError(new Error('导航结束前未提交主文档'))
    }
  }
}
