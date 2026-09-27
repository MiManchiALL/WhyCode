import type { TaskPlan, TaskPlanState } from '../tasks/types.ts'
import type { ViewEvent } from './view-events.ts'

/** 展示恢复只读取保留的时间线，终态计划不重新进入执行状态。 */
export function taskPlanViewBeforeTurn(
  events: readonly ViewEvent[],
  turnId: string,
  taskState: TaskPlanState,
): TaskPlan | null {
  if (taskState.activePlan) return structuredClone(taskState.activePlan)
  const boundary = events.findLastIndex(entry => entry.type === 'core-event'
    && entry.event.type === 'turn-start' && entry.event.turnId === turnId)
  if (boundary < 0) throw new Error('找不到目标回合的可见起点')
  const visible = latestVisibleTaskPlan(events, boundary)
  return visible?.status === 'active' ? null : structuredClone(visible)
}

export function latestVisibleTaskPlan(
  events: readonly ViewEvent[],
  end = events.length,
): TaskPlan | null {
  for (let index = end - 1; index >= 0; index--) {
    const entry = events[index]
    if (entry?.type !== 'core-event') continue
    const event = entry.event
    if (event.type === 'task-plan-updated' || event.type === 'task-plan-restored') return event.plan
    if (event.type === 'user-message-edited') return event.taskPlan
    if (event.type === 'checkpoint-restored' && event.ok && event.scope === 'files-and-chat'
      && event.taskPlan !== undefined) return event.taskPlan
  }
  return null
}
