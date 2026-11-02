import type { BrowserLease } from './browser.ts'

export interface BrowserPageDescriptor {
  id: string; url: string; title: string; workspaceFile?: boolean
}
export interface BrowserSurface extends BrowserLease {
  runtimeId: string
  page: BrowserPageDescriptor
  turnId?: string
  parentId?: string
  navigation: number
  audible: boolean
}
export interface BrowserHostState {
  revision: number
  surfaces: BrowserSurface[]
  sessions: { runtimeId: string; sessionId: string | null }[]
  visibleId: string | null
}
export interface BrowserViewRequest {
  runtimeId: string
  sessionId: string | null
  pages: BrowserPageDescriptor[]
  maxBrowserPages: number
  activePageId: string | null
  visible: boolean
}
export type BrowserViewAction =
  | { type: 'user'; runtimeId: string; page: BrowserPageDescriptor }
  | { type: 'stop'; runtimeId: string; pageId: string }
  | { type: 'update'; id: string; url: string; title: string }

export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const
