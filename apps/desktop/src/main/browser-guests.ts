import { randomUUID } from 'node:crypto'
import { BrowserWindow, clipboard, ipcMain, Menu, session, shell, type WebContents } from 'electron'
import { BROWSER_PARTITION, MAX_BROWSER_GUESTS, browserShortcut, type BrowserEvent, type BrowserEventPayload, type BrowserLease } from '../shared/browser.ts'
import { IPC } from '../shared/ipc.ts'
import { browserGuestPreferences, browserNavigationAllowed, browserRequestAllowed } from './browser-policy.ts'

interface GuestLease { owner: WebContents; attached: boolean; guest?: WebContents }

/** 网页只持有隔离的 Chromium 会话；窗口和标签释放时撤销 guest 所有权。 */
export class BrowserGuests {
  private readonly leases = new Map<string, GuestLease>()
  private readonly applicationUrl: string | undefined

  constructor(applicationUrl?: string) { this.applicationUrl = applicationUrl }

  acquire(owner: WebContents): BrowserLease {
    if ([...this.leases.values()].filter(item => item.owner === owner).length >= MAX_BROWSER_GUESTS) {
      throw new Error('内置浏览器标签过多，请先关闭部分标签')
    }
    const id = randomUUID()
    this.leases.set(id, { owner, attached: false })
    return { id, partition: BROWSER_PARTITION }
  }

  release(owner: WebContents, id: string): void {
    const lease = this.leases.get(id)
    if (!lease || lease.owner !== owner) return
    this.leases.delete(id)
    if (lease.guest && !lease.guest.isDestroyed()) lease.guest.close({ waitForBeforeUnload: false })
  }

  register(): void {
    this.configureSession()
    ipcMain.handle(IPC.acquireBrowser, event => {
      this.requireOwner(event)
      return this.acquire(event.sender)
    })
    ipcMain.on(IPC.releaseBrowser, (event, id: unknown) => {
      if (event.senderFrame === event.sender.mainFrame && typeof id === 'string') this.release(event.sender, id)
    })
    ipcMain.handle(IPC.openBrowserExternally, async (event, id: unknown) => {
      this.requireOwner(event)
      const lease = typeof id === 'string' ? this.leases.get(id) : undefined
      if (lease?.owner !== event.sender || !lease.guest || lease.guest.isDestroyed()) throw new Error('浏览器标签已关闭')
      const url = lease.guest.getURL()
      if (url === 'about:blank' || !browserNavigationAllowed(url, this.applicationUrl)) throw new Error('当前页面没有可打开的网址')
      await shell.openExternal(url)
    })
  }

  bind(window: BrowserWindow): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = params.src?.startsWith('about:blank#') ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id)
      if (!lease || lease.owner !== owner || lease.attached || params.partition !== BROWSER_PARTITION) {
        event.preventDefault(); return
      }
      lease.attached = true
      browserGuestPreferences(preferences as Record<string, unknown>, BROWSER_PARTITION)
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
      if (!lease || lease.owner !== window.webContents || lease.guest) {
        guest.close({ waitForBeforeUnload: false }); return
      }
      id = key; lease.guest = guest
      guest.once('destroyed', () => { this.leases.delete(key) })
    })
    const open = (url: string) => {
      if (browserNavigationAllowed(url, this.applicationUrl)) send({ type: 'open', url })
    }
    guest.setWindowOpenHandler(({ url, postBody }) => {
      if (!postBody) open(url)
      else send({ type: 'notice', message: '此页面需要在系统浏览器中打开', error: false })
      return { action: 'deny' }
    })
    guest.on('will-frame-navigate', event => {
      if (event.isMainFrame && !browserNavigationAllowed(event.url, this.applicationUrl)) event.preventDefault()
    })
    guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
      if (mainFrame && !browserNavigationAllowed(url, this.applicationUrl)) event.preventDefault()
    })
    guest.on('will-attach-webview', event => event.preventDefault())
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const command = browserShortcut(input)
      if (!command) return
      if (command === 'escape') { if (guest.isLoading()) guest.stop(); return }
      event.preventDefault()
      send({ type: 'shortcut', command })
    })
    guest.on('context-menu', (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = []
      if (params.linkURL && browserNavigationAllowed(params.linkURL, this.applicationUrl)) {
        items.push({ label: '在新标签页中打开链接', click: () => open(params.linkURL) },
          { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) })
      }
      if (params.mediaType === 'image' && params.hasImageContents) {
        items.push({ label: '复制图片', click: () => guest.copyImageAt(params.x, params.y) },
          { label: '图片另存为…', click: () => guest.downloadURL(params.srcURL) })
      }
      if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
      else if (params.selectionText) items.push({ role: 'copy' })
      if (items.length) items.push({ type: 'separator' })
      items.push({ label: '重新加载', click: () => guest.reload() },
        { label: '检查元素', click: () => guest.inspectElement(params.x, params.y) })
      Menu.buildFromTemplate(items).popup({ window })
    })
  }

  private configureSession(): void {
    const browser = session.fromPartition(BROWSER_PARTITION)
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
      callback({ cancel: !browserRequestAllowed(details.url, this.applicationUrl) })
    })
    browser.on('will-download', (event, item, contents) => {
      const entry = [...this.leases].find(([, lease]) => lease.guest === contents)
      if (!entry) { event.preventDefault(); return }
      item.setSaveDialogOptions({ title: '保存下载文件' })
      item.once('done', (_event, state) => {
        if (state === 'cancelled' || entry[1].owner.isDestroyed()) return
        entry[1].owner.send(IPC.browserEvent, { id: entry[0], type: 'notice', error: state !== 'completed',
          message: state === 'completed' ? `已下载：${item.getFilename()}` : `下载失败：${item.getFilename()}` } satisfies BrowserEvent)
      })
    })
  }

  private requireOwner(event: Electron.IpcMainInvokeEvent): void {
    if (!BrowserWindow.fromWebContents(event.sender) || event.sender.getType() !== 'window'
      || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主页面可管理浏览器')
  }
}
