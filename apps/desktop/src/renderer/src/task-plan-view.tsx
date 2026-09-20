import type { TaskItem } from '@whycode/core'
import { Check, ChevronRight, Circle } from 'lucide-react'
import type { TaskPlanViewData } from './task-tool-result.ts'

export function TaskPlanView({
  plan,
  historical = false,
  updatedItemIds = [],
}: {
  plan: TaskPlanViewData
  historical?: boolean
  updatedItemIds?: readonly string[]
}) {
  const completed = plan.items.filter((item) => item.status === 'completed').length
  const percent = plan.items.length === 0
    ? 0
    : Math.round((completed / plan.items.length) * 100)
  const stateLabel = plan.status === 'active'
    ? `${completed}/${plan.items.length}`
    : plan.status === 'completed'
      ? '已完成'
      : '已结束'

  return (
    <div className="px-2 pb-1 text-[length:var(--wc-content-secondary-font-size,12px)] leading-[var(--wc-content-secondary-line-height,20px)]">
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-black/[0.055]">
          <div
            className="h-full rounded-full bg-[#7d9080] transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="shrink-0 wc-type-tiny text-[var(--wc-muted)]">{stateLabel}</span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {plan.items.map((item) => (
          <li
            key={item.id}
            className={`flex items-start gap-2 rounded-md ${updatedItemIds.includes(item.id) ? 'bg-[var(--wc-sage)]' : ''}`}
            data-updated={updatedItemIds.includes(item.id) || undefined}
          >
            <PlanStatusIcon status={item.status} historical={historical} />
            <div className="min-w-0 flex-1 break-words text-[var(--wc-ink)]">
              <span className="mr-1 text-[var(--wc-faint)]">{item.id}</span>
              {item.outcome}
              {item.kind === 'verification' && (
                <span className="ml-1 rounded-md bg-[var(--wc-sage)] px-1 py-0.5 wc-type-tiny text-[var(--wc-sage-ink)]">
                  验证
                </span>
              )}
              {historical && item.status === 'completed' && item.evidence.length > 0 && <TaskEvidence evidence={item.evidence} />}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TaskEvidence({ evidence }: { evidence: readonly string[] }) {
  return (
    <details className="group mt-1">
      <summary className="wc-focus-ring flex w-fit cursor-pointer list-none items-center gap-1 rounded-md wc-type-tiny text-[var(--wc-muted)] [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90" />
        完成证据
      </summary>
      <ul className="mt-1 ml-4 list-disc space-y-1 whitespace-pre-wrap text-[var(--wc-muted)]">
        {evidence.map((entry, index) => <li key={index}>{entry}</li>)}
      </ul>
    </details>
  )
}

function PlanStatusIcon({ status, historical }: { status: TaskItem['status']; historical: boolean }) {
  if (status === 'completed') {
    return <Check size={14} role="img" aria-label="已完成" className="mt-0.5 shrink-0 text-[#66806d]" />
  }
  if (status === 'in_progress') {
    return <span className="wc-plan-active-dot mt-1.5 shrink-0" role="img" aria-label="进行中" data-historical={historical || undefined} />
  }
  return <Circle size={11} role="img" aria-label="未开始" className="mt-1 shrink-0 text-[#bfc0bb]" />
}
