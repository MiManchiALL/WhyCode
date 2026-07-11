import { useState } from 'react'
import type { TaskPlan } from '@whycode/core'

const STATUS_LABEL = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '受阻',
} as const

export function TaskPlanCard({ plan }: { plan: TaskPlan }) {
  const [expanded, setExpanded] = useState(plan.status === 'active')
  const completed = plan.items.filter((item) => item.status === 'completed').length
  const percent = Math.round((completed / plan.items.length) * 100)
  const stateLabel = plan.status === 'active'
    ? `${completed}/${plan.items.length}`
    : plan.status === 'completed'
      ? '已完成'
      : plan.status === 'superseded'
        ? '已替换'
        : '已放弃'

  return (
    <section className="border-b border-blue-100 bg-blue-50/50 px-6 py-2.5">
      <button
        className="flex w-full items-center gap-3 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="text-sm">▣</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-blue-950">
          {plan.goal}
        </span>
        <span className="text-xs text-blue-700">{stateLabel}</span>
        <span className="text-xs text-blue-500">{expanded ? '▾' : '▸'}</span>
      </button>
      <div className="mt-2 h-1 overflow-hidden rounded bg-blue-100">
        <div className="h-full rounded bg-blue-500 transition-all" style={{ width: `${percent}%` }} />
      </div>
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {plan.items.map((item) => (
            <div key={item.id} className="flex items-start gap-2 text-xs">
              <span className={statusColor(item.status)}>{statusIcon(item.status)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-neutral-700">
                  <span className="mr-1 text-neutral-400">{item.id}</span>
                  {item.title}
                  {item.kind === 'verification' && (
                    <span className="ml-1 rounded bg-violet-100 px-1 text-[10px] text-violet-700">
                      验证
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-neutral-400">
                  {STATUS_LABEL[item.status]} · {item.acceptance}
                  {item.blockedReason ? ` · ${item.blockedReason}` : ''}
                </div>
              </div>
            </div>
          ))}
          {'summary' in plan && (
            <div className="pt-1 text-xs text-neutral-500">{plan.summary}</div>
          )}
        </div>
      )}
    </section>
  )
}

function statusIcon(status: TaskPlan['items'][number]['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '●'
  if (status === 'blocked') return '!'
  return '○'
}

function statusColor(status: TaskPlan['items'][number]['status']): string {
  if (status === 'completed') return 'text-green-600'
  if (status === 'in_progress') return 'text-blue-600'
  if (status === 'blocked') return 'text-amber-600'
  return 'text-neutral-300'
}
