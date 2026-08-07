import type { ReactNode } from 'react'

interface PaperFrameProps {
  children: ReactNode
  className?: string
}

export function PaperFrame({ children, className }: PaperFrameProps) {
  return (
    <div className={`wc-paper-frame${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}
