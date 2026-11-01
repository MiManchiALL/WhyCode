/// <reference lib="dom" />

/** 捕获原生滚动，不接管滚轮和拖动；只为最近活动的容器持有计时器。 */
export function createScrollbarActivity(document: Document) {
  type Activity = { timer?: ReturnType<typeof setTimeout>; animation?: Animation }
  const pending = new Map<Element, Activity>()
  let hovered: Element | null = null
  const settle = (element: Element, entry: Activity) => {
    entry.timer = undefined
    if (element === hovered) return
    const active = getComputedStyle(element).getPropertyValue('--wc-scrollbar-thumb')
    element.setAttribute('data-wc-scrollbar', 'idle')
    if (!element.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) { pending.delete(element); return }
    // 独立动画不覆盖容器原有的 transition（侧栏、菜单和网页可能正在做自己的动画）。
    const idle = getComputedStyle(element).getPropertyValue('--wc-scrollbar-thumb')
    entry.animation = element.animate({ '--wc-scrollbar-thumb': [active, idle] }, { duration: 160, easing: 'ease-out' })
    entry.animation.onfinish = () => pending.delete(element)
  }
  const pulse = (element: Element) => {
    const previous = pending.get(element)
    clearTimeout(previous?.timer)
    previous?.animation?.cancel()
    if (element.getAttribute('data-wc-scrollbar') !== 'scrolling') element.setAttribute('data-wc-scrollbar', 'scrolling')
    const entry: Activity = {}
    pending.set(element, entry)
    entry.timer = setTimeout(() => settle(element, entry), 1000)
  }
  const onScroll = (event: Event) => {
    const element = event.target === document ? document.scrollingElement : event.target
    if (element instanceof Element) pulse(element)
  }
  const setHovered = (element: Element | null) => {
    if (hovered === element) return
    const previous = hovered
    hovered = element
    const entry = previous ? pending.get(previous) : undefined
    if (previous && entry && !entry.timer && !entry.animation) settle(previous, entry)
  }
  const onPointerMove = (event: PointerEvent) => {
    const target = event.target
    // 原生滚动槽的指针目标是容器自身；只测量已活动的容器，不扫描正文或跟踪滚轮。
    if (!(target instanceof HTMLElement) || !pending.has(target)) { setHovered(null); return }
    const viewport = target === document.scrollingElement
    const rect = target.getBoundingClientRect()
    const right = viewport ? innerWidth : rect.right, bottom = viewport ? innerHeight : rect.bottom
    const inVertical = target.scrollHeight > target.clientHeight && event.clientX >= right - 8
    const inHorizontal = target.scrollWidth > target.clientWidth && event.clientY >= bottom - 8
    setHovered(inVertical || inHorizontal ? target : null)
  }
  const onPointerOut = (event: PointerEvent) => { if (!event.relatedTarget) setHovered(null) }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('pointerout', onPointerOut, { passive: true })
  return {
    pulse,
    dispose() {
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerout', onPointerOut)
      hovered = null
      for (const [element, entry] of pending) {
        clearTimeout(entry.timer)
        entry.animation?.cancel()
        element.removeAttribute('data-wc-scrollbar')
      }
      pending.clear()
    },
  }
}
