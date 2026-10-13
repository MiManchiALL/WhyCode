import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import { IPC } from '../shared/ipc.ts'
import { browserAddress, browserDisplayUrl } from '../shared/browser.ts'
import type { BrowserAgentPage, BrowserHostState, BrowserSurface, BrowserViewAction, BrowserViewRequest } from '../shared/browser-agent.ts'
import type { BrowserGuests } from './browser-guests.ts'

const pageSchema = z.object({ id: z.string().max(100), url: z.string().max(1024 * 1024), title: z.string().max(256), workspaceFile: z.boolean().optional() })
const viewSchema = z.object({ runtimeId: z.string().max(100), pages: z.array(pageSchema).max(12), activePageId: z.string().nullable(), visible: z.boolean() })
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), runtimeId: z.string(), page: pageSchema }),
  z.object({ type: z.literal('switch'), runtimeId: z.string(), view: z.enum(['agent', 'user']) }),
  z.object({ type: z.literal('stop'), runtimeId: z.string() }),
  z.object({ type: z.literal('update'), id: z.string(), url: z.string().max(1024 * 1024), title: z.string().max(256) }),
])
interface Surface { owner: WebContents; value: BrowserSurface }
export interface BrowserTurnPage {
  owner: WebContents; runtimeId: string; turnId: string
  surfaceId: string; view: 'user' | 'agent'; abort: AbortController
}

/** 主进程管理物理网页；Renderer 只决定哪一个表面显示在侧栏槽位。 */
export class BrowserPages {
  private readonly surfaces = new Map<string, Surface>()
  private readonly views = new Map<WebContents, BrowserViewRequest>()
  private readonly owners = new Map<string, WebContents>()
  private readonly turns = new Map<string, BrowserTurnPage>()
  private revision = 0

  constructor(private readonly guests: BrowserGuests) {
    guests.onClosed = (id, reason) => this.closed(id, reason)
    guests.isAgent = id => !!this.surfaces.get(id)?.value.turnId
    guests.onOpen = (id, url) => {
      const turn = [...this.turns.values()].find(turn => turn.surfaceId === id && !turn.abort.signal.aborted)
      if (!turn) return false
      // 网页弹出的链接沿用当前 Agent 页，不能变成用户页并展开侧栏。
      void this.navigate(turn, browserDisplayUrl(url), turn.abort.signal).catch(error => {
        if (!turn.owner.isDestroyed()) turn.owner.send(IPC.browserEvent, { id, type: 'notice', error: true, message: String(error) })
      })
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
      for (const [id, current] of this.owners) if (current === owner) this.owners.delete(id)
    })
    this.views.set(owner, view)
    if (view.runtimeId) this.owners.set(view.runtimeId, owner)
    for (const [id, surface] of this.surfaces) {
      if (surface.owner !== owner || surface.value.turnId) continue
      if (surface.value.runtimeId !== view.runtimeId || !view.pages.some(page => page.id === surface.value.page.id)) this.remove(id)
    }
    const page = view.pages.find(page => page.id === view.activePageId)
    const agent = this.agent(view.runtimeId)
    if (page && view.visible && (!agent || agent.view === 'user' || this.surface(agent).page.id !== page.id)) {
      if (!this.userSurface(view.runtimeId, page.id)) this.create(owner, view.runtimeId, page)
    }
    this.publish(owner)
  }

  action(owner: WebContents, action: BrowserViewAction): void {
    if (action.type === 'update') {
      const surface = this.surfaces.get(action.id)
      if (surface?.owner !== owner) throw new Error('网页已关闭')
      surface.value.page = { ...surface.value.page, url: action.url, title: action.title }
    } else {
      if (this.owners.get(action.runtimeId) !== owner) throw new Error('网页不属于当前窗口')
      const agent = this.agent(action.runtimeId)
      if (action.type === 'stop') {
        if (agent) { agent.abort.abort(new Error('user_closed: 用户停止了 Agent 网页')); this.remove(agent.surfaceId) }
      } else if (action.type === 'switch') {
        if (!agent) throw new Error('本轮浏览器操作已结束')
        agent.view = action.view
        if (action.view === 'user' && !this.userSurface(action.runtimeId, this.surface(agent).page.id)) {
          this.create(owner, action.runtimeId, this.surface(agent).page)
        }
      } else {
        if (agent) agent.view = 'user'
        const page = { ...action.page, id: agent ? this.surface(agent).page.id : action.page.id, url: browserAddress(action.page.url) }
        const existing = this.userSurface(action.runtimeId, page.id)
        if (existing) {
          if (existing.page.url !== page.url) existing.navigation++
          existing.page = page
        }
        else this.create(owner, action.runtimeId, page)
      }
    }
    this.publish(owner)
  }

  list(runtimeId: string) {
    const owner = this.owners.get(runtimeId)
    const view = owner && this.views.get(owner)
    return [...this.surfaces.values()].filter(s => s.value.runtimeId === runtimeId).map(({ value }) => ({
      id: value.id, url: value.page.url, title: value.page.title, agent: !!value.turnId,
      active: view?.runtimeId === runtimeId && view.activePageId === value.page.id && this.visible(owner!) === value.id,
    }))
  }

  open(runtimeId: string, turnId: string, target: { id?: string; url?: string }): BrowserTurnPage {
    const current = this.turns.get(turnId)
    if (current) { current.abort.signal.throwIfAborted(); return current }
    const owner = this.owners.get(runtimeId)
    if (!owner || owner.isDestroyed()) throw new Error('会话窗口不可用')
    const url = target.url === undefined ? undefined : browserAddress(target.url)
    const candidates = this.list(runtimeId).filter(page => !page.agent && (!target.id || page.id === target.id)
      && (!url || page.url === url))
    const candidate = candidates.find(page => page.active) ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (target.id && !candidate) throw new Error('指定页面已关闭或与网址不符，请重新列出网页')
    if (!candidate && candidates.length > 1) throw new Error('有多个匹配页面，请从 browser.tabs() 中选择 id')
    if (!candidate && !url) throw new Error('没有可用网页，请提供 url')
    const value = candidate ? this.surfaces.get(candidate.id)!.value
      : this.create(owner, runtimeId, { id: randomUUID(), url: url!, title: '', workspaceFile: url!.startsWith('file:') })
    value.turnId = turnId
    const turn: BrowserTurnPage = { owner, runtimeId, turnId, surfaceId: value.id, view: 'agent', abort: new AbortController() }
    this.turns.set(turnId, turn)
    this.guests.get(value.id)?.setBackgroundThrottling(false)
    this.publish(owner)
    return turn
  }

  current(turnId: string): BrowserTurnPage {
    const turn = this.turns.get(turnId)
    if (!turn) throw new Error('先调用 browser.open() 选择网页')
    turn.abort.signal.throwIfAborted()
    return turn
  }

  async guest(turn: BrowserTurnPage, signal: AbortSignal): Promise<WebContents> {
    for (let count = 0; count < 200; count++) {
      signal.throwIfAborted(); turn.abort.signal.throwIfAborted()
      const guest = this.guests.get(turn.surfaceId)
      if (guest && !guest.isLoading() && !guest.getURL().startsWith('about:blank#')) return guest
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
    throw new Error('网页尚未准备好，请重试 browser.snapshot()')
  }

  async navigate(turn: BrowserTurnPage, url: string, signal: AbortSignal): Promise<void> {
    const value = this.surface(turn)
    const guest = this.guests.get(value.id)
    if (!guest) throw new Error('网页尚未准备好')
    const address = browserAddress(url)
    const target = await this.guests.prepare(value.id, address, address.startsWith('file:') ? turn.runtimeId : undefined)
    signal.throwIfAborted(); turn.abort.signal.throwIfAborted()
    value.page = { ...value.page, url: address, workspaceFile: address.startsWith('file:') }
    this.publish(turn.owner)
    await guest.loadURL(target)
  }

  finish(turnId: string): void {
    const turn = this.turns.get(turnId)
    if (!turn) return
    const value = this.surfaces.get(turn.surfaceId)?.value
    const visible = this.visible(turn.owner) === turn.surfaceId
    this.turns.delete(turnId)
    turn.abort.abort(new Error('turn_ended: 本轮浏览器操作已结束'))
    if (value && visible) {
      const previous = this.userSurface(turn.runtimeId, value.page.id)
      if (previous) this.remove(previous.id)
      delete value.turnId
      this.guests.get(value.id)?.setBackgroundThrottling(true)
    } else this.remove(turn.surfaceId)
    this.publish(turn.owner)
  }

  surface(turn: BrowserTurnPage): BrowserSurface {
    const value = this.surfaces.get(turn.surfaceId)?.value
    if (!value) throw new Error('Agent 网页已关闭')
    return value
  }

  private agent(runtimeId: string) { return [...this.turns.values()].find(turn => turn.runtimeId === runtimeId && !turn.abort.signal.aborted) }
  private userSurface(runtimeId: string, pageId: string) {
    return [...this.surfaces.values()].find(s => s.value.runtimeId === runtimeId && s.value.page.id === pageId && !s.value.turnId)?.value
  }
  private create(owner: WebContents, runtimeId: string, page: BrowserSurface['page']): BrowserSurface {
    const value: BrowserSurface = { ...this.guests.acquire(owner), runtimeId, page: { ...page }, navigation: 0 }
    this.surfaces.set(value.id, { owner, value })
    return value
  }
  private remove(id: string): void {
    const surface = this.surfaces.get(id)
    if (!surface) return
    this.surfaces.delete(id)
    this.guests.release(surface.owner, id)
  }
  private closed(id: string, reason: string): void {
    const surface = this.surfaces.get(id)
    this.surfaces.delete(id)
    for (const turn of this.turns.values()) if (turn.surfaceId === id) turn.abort.abort(new Error(reason))
    if (surface) this.publish(surface.owner)
  }
  private visible(owner: WebContents): string | null {
    const view = this.views.get(owner)
    if (!view?.visible) return null
    const agent = this.agent(view.runtimeId)
    if (agent?.view === 'agent' && this.surface(agent).page.id === view.activePageId) return agent.surfaceId
    return this.userSurface(view.runtimeId, view.activePageId ?? '')?.id ?? null
  }
  private snapshot(owner: WebContents): BrowserHostState {
    const agents: BrowserAgentPage[] = [...this.turns.values()].filter(t => t.owner === owner && !t.abort.signal.aborted)
      .map(t => ({ runtimeId: t.runtimeId, turnId: t.turnId, surfaceId: t.surfaceId, page: this.surface(t).page, view: t.view }))
    return { revision: this.revision, surfaces: [...this.surfaces.values()].filter(s => s.owner === owner).map(s => s.value), agents, visibleId: this.visible(owner) }
  }
  private publish(owner: WebContents): void { this.revision++; if (!owner.isDestroyed()) owner.send(IPC.browserHostChanged, this.snapshot(owner)) }
  private requireOwner(event: Electron.IpcMainInvokeEvent): void {
    if (!BrowserWindow.fromWebContents(event.sender) || event.sender.getType() !== 'window'
      || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主页面可管理浏览器')
  }
}
