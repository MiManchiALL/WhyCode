import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { isNearScrollEnd, scrollAreaFades } from './scroll-fades.ts'
import { useScrollIntent } from './use-scroll-intent.ts'

export function useScrollArea(
  content: unknown,
  { followEnd = false, enabled = true }: { followEnd?: boolean; enabled?: boolean } = {},
) {
  const ref = useRef<HTMLDivElement>(null)
  const followingEndRef = useRef(followEnd)
  const [fades, setFades] = useState({ top: false, bottom: false })
  const recentlyScrolledAway = useScrollIntent(ref, () => { followingEndRef.current = false }, enabled && followEnd)

  const updateFades = useCallback(() => {
    const element = ref.current
    if (!element) return
    const next = scrollAreaFades(element)
    setFades((previous) => previous.top === next.top && previous.bottom === next.bottom
      ? previous
      : next)
  }, [])

  const followAndMeasure = useCallback(() => {
    const element = ref.current
    if (!element) return
    if (followEnd && followingEndRef.current) element.scrollTop = element.scrollHeight
    updateFades()
  }, [followEnd, updateFades])

  const handleScroll = useCallback(() => {
    const element = ref.current
    if (!element) return
    if (followEnd) {
      followingEndRef.current = isNearScrollEnd(element)
        && (!recentlyScrolledAway() || isNearScrollEnd(element, 1))
    }
    updateFades()
  }, [followEnd, recentlyScrolledAway, updateFades])

  useLayoutEffect(() => {
    if (enabled) followAndMeasure()
  }, [content, enabled, followAndMeasure])

  useLayoutEffect(() => {
    if (!enabled) return
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(followAndMeasure)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [enabled, followAndMeasure])

  return {
    ref,
    fades,
    onScroll: handleScroll,
    overscrollBehaviorY: enabled && (fades.top || fades.bottom) ? 'contain' as const : undefined,
  }
}
