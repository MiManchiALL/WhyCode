import type { WorkspaceBrowserPosition } from './workspace-browser-position.ts'
import type { ToolFileChange } from '@whycode/core/events'

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface ConversationScrollPosition {
  atBottom: boolean
  scrollTop: number
  anchor?: ConversationScrollAnchor
}

export interface ConversationScrollAnchor {
  sectionId: string
  blockId?: string
  contentIndex?: number
  offset: number
}

export const BOTTOM_THRESHOLD_PX = 60
const MAX_CACHED_CONVERSATIONS = 32
const MAX_BLOCK_PREFERENCES = 256
const MAX_FILE_CHANGE_ROWS = 256

export interface ConversationPresentation {
  expandedOverrides: Map<string, boolean>
  mermaidSources?: ReadonlySet<string>
  queuedMessagesCollapsed?: boolean
  scroll?: ConversationScrollPosition
  historyStart?: string
  workspacePosition?: WorkspaceBrowserPosition
  fileChanges?: Map<string, ToolFileChange[]>
}

export class ConversationPresentationCache {
  private readonly entries = new Map<string, ConversationPresentation>()

  get size(): number {
    return this.entries.size
  }

  get(key: string): ConversationPresentation | undefined {
    const value = this.entries.get(key)
    if (!value) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  saveScroll(key: string, scroll: ConversationScrollPosition, historyStart?: string): void {
    const previous = this.entries.get(key)
    this.set(key, {
      ...previous,
      expandedOverrides: previous?.expandedOverrides ?? new Map(),
      scroll,
      historyStart,
    })
  }

  saveWorkspacePosition(key: string, workspacePosition: WorkspaceBrowserPosition | undefined): void {
    const previous = this.entries.get(key)
    if (!previous && !workspacePosition) return
    this.set(key, { ...previous, expandedOverrides: previous?.expandedOverrides ?? new Map(), workspacePosition })
  }

  saveFileChanges(key: string, checkpoints: string, changes: ToolFileChange[]): void {
    // 一份摘要只含路径与增删行数。按会话限制总行数，空摘要也占一个位置。
    const previous = this.entries.get(key)
    const size = Math.max(1, changes.length)
    if (size > MAX_FILE_CHANGE_ROWS) return
    const summaries = previous?.fileChanges ?? new Map<string, ToolFileChange[]>()
    summaries.delete(checkpoints)
    summaries.set(checkpoints, changes)
    let total = 0
    for (const rows of summaries.values()) total += Math.max(1, rows.length)
    for (const [id, rows] of summaries) {
      if (total <= MAX_FILE_CHANGE_ROWS) break
      summaries.delete(id)
      total -= Math.max(1, rows.length)
    }
    this.set(key, { ...previous, expandedOverrides: previous?.expandedOverrides ?? new Map(), fileChanges: summaries })
  }

  setQueuedMessagesCollapsed(key: string, collapsed: boolean): void {
    const previous = this.entries.get(key)
    this.set(key, {
      ...previous,
      expandedOverrides: previous?.expandedOverrides ?? new Map(),
      queuedMessagesCollapsed: collapsed,
    })
  }

  setExpanded(key: string, id: string, expanded: boolean): void {
    const previous = this.entries.get(key)
    const expandedOverrides = new Map(previous?.expandedOverrides)
    expandedOverrides.delete(id)
    expandedOverrides.set(id, expanded)
    while (expandedOverrides.size > MAX_BLOCK_PREFERENCES) {
      const oldest = expandedOverrides.keys().next().value
      if (oldest === undefined) break
      expandedOverrides.delete(oldest)
    }
    this.set(key, { ...previous, expandedOverrides })
  }

  setMermaidSource(key: string, id: string, showSource: boolean): void {
    const previous = this.entries.get(key)
    if (!previous && !showSource) return
    const mermaidSources = new Set(previous?.mermaidSources)
    mermaidSources.delete(id)
    if (showSource) mermaidSources.add(id)
    while (mermaidSources.size > MAX_BLOCK_PREFERENCES) {
      mermaidSources.delete(mermaidSources.values().next().value!)
    }
    this.set(key, { ...previous, expandedOverrides: previous?.expandedOverrides ?? new Map(), mermaidSources })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  private set(key: string, value: ConversationPresentation): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

export function applyExpandedOverrides(
  defaults: ReadonlySet<string>,
  overrides: ReadonlyMap<string, boolean> | undefined,
): Set<string> {
  const expanded = new Set(defaults)
  if (!overrides) return expanded
  for (const [id, shouldExpand] of overrides) {
    shouldExpand ? expanded.add(id) : expanded.delete(id)
  }
  return expanded
}

export function captureScrollPosition(
  metrics: ScrollMetrics,
  anchor?: ConversationScrollAnchor,
): ConversationScrollPosition {
  const maximum = maximumScrollTop(metrics)
  const scrollTop = clamp(metrics.scrollTop, 0, maximum)
  return {
    atBottom: maximum - scrollTop < BOTTOM_THRESHOLD_PX,
    scrollTop,
    anchor,
  }
}

export function restoredAnchorScrollTop(
  anchorTop: number,
  offset: number,
  metrics: ScrollMetrics,
): number {
  return clamp(anchorTop + offset, 0, maximumScrollTop(metrics))
}

export function restoredScrollTop(
  position: ConversationScrollPosition,
  metrics: ScrollMetrics,
): number {
  const maximum = maximumScrollTop(metrics)
  return position.atBottom ? maximum : clamp(position.scrollTop, 0, maximum)
}

function maximumScrollTop(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
