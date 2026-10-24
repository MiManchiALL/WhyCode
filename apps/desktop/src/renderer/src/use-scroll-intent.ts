import { useCallback, useEffect, useEffectEvent, useRef, type RefObject } from 'react'

const SCROLL_INTENT_COOLDOWN_MS = 150

/** 在原生滚动发生前释放贴底，避免同一帧的新内容抢先改写 scrollTop。 */
export function useScrollIntent(
  ref: RefObject<HTMLElement | null>,
  onScrollAway: () => void,
  enabled = true,
) {
  const lastIntent = useRef(-Infinity)
  const release = useEffectEvent(() => { lastIntent.current = performance.now(); onScrollAway() })

  useEffect(() => {
    lastIntent.current = -Infinity
    const scroller = ref.current
    if (!enabled || !scroller) return
    let touchY: number | undefined
    const belongsToScroller = (target: EventTarget | null) => {
      if (scroller.scrollTop <= 0) return false
      for (let node = target instanceof Element ? target : null; node && node !== scroller; node = node.parentElement) {
        if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight) continue
        const style = getComputedStyle(node)
        if (/^(auto|scroll)$/.test(style.overflowY)
          && (node.scrollTop > 0 || /^(contain|none)$/.test(style.overscrollBehaviorY))) return false
      }
      return true
    }
    const wheel = (event: WheelEvent) => {
      if (!event.defaultPrevented && !event.ctrlKey && event.deltaY < 0 && belongsToScroller(event.target)) release()
    }
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, button, [contenteditable="true"], [role="slider"], [role="listbox"], [role="menu"], [role="tree"]')) return
      if ((['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) && belongsToScroller(event.target)) release()
    }
    const touchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0]?.clientY : undefined }
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches.length === 1 ? event.touches[0]?.clientY : undefined
      if (touchY !== undefined && nextY !== undefined && nextY > touchY && belongsToScroller(event.target)) release()
      touchY = nextY
    }
    scroller.addEventListener('wheel', wheel, { passive: true })
    scroller.addEventListener('keydown', key)
    scroller.addEventListener('touchstart', touchStart, { passive: true })
    scroller.addEventListener('touchmove', touchMove, { passive: true })
    return () => {
      scroller.removeEventListener('wheel', wheel)
      scroller.removeEventListener('keydown', key)
      scroller.removeEventListener('touchstart', touchStart)
      scroller.removeEventListener('touchmove', touchMove)
    }
  }, [enabled, ref])

  return useCallback(() => performance.now() - lastIntent.current < SCROLL_INTENT_COOLDOWN_MS, [])
}
