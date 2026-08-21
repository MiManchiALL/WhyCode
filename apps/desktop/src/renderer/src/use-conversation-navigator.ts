import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  clampConversationNavigationOffset,
  conversationNavigationIndexAtY,
  conversationNavigationWheelEnabled,
  conversationNavigationWaveIndexAtY,
  reconcileConversationNavigationOffset,
  type ConversationNavigationEntry,
} from './conversation-navigation.ts'
import { useConversationCurrentIndex } from './use-conversation-current-index.ts'

const WHEEL_SETTLE_MS = 120
const WHEEL_PIXELS_PER_ENTRY = 24
const ACTIVATED_MARKER_MS = 2_000

export function useConversationNavigator(
  entries: readonly ConversationNavigationEntry[],
  scrollRef: RefObject<HTMLElement | null>,
) {
  const railRef = useRef<HTMLDivElement>(null)
  const heightRef = useRef(0)
  const offsetRef = useRef(0)
  const previewIndexRef = useRef<number | null>(null)
  const pointerInsideRef = useRef(false)
  const manualOffsetRef = useRef(false)
  const pointerYRef = useRef<number | null>(null)
  const pendingPointerClientYRef = useRef<number | null>(null)
  const scrollingRef = useRef(false)
  const frozenWaveIndexRef = useRef<number | null>(null)
  const pointerFrameRef = useRef<number | null>(null)
  const wheelFrameRef = useRef<number | null>(null)
  const wheelSettleRef = useRef<number | null>(null)
  const activatedMarkerTimerRef = useRef<number | null>(null)
  const pendingWheelEntriesRef = useRef(0)

  const [height, setHeight] = useState(0)
  const [offset, setOffset] = useState(0)
  const currentIndex = useConversationCurrentIndex(entries, scrollRef)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const [scrolling, setScrolling] = useState(false)
  const [activatedEntryId, setActivatedEntryId] = useState<string | null>(null)

  const commitOffset = useCallback((next: number) => {
    offsetRef.current = next
    setOffset(next)
  }, [])
  const commitPreviewIndex = useCallback((next: number | null) => {
    previewIndexRef.current = next
    setPreviewIndex(next)
  }, [])

  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const measure = () => {
      const next = rail.getBoundingClientRect().height
      if (Math.abs(next - heightRef.current) < 0.5) return
      heightRef.current = next
      setHeight(next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(rail)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const maximumIndex = Math.max(0, entries.length - 1)
    const nextCurrent = Math.min(currentIndex, maximumIndex)
    if (previewIndexRef.current !== null && previewIndexRef.current > maximumIndex) {
      commitPreviewIndex(entries.length > 0 ? maximumIndex : null)
    }
    commitOffset(reconcileConversationNavigationOffset(
      offsetRef.current,
      nextCurrent,
      entries.length,
      heightRef.current,
      pointerInsideRef.current || manualOffsetRef.current,
    ))
  }, [commitOffset, commitPreviewIndex, currentIndex, entries.length, height])

  useEffect(() => () => {
    cancelFrame(pointerFrameRef)
    cancelFrame(wheelFrameRef)
    if (wheelSettleRef.current !== null) window.clearTimeout(wheelSettleRef.current)
    if (activatedMarkerTimerRef.current !== null) {
      window.clearTimeout(activatedMarkerTimerRef.current)
    }
  }, [])

  const activateEntry = useCallback((entryId: string) => {
    if (activatedMarkerTimerRef.current !== null) {
      window.clearTimeout(activatedMarkerTimerRef.current)
    }
    manualOffsetRef.current = true
    setActivatedEntryId(entryId)
    activatedMarkerTimerRef.current = window.setTimeout(() => {
      activatedMarkerTimerRef.current = null
      setActivatedEntryId(null)
    }, ACTIVATED_MARKER_MS)
  }, [])

  const updatePointer = useCallback((clientY: number, updatePreview: boolean) => {
    pendingPointerClientYRef.current = clientY
    if (pointerFrameRef.current !== null) return
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null
      const rail = railRef.current
      const nextClientY = pendingPointerClientYRef.current
      if (!rail || nextClientY === null || entries.length === 0) return
      const rectangle = rail.getBoundingClientRect()
      const y = Math.min(rectangle.height, Math.max(0, nextClientY - rectangle.top))
      const hitIndex = conversationNavigationIndexAtY(
        y,
        offsetRef.current,
        entries.length,
        heightRef.current,
      )
      if (hitIndex === null) {
        pointerYRef.current = null
        setPointerY(null)
        if (updatePreview && !scrollingRef.current) commitPreviewIndex(null)
        return
      }
      pointerYRef.current = y
      setPointerY(y)
      if (updatePreview && !scrollingRef.current) {
        commitPreviewIndex(hitIndex)
      }
    })
  }, [commitPreviewIndex, entries.length])

  const handlePointerEnter = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointerInsideRef.current = true
    setPointerInside(true)
    updatePointer(event.clientY, true)
  }, [updatePointer])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    updatePointer(event.clientY, !scrollingRef.current)
  }, [updatePointer])

  const finishWheelInteraction = useCallback(() => {
    scrollingRef.current = false
    frozenWaveIndexRef.current = null
    wheelSettleRef.current = null
    setScrolling(false)
  }, [])

  const handlePointerLeave = useCallback(() => {
    pointerInsideRef.current = false
    pointerYRef.current = null
    pendingPointerClientYRef.current = null
    pendingWheelEntriesRef.current = 0
    frozenWaveIndexRef.current = null
    scrollingRef.current = false
    cancelFrame(pointerFrameRef)
    cancelFrame(wheelFrameRef)
    if (wheelSettleRef.current !== null) {
      window.clearTimeout(wheelSettleRef.current)
      wheelSettleRef.current = null
    }
    setPointerInside(false)
    setPointerY(null)
    setScrolling(false)
    commitPreviewIndex(null)
    commitOffset(reconcileConversationNavigationOffset(
      offsetRef.current,
      currentIndex,
      entries.length,
      heightRef.current,
      manualOffsetRef.current,
    ))
  }, [commitOffset, commitPreviewIndex, currentIndex, entries.length])

  const handleWheel = useCallback((event: WheelEvent) => {
    if (!conversationNavigationWheelEnabled(
      pointerInsideRef.current,
      pointerYRef.current,
      entries.length,
      heightRef.current,
    )) return
    event.preventDefault()
    event.stopPropagation()
    manualOffsetRef.current = true
    const y = pointerYRef.current!
    if (!scrollingRef.current) {
      const hitIndex = conversationNavigationIndexAtY(
        y,
        offsetRef.current,
        entries.length,
        heightRef.current,
      )
      scrollingRef.current = true
      frozenWaveIndexRef.current = hitIndex === null
        ? null
        : conversationNavigationWaveIndexAtY(
            y,
            offsetRef.current,
            entries.length,
            heightRef.current,
          )
      setScrolling(true)
      if (previewIndexRef.current === null && hitIndex !== null) {
        commitPreviewIndex(hitIndex)
      }
    }
    pendingWheelEntriesRef.current += normalizedWheelPixels(event, heightRef.current)
      / WHEEL_PIXELS_PER_ENTRY
    if (wheelFrameRef.current === null) {
      wheelFrameRef.current = window.requestAnimationFrame(() => {
        wheelFrameRef.current = null
        const delta = pendingWheelEntriesRef.current
        pendingWheelEntriesRef.current = 0
        commitOffset(clampConversationNavigationOffset(
          offsetRef.current + delta,
          entries.length,
          heightRef.current,
        ))
      })
    }
    if (wheelSettleRef.current !== null) window.clearTimeout(wheelSettleRef.current)
    wheelSettleRef.current = window.setTimeout(finishWheelInteraction, WHEEL_SETTLE_MS)
  }, [commitOffset, commitPreviewIndex, entries.length, finishWheelInteraction])

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    rail.addEventListener('wheel', handleWheel, { passive: false })
    return () => rail.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const waveIndex = scrolling && frozenWaveIndexRef.current !== null
    ? frozenWaveIndexRef.current
    : pointerInside && pointerY !== null
      ? conversationNavigationWaveIndexAtY(pointerY, offset, entries.length, height)
      : null
  const highlightIndex = waveIndex === null ? null : Math.round(waveIndex)

  return {
    railRef,
    height,
    offset,
    previewIndex,
    activatedEntryId,
    pointerInside,
    waveIndex,
    highlightIndex,
    activateEntry,
    handlePointerEnter,
    handlePointerMove,
    handlePointerLeave,
  }
}

function normalizedWheelPixels(
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  height: number,
): number {
  if (event.deltaMode === 1) return event.deltaY * 16
  if (event.deltaMode === 2) return event.deltaY * height
  return event.deltaY
}

function cancelFrame(frame: { current: number | null }): void {
  if (frame.current === null) return
  window.cancelAnimationFrame(frame.current)
  frame.current = null
}
