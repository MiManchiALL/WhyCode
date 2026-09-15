import { filePathKey } from './local-files.ts'
import type { TerminalInfo } from '../../shared/terminal.ts'

export type FilePreviewToolName = 'WriteFile' | 'EditFile' | 'DeleteFile' | 'MoveFile'

export type RightPanelFileSource =
  | {
      kind: 'snapshot'
      toolUseId: string
      toolName: FilePreviewToolName
    }
  | { kind: 'current' }

export type RightPanelPage =
  | { kind: 'terminal'; terminal: TerminalInfo }
  | { kind: 'workspace'; expanded: string[] }
  | { kind: 'subagent-overview' }
  | { kind: 'subagent-transcript'; subagentId: string }
  | {
      kind: 'file'
      path: string
      name: string
      source: RightPanelFileSource
      wrap?: boolean
      previewMode?: 'preview' | 'code'
    }

export interface RightPanelTab {
  id: string
  page: RightPanelPage
}

export type TaskInspectorView = 'plan' | 'skills'

export interface RightPanelSessionState {
  inspectorView: TaskInspectorView
  open: boolean
  tabs: RightPanelTab[]
  activeTabId: string | null
}

interface StoredRightPanelState extends RightPanelSessionState {
  key: string
}

interface KeyValueStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const STORAGE_KEY = 'whycode:right-panel-sessions:v1'
const MAX_STORED_SESSIONS = 200
export const MAX_RIGHT_PANEL_TABS = 12
const DEFAULT_STATE: RightPanelSessionState = {
  inspectorView: 'plan',
  open: false,
  tabs: [],
  activeTabId: null,
}

export class RightPanelSessionStore {
  private readonly states = new Map<string, RightPanelSessionState>()
  private readonly storage: KeyValueStorage | null

  constructor(storage: KeyValueStorage | null = browserStorage()) {
    this.storage = storage
    if (!storage) return
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]')
      if (!Array.isArray(parsed)) return
      for (const value of parsed.slice(-MAX_STORED_SESSIONS)) {
        const state = parseStoredState(value)
        if (state) this.states.set(state.key, stateValue(state))
      }
    } catch {
      // 无效或不可用的 Renderer 存储只丢弃界面偏好，不影响会话事实。
    }
  }

  get(key: string): RightPanelSessionState {
    const state = this.states.get(key)
    return state ? structuredClone(state) : structuredClone(DEFAULT_STATE)
  }

  set(key: string, state: RightPanelSessionState): void {
    this.states.delete(key)
    if (state.open || state.tabs.length > 0 || state.inspectorView === 'skills') {
      this.states.set(key, structuredClone(state))
    }
    this.trimAndPersist()
  }

  move(sourceKey: string, targetKey: string): RightPanelSessionState {
    const target = this.states.get(targetKey)
    const source = this.states.get(sourceKey)
    this.states.delete(sourceKey)
    if (!target && source) this.states.set(targetKey, source)
    this.trimAndPersist()
    return this.get(targetKey)
  }

  delete(key: string): void {
    if (!this.states.delete(key)) return
    this.persist()
  }

  removeTerminal(terminalId: string): void {
    for (const [key, state] of this.states) {
      const tab = state.tabs.find((item) => item.page.kind === 'terminal'
        && item.page.terminal.id === terminalId)
      if (tab) this.states.set(key, closeRightPanelTab(state, tab.id))
    }
    this.persist()
  }

  private trimAndPersist(): void {
    while (this.states.size > MAX_STORED_SESSIONS) {
      const oldest = [...this.states].find(([, state]) =>
        !state.tabs.some((tab) => tab.page.kind === 'terminal'))?.[0]
      if (oldest === undefined) break
      this.states.delete(oldest)
    }
    this.persist()
  }

  private persist(): void {
    if (!this.storage) return
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(
        [...this.states].map(([key, state]) => {
          const tabs = state.tabs.filter((tab) => tab.page.kind !== 'terminal')
          return {
            key, open: state.open, tabs, inspectorView: state.inspectorView,
            activeTabId: tabs.some((tab) => tab.id === state.activeTabId)
              ? state.activeTabId : (tabs.at(-1)?.id ?? null),
          }
        }),
      ))
    } catch {
      // 当前进程仍保留偏好；磁盘不可用不应打断主界面。
    }
  }
}

export function rightPanelSessionKey(runtimeId: string, sessionId: string | null): string {
  return sessionId ?? `runtime:${runtimeId}`
}

export function activeRightPanelPage(state: RightPanelSessionState): RightPanelPage | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId)?.page ?? null
}

export function openRightPanelPage(
  state: RightPanelSessionState,
  page: RightPanelPage,
): RightPanelSessionState {
  const id = rightPanelTabId(page)
  const tabs = state.tabs.slice()
  const existingIndex = tabs.findIndex((tab) => tab.id === id)
  const tab = { id, page }
  if (existingIndex >= 0) {
    const existing = tabs[existingIndex]!.page
    tabs[existingIndex] = page.kind === 'file' && existing.kind === 'file'
      ? { id, page: { ...existing, ...page } } : tab
  } else {
    if (tabs.length >= MAX_RIGHT_PANEL_TABS) {
      const discardIndex = tabs.findIndex((candidate) => candidate.page.kind !== 'terminal'
        && candidate.id !== state.activeTabId)
      const replacement = discardIndex >= 0 ? discardIndex
        : tabs.findIndex((candidate) => candidate.page.kind !== 'terminal')
      if (replacement < 0) return state
      tabs.splice(replacement, 1)
    }
    tabs.push(tab)
  }
  return { ...state, open: true, tabs, activeTabId: id }
}

export function selectRightPanelTab(
  state: RightPanelSessionState,
  tabId: string,
): RightPanelSessionState {
  return state.tabs.some((tab) => tab.id === tabId)
    ? { ...state, activeTabId: tabId }
    : state
}

export function closeRightPanelTab(
  state: RightPanelSessionState,
  tabId: string,
): RightPanelSessionState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return state
  const tabs = state.tabs.filter((tab) => tab.id !== tabId)
  if (state.activeTabId !== tabId) return { ...state, tabs }
  const replacement = tabs[Math.min(index, tabs.length - 1)] ?? null
  return { ...state, tabs, activeTabId: replacement?.id ?? null }
}

export function rightPanelTabId(page: RightPanelPage): string {
  switch (page.kind) {
    case 'workspace':
      return 'workspace'
    case 'terminal':
      return `terminal:${page.terminal.id}`
    case 'file':
      return `file:${filePathKey(page.path)}`
    case 'subagent-overview':
    case 'subagent-transcript':
      return 'subagents'
    default:
      return assertNever(page)
  }
}

function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

function parseStoredState(value: unknown): StoredRightPanelState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    (record.inspectorView !== 'plan' && record.inspectorView !== 'skills')
    || typeof record.key !== 'string'
    || typeof record.open !== 'boolean'
    || !Array.isArray(record.tabs)
  ) return null

  const tabs: RightPanelTab[] = []
  for (const value of record.tabs.slice(-MAX_RIGHT_PANEL_TABS)) {
    const page = parseTabPage(value)
    if (!page) continue
    const id = rightPanelTabId(page)
    const duplicate = tabs.findIndex((tab) => tab.id === id)
    if (duplicate >= 0) tabs.splice(duplicate, 1)
    tabs.push({ id, page })
  }
  const requestedActiveId = typeof record.activeTabId === 'string'
    ? record.activeTabId
    : null
  const activeTabId = tabs.some((tab) => tab.id === requestedActiveId)
    ? requestedActiveId
    : (tabs.at(-1)?.id ?? null)
  return { key: record.key, open: record.open, tabs, activeTabId, inspectorView: record.inspectorView }
}

function parseTabPage(value: unknown): RightPanelPage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const tab = value as Record<string, unknown>
  return parsePage(tab.page)
}

function parsePage(value: unknown): RightPanelPage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const page = value as Record<string, unknown>
  if (page.kind === 'workspace' && Array.isArray(page.expanded) && page.expanded.every(path => typeof path === 'string')) {
    return { kind: page.kind, expanded: page.expanded.slice(0, 63) }
  }
  if (page.kind === 'subagent-overview') return { kind: page.kind }
  if (page.kind === 'subagent-transcript' && typeof page.subagentId === 'string') {
    return { kind: page.kind, subagentId: page.subagentId }
  }
  if (
    page.kind === 'file'
    && typeof page.path === 'string'
    && typeof page.name === 'string'
  ) {
    const source = parseFileSource(page.source)
    if (page.wrap !== undefined && typeof page.wrap !== 'boolean') return null
    if (page.previewMode !== undefined && page.previewMode !== 'preview' && page.previewMode !== 'code') return null
    return source ? { kind: page.kind, path: page.path, name: page.name, source, ...(page.wrap === undefined ? {} : { wrap: page.wrap }), ...(page.previewMode === undefined ? {} : { previewMode: page.previewMode }) } : null
  }
  return null
}

function parseFileSource(value: unknown): RightPanelFileSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (source.kind === 'current') return { kind: source.kind }
  if (
    source.kind === 'snapshot'
    && typeof source.toolUseId === 'string'
    && isFilePreviewToolName(source.toolName)
  ) {
    return {
      kind: source.kind,
      toolUseId: source.toolUseId,
      toolName: source.toolName,
    }
  }
  return null
}

function stateValue(state: StoredRightPanelState): RightPanelSessionState {
  return {
    open: state.open,
    inspectorView: state.inspectorView,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
  }
}

function assertNever(value: never): never {
  throw new Error(`未知的右侧栏页面：${JSON.stringify(value)}`)
}

export function isFilePreviewToolName(value: unknown): value is FilePreviewToolName {
  return value === 'WriteFile'
    || value === 'EditFile'
    || value === 'DeleteFile'
    || value === 'MoveFile'
}
