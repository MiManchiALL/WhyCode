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
      <div ref={ref} id={id} className={className} onScroll={onScroll} style={{ overscrollBehaviorY }}>{children}</div>
      <span aria-hidden="true" className="wc-scroll-fade-top" />
      <span aria-hidden="true" className="wc-scroll-fade-bottom" />
    </div>
  )
}
