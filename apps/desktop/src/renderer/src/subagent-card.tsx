import type { SubagentSummary } from '@whycode/core'
import { Bot, CheckCircle2, ChevronRight, LoaderCircle } from 'lucide-react'
import { isSubagentRunning } from './subagent-presentation.ts'

export function SubagentCard({
  subagents,
  onOpen,
}: {
  subagents: readonly SubagentSummary[]
  onOpen: () => void
}) {
  if (subagents.length === 0) return null
  const running = subagents.filter((subagent) => isSubagentRunning(subagent.status)).length
  const completed = subagents.length - running
  return (
    <button
      type="button"
      className="wc-focus-ring w-full rounded-2xl border border-[var(--wc-line)] bg-[var(--wc-surface)] px-3 py-3 text-left shadow-sm transition-colors hover:border-[var(--wc-line-strong)] hover:bg-black/[0.018]"
      onClick={onOpen}
    >
      <span className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-[var(--wc-blue)] text-[var(--wc-blue-ink)]">
          <Bot size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium">子代理</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--wc-muted)]">
            {running > 0 && (
              <span className="inline-flex items-center gap-1">
                <LoaderCircle size={11} className="animate-spin" /> {running} 个运行中
              </span>
            )}
            {completed > 0 && (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 size={11} /> {completed} 个已结束
              </span>
            )}
          </span>
        </span>
        <ChevronRight size={15} className="shrink-0 text-[var(--wc-faint)]" />
      </span>
    </button>
  )
}

