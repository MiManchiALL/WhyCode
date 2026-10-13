import { useLayoutEffect, useRef, useState } from 'react'

/** Portal 只映射侧栏槽位；祖先过渡期间同步坐标，结束后停止取样。 */
export function useBrowserBounds(active: boolean) {
  const anchor = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ left: 0, top: 0, width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = anchor.current
    if (!element) return
    let frame = 0
    const transitions = new Set<string>()
    const measure = () => {
      const { left, top, width, height } = element.getBoundingClientRect()
      setBounds(current => current.left === left && current.top === top && current.width === width && current.height === height
        ? current : { left, top, width, height })
    }
    const sample = () => { measure(); frame = transitions.size ? requestAnimationFrame(sample) : 0 }
    const transition = (event: TransitionEvent) => {
      if (!(event.target instanceof Element) || !event.target.contains(element)) return
      if (event.type === 'transitionrun') transitions.add(event.propertyName)
      else transitions.delete(event.propertyName)
      if (!frame) sample()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    for (const name of ['transitionrun', 'transitionend', 'transitioncancel'] as const) document.addEventListener(name, transition, true)
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', measure)
      for (const name of ['transitionrun', 'transitionend', 'transitioncancel'] as const) document.removeEventListener(name, transition, true)
    }
  }, [active])
  return { anchor, bounds }
}
