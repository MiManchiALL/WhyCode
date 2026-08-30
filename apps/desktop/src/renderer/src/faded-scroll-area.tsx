import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { isNearScrollEnd, scrollAreaFades } from './scroll-fades.ts'

export function FadedScrollArea({
  id,
  className,
  children,
  followEnd = false,
}: {
  id?: string
  className: string
  children: ReactNode
  followEnd?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const followingEndRef = useRef(followEnd)
  const [fades, setFades] = useState({ top: false, bottom: false })

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
    if (followEnd) followingEndRef.current = isNearScrollEnd(element)
    updateFades()
  }, [followEnd, updateFades])

  useLayoutEffect(() => {
    followAndMeasure()
  }, [children, followAndMeasure])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(followAndMeasure)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [followAndMeasure])

  return (
    <div
      className="wc-scroll-fade relative"
      data-fade-top={fades.top ? 'true' : 'false'}
      data-fade-bottom={fades.bottom ? 'true' : 'false'}
    >
      <div ref={ref} id={id} className={className} onScroll={handleScroll}>{children}</div>
      <span aria-hidden="true" className="wc-scroll-fade-top" />
      <span aria-hidden="true" className="wc-scroll-fade-bottom" />
    </div>
  )
}
