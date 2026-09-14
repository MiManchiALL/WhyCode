import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { ConversationNavigationEntry } from '../../shared/conversation-navigation.ts'

const NAVIGATION_TARGET_SELECTOR = '[data-conversation-navigator-target]'
const NAVIGATION_SECTION_SELECTOR = '[data-conversation-navigator-section]'

interface NavigationAnchor {
  entryIndex: number
  element: HTMLElement
}

/** 用工作段做二分定位；只在当前段内检查少量用户插话节点。 */
export function useConversationCurrentIndex(
  entries: readonly ConversationNavigationEntry[],
  navigationTargetIds: ReadonlyMap<string, string>,
  scrollRef: RefObject<HTMLElement | null>,
): number {
  const anchorsRef = useRef<NavigationAnchor[]>([])
  const entryIndexesRef = useRef<ReadonlyMap<string, number>>(new Map())
  const frameRef = useRef<number | null>(null)
  const [currentIndex, setCurrentIndex] = useState(() => Math.max(0, entries.length - 1))

  const update = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller || entries.length === 0) return
    // 延迟提交会替换正文 DOM；导航索引只能复用仍连接在当前视口的节点。
    if (!anchorsRef.current[0]?.element.isConnected) {
      anchorsRef.current = collectNavigationAnchors(scroller, entryIndexesRef.current)
    }
    const anchors = anchorsRef.current
    if (anchors.length === 0) return
    const viewportTop = scroller.getBoundingClientRect().top + 24
    let low = 0
    let high = anchors.length - 1
    let selected = anchors[0]!
    while (low <= high) {
      const middle = (low + high) >> 1
      const candidate = anchors[middle]!
      if (candidate.element.getBoundingClientRect().top <= viewportTop) {
        selected = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    let selectedIndex = selected.entryIndex
    if (selected.element.matches(NAVIGATION_SECTION_SELECTOR)) {
      for (const target of selected.element.querySelectorAll<HTMLElement>(
        NAVIGATION_TARGET_SELECTOR,
      )) {
        if (target.getBoundingClientRect().top > viewportTop) break
        const id = target.dataset.conversationNavigatorTarget
        const entryIndex = id === undefined ? undefined : entryIndexesRef.current.get(id)
        if (entryIndex !== undefined) selectedIndex = entryIndex
      }
    }
    setCurrentIndex((previous) => previous === selectedIndex ? previous : selectedIndex)
  }, [entries.length, scrollRef])

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const entryIndexes = new Map<string, number>()
    for (const [index, entry] of entries.entries()) {
      const targetId = navigationTargetIds.get(entry.id) ?? entry.id
      if (!entryIndexes.has(targetId)) entryIndexes.set(targetId, index)
    }
    entryIndexesRef.current = entryIndexes
    if (!scroller) {
      anchorsRef.current = []
      return
    }
    anchorsRef.current = collectNavigationAnchors(scroller, entryIndexes)
    setCurrentIndex((previous) => Math.min(previous, Math.max(0, entries.length - 1)))
    update()
  }, [entries, navigationTargetIds, scrollRef, update])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const requestUpdate = () => {
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        update()
      })
    }
    requestUpdate()
    scroller.addEventListener('scroll', requestUpdate, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', requestUpdate)
      cancelFrame(frameRef)
    }
  }, [scrollRef, update])

  useEffect(() => () => cancelFrame(frameRef), [])
  return currentIndex
}

function collectNavigationAnchors(
  scroller: HTMLElement,
  entryIndexes: ReadonlyMap<string, number>,
): NavigationAnchor[] {
  const anchors: NavigationAnchor[] = []
  const occupied = new Set<number>()
  for (const section of scroller.querySelectorAll<HTMLElement>(NAVIGATION_SECTION_SELECTOR)) {
    const id = section.dataset.conversationNavigatorSection
    const entryIndex = id === undefined ? undefined : entryIndexes.get(id)
    if (entryIndex === undefined) continue
    anchors.push({ entryIndex, element: section })
    occupied.add(entryIndex)
  }
  for (const target of scroller.querySelectorAll<HTMLElement>(NAVIGATION_TARGET_SELECTOR)) {
    if (target.closest(NAVIGATION_SECTION_SELECTOR)) continue
    const id = target.dataset.conversationNavigatorTarget
    const entryIndex = id === undefined ? undefined : entryIndexes.get(id)
    if (entryIndex === undefined || occupied.has(entryIndex)) continue
    anchors.push({ entryIndex, element: target })
  }
  anchors.sort((left, right) => left.entryIndex - right.entryIndex)
  return anchors
}

function cancelFrame(frame: { current: number | null }): void {
  if (frame.current === null) return
  window.cancelAnimationFrame(frame.current)
  frame.current = null
}
