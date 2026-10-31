import { randomUUID } from 'node:crypto'
import { BrowserWindow, clipboard, ipcMain, Menu, net, session, shell, webContents, type DownloadItem, type WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import {
  BROWSER_FILE_SCHEME, BROWSER_PARTITION, MAX_BROWSER_GUESTS, browserDisplayUrl, browserLoadErrorMessage, browserShortcut, isExternalBrowserUrl,
  type BrowserDataClearMode, type BrowserDataState, type BrowserEvent, type BrowserEventPayload, type BrowserLease, type BrowserNavigationResult,
} from '../shared/browser.ts'
import { IPC } from '../shared/ipc.ts'
import { browserGuestPreferences, browserNavigationAllowed, browserRequestAllowed } from './browser-policy.ts'
import { BrowserFiles } from './browser-files.ts'
import { clearBrowserSession } from './browser-data.ts'
import { BrowserReferences } from './browser-references.ts'
import type { WorkspaceIO } from '@whycode/core'

interface GuestLease {
  owner: WebContents; attached: boolean; navigation: number
  guest?: WebContents; references?: BrowserReferences; loadError?: Error
}

class BrowserNavigationInterruptedError extends Error {
  constructor(cause: Error) {
    super('网页导航未完成：请求已中止、被替代或转为下载；不能确认目标页面已加载。', { cause })
  }
}

/** 网页只持有隔离的 Chromium 会话；窗口和标签释放时撤销 guest 所有权。 */
export class BrowserGuests {
  onClosed?: (id: string, reason: string) => void
  onOpen?: (id: string, url: string) => boolean
  onAudioStateChanged?: (id: string, audible: boolean) => void
  isAgent?: (id: string) => boolean
  private readonly leases = new Map<string, GuestLease>()
  private readonly files = new BrowserFiles()
  private readonly downloads = new Set<DownloadItem>()
  private clearing: BrowserDataClearMode | null = null
  private readonly applicationUrl: string | undefined
  private workspaceFor?: (runtimeId: string) => Promise<WorkspaceIO>

  constructor(applicationUrl?: string) { this.applicationUrl = applicationUrl }

  get(id: string): WebContents | undefined {
    const guest = this.leases.get(id)?.guest
    return guest && !guest.isDestroyed() ? guest : undefined
  }

  loadError(id: string): Error | undefined {
    const error = this.leases.get(id)?.loadError
    if (error instanceof BrowserNavigationInterruptedError) {
      const url = this.get(id)?.getURL()
      // 中断属于这次导航；已有页面仍可使用，启动空白页则不能当作目标网页。
      if (url && url !== `about:blank#${id}`) return undefined
    }
    return error
  }

  async navigate(id: string, url: string, runtimeId?: string, signal?: AbortSignal): Promise<void> {
    const lease = this.leases.get(id), guest = this.get(id)
    if (!lease || !guest) throw new Error('浏览器标签已关闭')
    const navigation = ++lease.navigation
    try {
      signal?.throwIfAborted()
      let target = url
      if (url.startsWith('file:')) {
        const io = runtimeId ? await this.workspaceFor?.(runtimeId) : undefined
        signal?.throwIfAborted()
        if (this.get(id) !== guest) throw new Error('浏览器标签已关闭')
        if (navigation !== lease.navigation) throw new Error('网页导航已被新的请求替代')
        target = this.files.open(id, url, io)
      } else if (!browserNavigationAllowed(url, this.applicationUrl)) throw new Error(`不支持此网页地址：${url}`)
      await guest.loadURL(target)
    } catch (error) {
      let failure = error instanceof Error ? error : new Error(String(error))
      if ('errno' in failure && typeof failure.errno === 'number' && 'code' in failure && typeof failure.code === 'string'
        && 'url' in failure && typeof failure.url === 'string') {
        // 停止或下载也会让 loadURL 以 -2 拒绝；优先保留原生失败事件，否则区分导航中断。
        if (lease.loadError) failure = new Error(lease.loadError.message, { cause: error })
        else if (failure.errno === -3 || failure.errno === -2) failure = new BrowserNavigationInterruptedError(failure)
        else failure = new Error(browserLoadErrorMessage(failure.errno, failure.code, failure.url), { cause: error })
      }
      // 策略、文件准备和原生导航共享错误出口；旧请求不能覆盖新导航的结果。
      if (this.get(id) === guest && navigation === lease.navigation && !signal?.aborted) {
        lease.loadError = failure
      }
      throw failure
    }
  }

  acquire(owner: WebContents): BrowserLease {
    if (this.clearing === 'all') throw new Error('正在清除全部浏览器数据，请稍后打开')
    if ([...this.leases.values()].filter(item => item.owner === owner).length >= MAX_BROWSER_GUESTS) {
      throw new Error('内置浏览器标签过多，请先关闭部分标签')
    }
    const id = randomUUID()
    this.leases.set(id, { owner, attached: false, navigation: 0 })
    return { id, partition: BROWSER_PARTITION }
  }

  release(owner: WebContents, id: string): Promise<void> {
    const lease = this.leases.get(id)
    if (!lease || lease.owner !== owner) return Promise.resolve()
    const destroyed = lease.guest && !lease.guest.isDestroyed()
      ? new Promise<void>(resolve => lease.guest!.once('destroyed', () => resolve()))
      : Promise.resolve()
    this.leases.delete(id)
    this.onClosed?.(id, 'page_closed: 网页已关闭')
    lease.references?.cancel()
    this.files.release(id)
    // 撤销租约后由 Renderer 卸载 webview，Electron 随 DOM 分离销毁 guest。
    // 提前 close 会让尚未卸载的元素把迟到事件发给已经销毁的原生窗口。
    return destroyed
  }

  register(workspaceFor: (runtimeId: string) => Promise<WorkspaceIO>): void {
    this.workspaceFor = workspaceFor
    this.configureSession()
    ipcMain.handle(IPC.getBrowserDataState, event => {
      this.requireOwner(event)
      return { clearing: this.clearing } satisfies BrowserDataState
    })
    ipcMain.handle(IPC.clearBrowserData, (event, mode: unknown) => {
      this.requireOwner(event)
      if (mode !== 'cache' && mode !== 'all') throw new Error('未知的浏览器清理方式')
      return this.clearData(mode)
    })
    ipcMain.handle(IPC.navigateBrowserPage, async (event, id: unknown, url: unknown, runtimeId: unknown): Promise<BrowserNavigationResult> => {
      this.requireOwner(event)
      const lease = typeof id === 'string' ? this.leases.get(id) : undefined
      if (typeof id !== 'string' || typeof url !== 'string' || lease?.owner !== event.sender
        || !lease.guest || lease.guest.isDestroyed()) throw new Error('浏览器标签已关闭')
      return this.navigate(id, url, typeof runtimeId === 'string' ? runtimeId : undefined).then(
        () => ({ status: 'completed' }),
        error => error instanceof BrowserNavigationInterruptedError ? { status: 'interrupted' }
          : { status: 'failed', error: error instanceof Error ? error.message : String(error) },
      )
    })
    ipcMain.handle(IPC.pickBrowserTarget, (event, id: unknown, options: unknown) => {
      this.requireOwner(event)
      const lease = typeof id === 'string' ? this.leases.get(id) : undefined
      if (lease?.owner !== event.sender || !lease.references) throw new Error('浏览器标签已关闭')
      return lease.references.pick(options)
    })
    ipcMain.handle(IPC.displayBrowserReference, (event, id: unknown, options: unknown) => {
      this.requireOwner(event)
      const lease = typeof id === 'string' ? this.leases.get(id) : undefined
      if (lease?.owner !== event.sender || !lease.references) throw new Error('浏览器标签已关闭')
      return lease.references.display(options)
    })
    ipcMain.on(IPC.cancelBrowserReference, (event, id: unknown) => {
      const lease = typeof id === 'string' ? this.leases.get(id) : undefined
      if (event.senderFrame === event.sender.mainFrame && lease?.owner === event.sender) lease.references?.cancel()
    })
    ipcMain.handle(IPC.openBrowserExternally, async (event, id: unknown) => {
      this.requireOwner(event)
      const lease = typeof id === 'string' ? this.leases.get(id) : undefined
      if (lease?.owner !== event.sender || !lease.guest || lease.guest.isDestroyed()) throw new Error('浏览器标签已关闭')
      const url = lease.guest.getURL()
      if (!isExternalBrowserUrl(url) || !browserNavigationAllowed(url, this.applicationUrl)) throw new Error('当前页面没有可在系统浏览器中打开的网址')
      await shell.openExternal(url)
    })
  }

  bind(window: BrowserWindow): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = params.src?.startsWith('about:blank#') ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id)
      if (this.clearing === 'all' || !lease || lease.owner !== owner || lease.attached || params.partition !== BROWSER_PARTITION) {
        event.preventDefault(); return
      }
      lease.attached = true
      browserGuestPreferences(preferences as Record<string, unknown>, BROWSER_PARTITION)
      preferences.backgroundThrottling = !this.isAgent?.(id)
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => this.attach(window, guest))
    const close = () => {
      for (const [id, lease] of this.leases) if (lease.owner === owner) this.release(owner, id)
    }
    owner.on('did-start-navigation', event => { if (event.isMainFrame && !event.isSameDocument) close() })
    owner.on('render-process-gone', close)
    owner.once('destroyed', close)
  }

  private attach(window: BrowserWindow, guest: WebContents): void {
    let id: string | null = null
    const send = (event: BrowserEventPayload) => {
      if (id && !window.webContents.isDestroyed()) window.webContents.send(IPC.browserEvent, { id, ...event })
    }
    guest.once('dom-ready', () => {
      const key = guest.getURL().slice('about:blank#'.length)
      const lease = this.leases.get(key)
      if (!lease || lease.owner !== window.webContents || lease.guest) return
      id = key; lease.guest = guest
      lease.references = new BrowserReferences(guest, url => this.files.source(key, url))
      // 从用户页建立时开始保留加载失败，接管页面的 Agent 也必须能读取该事实。
      guest.on('did-start-navigation', event => {
        if (event.isMainFrame && !event.isSameDocument) delete lease.loadError
      })
      guest.on('did-fail-load', (_event, code, description, url, mainFrame) => {
        if (mainFrame && code !== -3) lease.loadError = new Error(browserLoadErrorMessage(code, description, url))
      })
      guest.once('destroyed', () => {
        this.leases.delete(key); this.files.release(key); this.onClosed?.(key, 'page_closed: 网页已关闭')
      })
      guest.on('render-process-gone', () => this.release(window.webContents, key))
    })
    const allowed = (url: string) => browserNavigationAllowed(url, this.applicationUrl) || (!!id && this.files.allows(id, url))
    const open = (url: string) => {
      if (allowed(url) && !(id && this.onOpen?.(id, url))) send({ type: 'open', url: browserDisplayUrl(url) })
    }
    guest.setWindowOpenHandler(({ url, postBody }) => {
      if (!postBody) open(url)
      else send({ type: 'notice', message: '此页面需要在系统浏览器中打开', error: false })
      return { action: 'deny' }
    })
    guest.on('will-frame-navigate', event => {
      if (event.isMainFrame && !allowed(event.url)) event.preventDefault()
    })
    guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
      if (mainFrame && !allowed(url)) event.preventDefault()
    })
    guest.on('will-attach-webview', event => event.preventDefault())
    guest.on('audio-state-changed', event => {
      if (id && this.leases.get(id)?.guest === guest) this.onAudioStateChanged?.(id, event.audible)
    })
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const command = browserShortcut(input)
      if (!command) return
      if (command === 'escape' && !(id && this.leases.get(id)?.references?.active)) { if (guest.isLoading()) guest.stop(); return }
      event.preventDefault()
      send({ type: 'shortcut', command })
    })
    guest.on('context-menu', (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = []
      if (params.linkURL && allowed(params.linkURL)) {
        items.push({ label: '在新标签页中打开链接', click: () => open(params.linkURL) },
          { label: '复制链接地址', click: () => clipboard.writeText(browserDisplayUrl(params.linkURL)) })
      }
      if (params.mediaType === 'image' && params.hasImageContents) {
        items.push({ label: '复制图片', click: () => guest.copyImageAt(params.x, params.y) },
          { label: '图片另存为…', click: () => guest.downloadURL(params.srcURL) })
      }
      if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
      else if (params.selectionText) items.push({ role: 'copy' })
      if (items.length) items.push({ type: 'separator' })
      items.push({ label: '重新加载', click: () => send({ type: 'shortcut', command: 'reload' }) },
        { label: '检查元素', enabled: !id || !this.isAgent?.(id), click: () => guest.inspectElement(params.x, params.y) })
      Menu.buildFromTemplate(items).popup({ window })
    })
  }

  private configureSession(): void {
    const browser = session.fromPartition(BROWSER_PARTITION)
    browser.protocol.handle(BROWSER_FILE_SCHEME, async request => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
      try {
        const remote = await this.files.remoteResponse(request)
        if (remote) return remote
        const path = await this.files.resolve(request.url)
        const response = await net.fetch(pathToFileURL(path).href, {
          method: request.method, headers: request.headers, signal: request.signal,
        })
        const headers = new Headers(response.headers)
        headers.set('Cache-Control', 'no-store')
        return new Response(response.body, { status: response.status, headers })
      } catch { return new Response('文件不存在或无法读取', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }) }
    })
    browser.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen')
    browser.setPermissionRequestHandler((contents, permission, callback) => {
      callback(permission === 'fullscreen')
      if (permission === 'fullscreen') return
      const entry = [...this.leases].find(([, lease]) => lease.guest === contents)
      if (entry && !entry[1].owner.isDestroyed()) entry[1].owner.send(IPC.browserEvent, {
        id: entry[0], type: 'notice', error: false, message: '此页面请求的设备或系统权限暂不支持，可在系统浏览器中打开',
      } satisfies BrowserEvent)
    })
    browser.setDevicePermissionHandler(() => false)
    browser.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    browser.webRequest.onBeforeRequest((details, callback) => {
      if (this.clearing === 'all') { callback({ cancel: true }); return }
      // 检查器首个请求早于 devToolsWebContents 可用；remote 是 Electron 的原生前端类型。
      const inspector = details.webContents?.getType() === 'remote'
      const entry = [...this.leases].find(([, lease]) => lease.guest === details.webContents)
      const source = (details.resourceType === 'subFrame' ? details.frame?.parent?.url : details.frame?.url)
        ?? details.webContents?.getURL() ?? ''
      const local = !!entry && this.files.allows(entry[0], details.url)
        && (details.resourceType === 'mainFrame' || this.files.allows(entry[0], source))
      callback({ cancel: !local && !browserRequestAllowed(details.url, this.applicationUrl, inspector) })
    })
    browser.on('will-download', (event, item, contents) => {
      const entry = [...this.leases].find(([, lease]) => lease.guest === contents)
      if (this.clearing === 'all' || !entry) { event.preventDefault(); return }
      this.downloads.add(item)
      item.setSaveDialogOptions({ title: '保存下载文件' })
      item.once('done', (_event, state) => {
        this.downloads.delete(item)
        if (state === 'cancelled' || entry[1].owner.isDestroyed()) return
        entry[1].owner.send(IPC.browserEvent, { id: entry[0], type: 'notice', error: state !== 'completed',
          message: state === 'completed' ? `已下载：${item.getFilename()}` : `下载失败：${item.getFilename()}` } satisfies BrowserEvent)
      })
    })
  }

  private async clearData(mode: BrowserDataClearMode): Promise<void> {
    if (this.clearing) throw new Error('浏览器数据正在清理，请等待完成')
    this.setClearing(mode)
    try {
      const browser = session.fromPartition(BROWSER_PARTITION)
      if (mode === 'all') {
        for (const item of this.downloads) item.cancel()
        // 包含尚未 dom-ready、还未写回租约的 guest；关闭旧页面后再清理，防止重新写入。
        const destroyed = Promise.all(webContents.getAllWebContents()
          .filter(contents => contents.session === browser)
          .map(contents => new Promise<void>(resolve => {
            if (contents.isDestroyed()) { resolve(); return }
            contents.once('destroyed', () => resolve())
            // 检查器没有 webview DOM，沿其自身窗口生命周期关闭。
            if (contents.getType() !== 'webview') contents.close({ waitForBeforeUnload: false })
          })))
        for (const [id, lease] of this.leases) this.release(lease.owner, id)
        await destroyed
      }
      await clearBrowserSession(browser, mode)
    } finally { this.setClearing(null) }
  }

  private setClearing(clearing: BrowserDataClearMode | null): void {
    this.clearing = clearing
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(IPC.browserDataChanged, { clearing } satisfies BrowserDataState)
    }
  }

  private requireOwner(event: Electron.IpcMainInvokeEvent): void {
    if (!BrowserWindow.fromWebContents(event.sender) || event.sender.getType() !== 'window'
      || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主页面可管理浏览器')
  }
}
