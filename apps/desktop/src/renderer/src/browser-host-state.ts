import { useSyncExternalStore } from 'react'
import type { BrowserHostState, BrowserViewAction } from '../../shared/browser-agent.ts'
import type { RightPanelPage } from './right-panel-state.ts'

type Page = Extract<RightPanelPage, { kind: 'browser' }>
type Confirmation = { runtimeId: string; proceed: () => void } | null
let state: BrowserHostState = { revision: -1, surfaces: [], agents: [], visibleId: null }
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
  const agent = state.agents.find(agent => agent.runtimeId === runtimeId)
  const routed = agent ? { ...page, id: agent.page.id } : page
  await browserAction({ type: 'user', runtimeId, page: routed })
  return routed
}

/** 所有破坏 Agent 当前文档的用户导航/关闭共用这一处确认。 */
export function guardBrowserAction(runtimeId: string, pageId: string, proceed: () => void): void {
  const agent = state.agents.find(agent => agent.runtimeId === runtimeId && agent.page.id === pageId && agent.view === 'agent')
  if (!agent) { proceed(); return }
  confirmation = { runtimeId, proceed }; notify()
}
