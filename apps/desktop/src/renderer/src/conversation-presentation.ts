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

const BOTTOM_THRESHOLD_PX = 60
const MAX_CACHED_CONVERSATIONS = 32
const MAX_EXPANDED_OVERRIDES = 256

interface ConversationPresentation {
  expandedOverrides: Map<string, boolean>
  scroll?: ConversationScrollPosition
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

  saveScroll(key: string, scroll: ConversationScrollPosition): void {
    const previous = this.entries.get(key)
    this.set(key, {
      expandedOverrides: previous?.expandedOverrides ?? new Map(),
      scroll,
    })
  }

  setExpanded(key: string, id: string, expanded: boolean): void {
    const previous = this.entries.get(key)
    const expandedOverrides = new Map(previous?.expandedOverrides)
    expandedOverrides.delete(id)
    expandedOverrides.set(id, expanded)
    while (expandedOverrides.size > MAX_EXPANDED_OVERRIDES) {
      const oldest = expandedOverrides.keys().next().value
      if (oldest === undefined) break
      expandedOverrides.delete(oldest)
    }
    this.set(key, { ...previous, expandedOverrides })
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
