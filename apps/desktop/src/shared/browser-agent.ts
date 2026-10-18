import type { BrowserLease } from './browser.ts'

export interface BrowserPageDescriptor {
  id: string; url: string; title: string; workspaceFile?: boolean
}
export interface BrowserSurface extends BrowserLease {
  runtimeId: string
  page: BrowserPageDescriptor
  turnId?: string
  navigation: number
  audible: boolean
}
export interface BrowserAgentPage {
  runtimeId: string; turnId: string; surfaceId: string; page: BrowserPageDescriptor; view: 'user' | 'agent'
}
export interface BrowserHostState {
  revision: number
  surfaces: BrowserSurface[]
  agents: BrowserAgentPage[]
  visibleId: string | null
}
export interface BrowserViewRequest {
  runtimeId: string
  pages: BrowserPageDescriptor[]
  activePageId: string | null
  visible: boolean
}
export type BrowserViewAction =
  | { type: 'user'; runtimeId: string; page: BrowserPageDescriptor }
  | { type: 'switch'; runtimeId: string; view: 'agent' | 'user' }
  | { type: 'stop'; runtimeId: string }
  | { type: 'update'; id: string; url: string; title: string }

export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const
