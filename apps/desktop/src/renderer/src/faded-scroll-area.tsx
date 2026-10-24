import type { ReactNode } from 'react'
import { useScrollArea } from './use-scroll-area.ts'

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
  const { ref, fades, onScroll, overscrollBehaviorY } = useScrollArea(children, { followEnd })

  return (
    <div
      className="wc-scroll-fade relative"
      data-fade-top={fades.top ? 'true' : 'false'}
      data-fade-bottom={fades.bottom ? 'true' : 'false'}
    >
      <div ref={ref} id={id} className={`wc-scroll-fade-content ${className}`} onScroll={onScroll} style={{ overscrollBehaviorY }}>{children}</div>
    </div>
  )
}
