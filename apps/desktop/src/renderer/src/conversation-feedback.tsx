import { createPortal } from 'react-dom'
import { CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  expireConversationFeedback,
  holdConversationFeedback,
  releaseConversationFeedback,
  type ConversationFeedbackPhase,
  type ConversationFeedback,
} from './conversation-feedback-state.ts'

const VISIBLE_MS = 3_000
const EXIT_MS = 680

export const ConversationFeedbackContext = createContext<(
  (tone: ConversationFeedback['tone'], message: string) => void
) | null>(null)

export function useConversationFeedback() {
  const feedback = useContext(ConversationFeedbackContext)
  if (!feedback) throw new Error('Conversation feedback requires an application provider')
  return feedback
}

export function ConversationFeedbackToast({
  feedback,
  onDismiss,
  floating = false,
}: {
  feedback: ConversationFeedback
  floating?: boolean
  onDismiss: (id: number) => void
}) {
  const [phase, setPhase] = useState<ConversationFeedbackPhase>('visible')
  const visibleTimerRef = useRef<number | null>(null)
  const exitTimerRef = useRef<number | null>(null)

  const clearVisibleTimer = useCallback(() => {
    if (visibleTimerRef.current === null) return
    window.clearTimeout(visibleTimerRef.current)
    visibleTimerRef.current = null
  }, [])
  const expire = useCallback(() => {
    clearVisibleTimer()
    setPhase(expireConversationFeedback)
  }, [clearVisibleTimer])

  useEffect(() => {
    setPhase('visible')
    clearVisibleTimer()
    visibleTimerRef.current = window.setTimeout(expire, VISIBLE_MS)
    return () => {
      clearVisibleTimer()
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
    }
  }, [clearVisibleTimer, expire, feedback.id])

  useEffect(() => {
    if (phase !== 'exiting') return
    exitTimerRef.current = window.setTimeout(() => onDismiss(feedback.id), EXIT_MS)
    return () => {
      if (exitTimerRef.current === null) return
      window.clearTimeout(exitTimerRef.current)
      exitTimerRef.current = null
    }
  }, [feedback.id, onDismiss, phase])

  const hold = () => {
    setPhase((current) => {
      const next = holdConversationFeedback(current)
      if (next === 'held' && current !== 'held') clearVisibleTimer()
      return next
    })
  }

  const release = () => {
    setPhase(releaseConversationFeedback)
  }

  const Icon = feedback.tone === 'success' ? CircleCheck : feedback.tone === 'error' ? TriangleAlert : Info
  const toast = (
    <div className={`pointer-events-none inset-x-0 top-6 flex justify-center px-6 ${floating ? 'fixed z-[120]' : 'absolute z-50'}`}>
      <div
        role={feedback.tone === 'error' ? 'alert' : 'status'}
        aria-live={feedback.tone === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
        className={`flex min-w-0 max-w-xl items-center gap-2 rounded-2xl border px-3.5 py-2.5 text-[13px] leading-5 shadow-[0_10px_30px_rgba(34,36,31,0.14)] backdrop-blur-md transition-[opacity,transform] duration-[650ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:translate-y-0 motion-reduce:duration-75 ${
          feedback.tone === 'success'
            ? 'border-[#cbd8cd] bg-[#f2f6f1]/95 text-[#38523d]'
            : feedback.tone === 'error'
              ? 'border-[#dec8bf] bg-[#f8efec]/95 text-[var(--wc-danger)]'
              : 'border-[var(--wc-line)] bg-[var(--wc-surface)] text-[var(--wc-muted)]'
        } ${phase === 'exiting'
          ? 'pointer-events-none translate-y-2 opacity-0'
          : 'pointer-events-auto translate-y-0 opacity-100'
        }`}
        onMouseEnter={hold}
        onMouseLeave={release}
      >
        <Icon aria-hidden="true" size={15} className="shrink-0" />
        <span className="min-w-0 break-words">{feedback.message}</span>
      </div>
    </div>
  )
  return floating ? createPortal(toast, document.body) : toast
}
