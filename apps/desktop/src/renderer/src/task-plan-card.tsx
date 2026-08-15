import type { TaskPlan } from '@whycode/core'
import { Check, Circle, ListChecks } from 'lucide-react'

interface TaskPlanCardProps {
  plan: TaskPlan
  compact: boolean
}

export function TaskPlanCard({ plan, compact }: TaskPlanCardProps) {
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
    <section className="wc-paper-card wc-paper-blue wc-paper-shape-b w-full">
      <div className="wc-paper-compact-pad flex w-full items-start gap-2.5 text-left">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--wc-blue)] text-[var(--wc-blue-ink)]">
          <ListChecks size={15} />
        </span>
        <span className="mt-1 min-w-0 flex-1 text-[11px] font-medium text-[var(--wc-faint)]">
          任务计划
        </span>
        <span className="mt-1 shrink-0 text-[10px] text-[var(--wc-muted)]">{stateLabel}</span>
      </div>
      <div className="mx-[var(--wc-paper-compact-padding)] h-1 overflow-hidden rounded-full bg-black/[0.055]">
        <div
          className="h-full rounded-full bg-[#7d9080] transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className={`${compact ? 'space-y-1.5' : 'space-y-2'} p-[var(--wc-paper-compact-padding)] pt-3`}>
        {plan.items.map((item) => (
          <div key={item.id} className="flex items-start gap-2 text-xs">
            <PlanStatusIcon status={item.status} />
            <div className="min-w-0 flex-1">
              <div className="leading-5 text-[var(--wc-ink)]">
                <span className="mr-1 text-[var(--wc-faint)]">{item.id}</span>
                {item.outcome}
                {item.kind === 'verification' && (
                  <span className="ml-1 rounded-md bg-[var(--wc-sage)] px-1 py-0.5 text-[9px] text-[var(--wc-sage-ink)]">
                    验证
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function PlanStatusIcon({ status }: { status: TaskPlan['items'][number]['status'] }) {
  if (status === 'completed') {
    return <Check size={14} className="mt-0.5 shrink-0 text-[#66806d]" />
  }
  if (status === 'in_progress') {
    return <span className="wc-plan-active-dot mt-1.5 shrink-0" role="img" aria-label="进行中" />
  }
  return <Circle size={11} className="mt-1 shrink-0 text-[#bfc0bb]" />
}
