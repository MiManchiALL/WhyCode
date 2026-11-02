import { useSyncExternalStore } from 'react'
import type { BrowserHostState, BrowserViewAction } from '../../shared/browser-agent.ts'
import type { RightPanelPage } from './right-panel-state.ts'

type Page = Extract<RightPanelPage, { kind: 'browser' }>
type Confirmation = { runtimeId: string; pageId: string; proceed: () => void } | null
let state: BrowserHostState = { revision: -1, surfaces: [], sessions: [], visibleId: null }
let confirmation: Confirmation = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const notify = () => { for (const listener of listeners) listener() }

export function updateBrowserHost(value: BrowserHostState): void {
  if (value.revision <= state.revision) return
  state = value; notify()
}
export function useBrowserHostState() { return useSyncExternalStore(subscribe, () => state) }
export function useBrowserConfirmation() { return useSyncExternalStore(subscribe, () => confirmation) }
export function dismissBrowserConfirmation(): void { confirmation = null; notify() }
export function completeBrowserConfirmation(pending: NonNullable<Confirmation>): void {
  if (confirmation !== pending) return
  dismissBrowserConfirmation(); pending.proceed()
}
export function browserAction(action: BrowserViewAction): Promise<void> {
  return window.whycode.browserViewAction(action).then(updateBrowserHost)
}

export async function routeBrowserPage(runtimeId: string, page: Page): Promise<Page> {
  await browserAction({ type: 'user', runtimeId, page })
  return page
}

/** 所有破坏 Agent 当前文档的用户导航/关闭共用这一处确认。 */
export function guardBrowserAction(runtimeId: string, pageId: string, action: 'close' | 'navigate', proceed: () => void, fail: (error: unknown) => void): void {
  const agent = state.surfaces.find(page => page.runtimeId === runtimeId && page.page.id === pageId && page.turnId)
  if (!agent) {
    if (action === 'close') void browserAction({ type: 'stop', runtimeId, pageId }).then(proceed, fail)
    else proceed()
    return
  }
  confirmation = { runtimeId, pageId, proceed }; notify()
}
