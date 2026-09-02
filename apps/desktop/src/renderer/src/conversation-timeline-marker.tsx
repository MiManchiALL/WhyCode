import type { ReactNode } from 'react'

export type ConversationTimelineMarkerTone = 'neutral' | 'compact' | 'rollback'

const TONE_CLASSES: Record<ConversationTimelineMarkerTone, string> = {
  neutral: 'bg-[var(--wc-blue)] text-[var(--wc-blue-ink)]',
  compact: 'bg-[var(--wc-compact)] text-[var(--wc-compact-ink)]',
  rollback: 'bg-[var(--wc-rollback)] text-[var(--wc-rollback-ink)]',
}

export function ConversationTimelineMarker({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: ConversationTimelineMarkerTone
}) {
  return (
    <div
      className={`mb-3 rounded-xl px-3 py-2 text-xs ${TONE_CLASSES[tone]}`}
      data-conversation-timeline-marker={tone}
    >
      {children}
    </div>
  )
}
