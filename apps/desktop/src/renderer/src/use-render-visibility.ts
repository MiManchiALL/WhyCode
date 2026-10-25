import { useEffect, useState, type RefObject } from 'react'

const listeners = new Map<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | null = null

/** 富文本块共用一个观察器；离开可视区后释放高亮，保持原始文本的布局。 */
export function useRenderVisibility(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting)
    }, { rootMargin: '200px 0px' })
    listeners.set(element, setVisible)
    observer.observe(element)
    return () => {
      observer?.unobserve(element)
      listeners.delete(element)
      if (listeners.size === 0) {
        observer?.disconnect()
        observer = null
      }
    }
  }, [ref])
  return visible
}
