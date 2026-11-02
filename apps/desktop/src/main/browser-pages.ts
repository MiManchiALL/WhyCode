import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import { IPC } from '../shared/ipc.ts'
import { browserAddress, browserDisplayUrl } from '../shared/browser.ts'
import type { BrowserHostState, BrowserSurface, BrowserViewAction, BrowserViewRequest } from '../shared/browser-agent.ts'
import type { BrowserGuests } from './browser-guests.ts'

const pageSchema = z.object({ id: z.string().max(100), url: z.string().max(1024 * 1024), title: z.string().max(256), workspaceFile: z.boolean().optional() })
const viewSchema = z.object({ runtimeId: z.string().max(100), sessionId: z.string().nullable(), pages: z.array(pageSchema).max(12),
  maxBrowserPages: z.number().int().min(0).max(12), activePageId: z.string().nullable(), visible: z.boolean() })
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), runtimeId: z.string(), page: pageSchema }),
  z.object({ type: z.literal('stop'), runtimeId: z.string(), pageId: z.string() }),
  z.object({ type: z.literal('update'), id: z.string(), url: z.string().max(1024 * 1024), title: z.string().max(256) }),
])
interface Surface { owner: WebContents; value: BrowserSurface; abort: AbortController }
export interface BrowserTurnPage {
  owner: WebContents; runtimeId: string; turnId: string; surfaceId: string
  closed: Map<string, { url: string; reason: Error }>
}

/** 每个标签持有一个网页；Turn 只选择操作目标和临时接管页面。 */
export class BrowserPages {
  private readonly surfaces = new Map<string, Surface>()
  private readonly views = new Map<WebContents, BrowserViewRequest>()
  private readonly runtimes = new Map<string, { owner: WebContents; sessionId: string | null; pageIds: string[]; maxBrowserPages: number }>()
  private readonly turns = new Map<string, BrowserTurnPage>()
  private readonly ownerThrottling = new Map<WebContents, boolean>()
  private revision = 0

  constructor(private readonly guests: BrowserGuests) {
    guests.onClosed = (id, reason) => this.closed(id, reason)
    guests.onAudioStateChanged = (id, audible) => {
      const surface = this.surfaces.get(id)
      if (!surface || surface.value.audible === audible) return
      surface.value.audible = audible
      this.publish(surface.owner)
    }
    guests.isAgent = id => !!this.surfaces.get(id)?.value.turnId
    guests.onOpen = (id, url) => {
      const source = this.surfaces.get(id)
      if (!source) return false
      try {
        const address = browserDisplayUrl(url)
        this.create(source.owner, source.value.runtimeId,
          { id: randomUUID(), url: address, title: '', workspaceFile: source.value.page.workspaceFile && address.startsWith('file:') }, id)
        this.publish(source.owner)
      } catch (error) {
        if (!source.owner.isDestroyed()) source.owner.send(IPC.browserEvent, { id, type: 'notice', error: true, message: String(error) })
      }
      return true
    }
  }

  register(): void {
    ipcMain.handle(IPC.browserHostState, event => { this.requireOwner(event); return this.snapshot(event.sender) })
    ipcMain.handle(IPC.syncBrowserView, (event, input: unknown) => {
      this.requireOwner(event); this.sync(event.sender, viewSchema.parse(input)); return this.snapshot(event.sender)
    })
    ipcMain.handle(IPC.browserViewAction, (event, input: unknown) => {
      this.requireOwner(event); this.action(event.sender, actionSchema.parse(input)); return this.snapshot(event.sender)
    })
  }

  sync(owner: WebContents, view: BrowserViewRequest): void {
    if (!this.views.has(owner)) owner.once('destroyed', () => {
      this.views.delete(owner)
      this.ownerThrottling.delete(owner)
      for (const [id, runtime] of this.runtimes) if (runtime.owner === owner) this.runtimes.delete(id)
    })
    this.views.set(owner, view)
    if (view.runtimeId) this.runtimes.set(view.runtimeId, { owner, sessionId: view.sessionId,
      pageIds: view.pages.map(page => page.id), maxBrowserPages: view.maxBrowserPages })
    for (const [id, { value, owner: pageOwner }] of this.surfaces) {
      if (pageOwner !== owner || value.turnId) continue
      if (value.runtimeId !== view.runtimeId && !this.agentAncestor(value)) void this.remove(id)
    }
    const page = view.pages.find(page => page.id === view.activePageId)
    if (page && view.visible && !this.page(view.runtimeId, page.id)) this.create(owner, view.runtimeId, page)
    this.publish(owner)
  }

  action(owner: WebContents, action: BrowserViewAction): void {
    if (action.type === 'update') {
      const surface = this.surfaces.get(action.id)
      if (!surface) return
      if (surface.owner !== owner) throw new Error('网页不属于当前窗口')
      surface.value.page = { ...surface.value.page, url: action.url, title: action.title }
    } else {
      if (this.runtimes.get(action.runtimeId)?.owner !== owner) throw new Error('网页不属于当前窗口')
      if (action.type === 'stop') {
        const page = this.page(action.runtimeId, action.pageId)
        if (page) void this.remove(page.id, 'user_closed: 用户关闭了此网页')
      } else {
        const page = { ...action.page, url: browserAddress(action.page.url) }
        const existing = this.page(action.runtimeId, page.id)
        if (existing?.turnId) {
          if (existing.page.url !== page.url) throw new Error('Agent 正在操作此网页，请先停止该网页操作')
          return
        }
        if (existing) {
          if (existing.page.url !== page.url) existing.navigation++
          existing.page = page
        } else this.create(owner, action.runtimeId, page)
      }
    }
    this.publish(owner)
  }

  list(runtimeId: string) {
    const owner = this.runtimes.get(runtimeId)?.owner
    const selected = [...this.turns.values()].find(turn => turn.runtimeId === runtimeId)?.surfaceId
    return [...this.surfaces.values()].filter(s => s.value.runtimeId === runtimeId).map(({ value }) => ({
      id: value.id, url: value.page.url, title: value.page.title, agent: !!value.turnId,
      selected: selected === value.id, openerId: value.parentId, active: !!owner && this.visible(owner) === value.id,
    }))
  }

  open(runtimeId: string, turnId: string, target: { id?: string; url?: string }): BrowserTurnPage {
    const current = this.turns.get(turnId)
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime || runtime.owner.isDestroyed()) throw new Error('会话窗口不可用')
    if (target.id && current?.closed.has(target.id)) throw current.closed.get(target.id)!.reason
    if (current && !target.id && target.url === undefined) { this.surface(current); return current }
    const url = target.url === undefined ? undefined : browserAddress(target.url)
    const candidates = this.list(runtimeId).filter(page => (!target.id || page.id === target.id) && (!url || page.url === url))
    const candidate = candidates.find(page => page.id === current?.surfaceId) ?? candidates.find(page => page.active)
      ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (target.id && !candidate) throw new Error('指定页面已关闭或与网址不符，请重新列出网页')
    if (!candidate && candidates.length > 1) throw new Error('有多个匹配页面，请从 browser.tabs() 中选择 id')
    if (!candidate && !url) throw new Error('本轮没有已打开的网页，请调用 browser.open({url: "目标网址"})；无需用户打开侧栏')
    const closed = !candidate && [...current?.closed.values() ?? []].find(page => page.url === url)
    if (closed) throw closed.reason
    const value = candidate ? this.surfaces.get(candidate.id)!.value
      : this.create(runtime.owner, runtimeId, { id: randomUUID(), url: url!, title: '', workspaceFile: url!.startsWith('file:') })
    if (value.turnId && value.turnId !== turnId) throw new Error('此网页正在被另一轮操作占用')
    value.turnId = turnId
    const turn = current ?? { owner: runtime.owner, runtimeId, turnId, surfaceId: value.id, closed: new Map() }
    turn.surfaceId = value.id
    this.turns.set(turnId, turn)
    if (!this.ownerThrottling.has(turn.owner)) {
      this.ownerThrottling.set(turn.owner, turn.owner.getBackgroundThrottling())
      turn.owner.setBackgroundThrottling(false)
    }
    this.guests.get(value.id)?.setBackgroundThrottling(false)
    this.publish(turn.owner)
    return turn
  }

  current(turnId: string): BrowserTurnPage {
    const turn = this.turns.get(turnId)
    if (!turn) throw new Error('本轮尚未选择网页，请先调用 browser.open({id}) 或 browser.open({url})')
    this.surface(turn)
    return turn
  }

  signal(turn: BrowserTurnPage): AbortSignal {
    this.surface(turn)
    return this.surfaces.get(turn.surfaceId)!.abort.signal
  }

  async guest(turn: BrowserTurnPage, signal: AbortSignal, allowFailedNavigation = false): Promise<WebContents> {
    for (let count = 0; count < 200; count++) {
      signal.throwIfAborted()
      const guest = this.guests.get(turn.surfaceId)
      if (guest) {
        if (!allowFailedNavigation) {
          try { await this.guests.waitForDocument(turn.surfaceId, signal) }
          catch (error) { throw this.navigationError(turn.surfaceId, error) }
        }
        return guest
      }
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
    throw new Error('网页尚未准备好，请重试 browser.snapshot()')
  }

  async navigate(turn: BrowserTurnPage, url: string, signal: AbortSignal): Promise<void> {
    const value = this.surface(turn), address = browserAddress(url)
    signal.throwIfAborted()
    value.page = { ...value.page, url: address, workspaceFile: address.startsWith('file:') }
    this.publish(turn.owner)
    try { await this.guests.navigate(value.id, address, address.startsWith('file:') ? turn.runtimeId : undefined, signal) }
    catch (error) { throw this.navigationError(value.id, error) }
  }

  private navigationError(id: string, error: unknown): unknown {
    const failure = this.guests.loadError(id)
    if (!failure || error !== failure) return error
    const certificate = this.guests.pendingCertificate(id)
    return new Error(certificate
      ? `certificate_confirmation_required: ${new URL(certificate.url).origin}（${certificate.error}）。此页面需要用户手动确认证书。请告知用户打开右侧栏的对应浏览器标签，点击“高级 → 继续访问”，用户确认后再继续操作当前网页。`
      : `${failure.message}\n使用 browser.navigate({url}) 重试或换网址；browser.open 不会重新加载页面。`, { cause: error })
  }

  async finish(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId)
    if (!turn) return
    this.turns.delete(turnId)
    const released: Promise<void>[] = []
    for (const { value } of this.surfaces.values()) if (value.turnId === turnId) {
      delete value.turnId
      this.guests.get(value.id)?.setBackgroundThrottling(true)
    }
    for (const { value } of this.surfaces.values()) {
      if (value.runtimeId === turn.runtimeId && !value.turnId && this.views.get(turn.owner)?.runtimeId !== turn.runtimeId) {
        released.push(this.remove(value.id))
      }
    }
    this.publish(turn.owner)
    await Promise.all(released)
    this.releaseActivity(turn.owner)
  }

  surface(turn: BrowserTurnPage): BrowserSurface {
    const closed = turn.closed.get(turn.surfaceId)
    if (closed) throw closed.reason
    const value = this.surfaces.get(turn.surfaceId)?.value
    if (!value) throw new Error('page_closed: 网页已关闭')
    return value
  }

  private page(runtimeId: string, pageId: string) {
    return [...this.surfaces.values()].find(s => s.value.runtimeId === runtimeId && s.value.page.id === pageId)?.value
  }
  private agentAncestor(value: BrowserSurface): boolean {
    for (let parent = value.parentId; parent;) {
      const source = this.surfaces.get(parent)?.value
      if (source?.turnId) return true
      parent = source?.parentId
    }
    return false
  }
  private create(owner: WebContents, runtimeId: string, page: BrowserSurface['page'], parentId?: string): BrowserSurface {
    const runtime = this.runtimes.get(runtimeId)!
    const ids = new Set([...runtime.pageIds,
      ...[...this.surfaces.values()].filter(s => s.value.runtimeId === runtimeId).map(s => s.value.page.id)])
    if (!ids.has(page.id) && ids.size >= runtime.maxBrowserPages) throw new Error('标签页已满，请先关闭部分标签')
    const value: BrowserSurface = { ...this.guests.acquire(owner), runtimeId, page: { ...page }, parentId, navigation: 0, audible: false }
    this.surfaces.set(value.id, { owner, value, abort: new AbortController() })
    return value
  }
  private remove(id: string, reason?: string): Promise<void> {
    const surface = this.surfaces.get(id)
    return surface ? this.guests.release(surface.owner, id, reason) : Promise.resolve()
  }
  private closed(id: string, reason: string): void {
    const surface = this.surfaces.get(id)
    if (!surface) return
    this.surfaces.delete(id)
    const error = new Error(reason)
    const turn = surface.value.turnId && this.turns.get(surface.value.turnId)
    if (turn) turn.closed.set(id, { url: surface.value.page.url, reason: error })
    surface.abort.abort(error)
    this.releaseActivity(surface.owner)
    this.publish(surface.owner)
  }
  private releaseActivity(owner: WebContents): void {
    if ([...this.surfaces.values()].some(surface => surface.owner === owner && surface.value.turnId)) return
    const throttling = this.ownerThrottling.get(owner)
    if (throttling === undefined) return
    this.ownerThrottling.delete(owner)
    if (!owner.isDestroyed()) owner.setBackgroundThrottling(throttling)
  }
  private visible(owner: WebContents): string | null {
    const view = this.views.get(owner)
    return view?.visible ? this.page(view.runtimeId, view.activePageId ?? '')?.id ?? null : null
  }
  private snapshot(owner: WebContents): BrowserHostState {
    return { revision: this.revision, surfaces: [...this.surfaces.values()].filter(s => s.owner === owner).map(s => s.value),
      sessions: [...this.runtimes].filter(([, r]) => r.owner === owner).map(([runtimeId, r]) => ({ runtimeId, sessionId: r.sessionId })),
      visibleId: this.visible(owner) }
  }
  private publish(owner: WebContents): void { this.revision++; if (!owner.isDestroyed()) owner.send(IPC.browserHostChanged, this.snapshot(owner)) }
  private requireOwner(event: Electron.IpcMainInvokeEvent): void {
    if (!BrowserWindow.fromWebContents(event.sender) || event.sender.getType() !== 'window'
      || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主页面可管理浏览器')
  }
}
