import { ChevronRight } from 'lucide-react'
import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

interface BtwConversationGroupProps {
  id: string
  conversationId: string
  summary: string
  expanded: boolean
  automaticallyCollapse: boolean
  children: ReactNode
  onToggle: () => void
}

export function useAutomaticallyCollapsingBtwId(
  runtimeId: string,
  latestConversationId: string | null,
): string | null {
  const previousLatest = useRef<{
    runtimeId: string
    conversationId: string | null
  } | null>(null)
  const previous = previousLatest.current?.runtimeId === runtimeId
    ? previousLatest.current.conversationId
    : null
  useLayoutEffect(() => {
    previousLatest.current = { runtimeId, conversationId: latestConversationId }
  }, [latestConversationId, runtimeId])
  return previous && previous !== latestConversationId
    ? `btw-conversation-${previous}`
    : null
}

export function BtwConversationGroup(props: BtwConversationGroupProps) {
  const open = useCollapsibleOpen(
    props.expanded,
    props.automaticallyCollapse,
  )
  const contentId = `btw-history-${props.conversationId}`
  return (
    <section className="mb-4">
      <button
        type="button"
        className="wc-btw-history-summary wc-focus-ring"
        data-conversation-navigator-target={props.id}
        aria-controls={contentId}
        aria-expanded={props.expanded}
        title={props.expanded ? '收起临时对话' : '展开临时对话'}
        onClick={props.onToggle}
      >
        <span className="wc-btw-history-label">临时对话</span>
        <span aria-hidden="true" className="wc-btw-history-separator">·</span>
        <span className="wc-btw-history-preview" title={props.summary}>{props.summary}</span>
        <span className="wc-btw-history-status">已结束</span>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="wc-btw-history-chevron"
          data-open={props.expanded ? 'true' : undefined}
        />
      </button>
      <div
        id={contentId}
        className="wc-btw-history-content"
        data-open={open ? 'true' : undefined}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="wc-btw-history-content-inner">
          <div className="pt-3">{props.children}</div>
        </div>
      </div>
    </section>
  )
}

function useCollapsibleOpen(expanded: boolean, collapseOnMount: boolean): boolean {
  const [open, setOpen] = useState(expanded || collapseOnMount)

  useLayoutEffect(() => {
    let firstFrame: number | null = null
    let secondFrame: number | null = null
    if (expanded !== open) {
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => setOpen(expanded))
      })
    }
    return () => {
      if (firstFrame !== null) window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame)
    }
  }, [expanded, open])

  return open
}
