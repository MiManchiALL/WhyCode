import type { TaskPlanItemChange } from './tools.ts'
import type { TaskItem, TaskPlan } from './types.ts'

export function taskItemNumber(index: number): string {
  return `T${index + 1}`
}

export function taskProgress(plan: TaskPlan): string {
  return `${plan.items.filter(item => item.status === 'completed').length}/${plan.items.length}`
}

export function taskPlanSummary(plan: TaskPlan, heading: string): string {
  return [
    `${heading}「${plan.goal}」，进度 ${taskProgress(plan)}。`,
    ...plan.items.map((item, index) =>
      `${taskItemNumber(index)} [${item.status}] ${item.outcome}${item.kind === 'verification' ? '（整体验证）' : ''}`),
  ].join('\n')
}

export function taskItemLabel(item: TaskItem, index: number): string {
  return `${taskItemNumber(index)}「${item.outcome}」`
}

export function taskUpdateReceipt(plan: TaskPlan, changes: string[]): string {
  const running = plan.items.flatMap((item, index) =>
    item.status === 'in_progress' ? [taskItemLabel(item, index)] : [])
  return `${changes.join('。\n')}，进度 ${taskProgress(plan)}。`
    + (running.length ? `进行中：${running.join('、')}。` : '当前没有进行中的计划项。')
}

/** 对外编号取最终位置，内部 ID 仅用来认出同一批里被移动或修改的项。 */
export function describeTaskChanges(
  before: TaskPlan, after: TaskPlan, changes: readonly TaskPlanItemChange[],
): string[] {
  const descriptions: string[] = []
  for (const [index, original] of before.items.entries()) {
    if (!after.items.some(item => item.id === original.id)) {
      descriptions.push(`已删除原 ${taskItemLabel(original, index)}`)
    }
  }
  for (const [index, item] of after.items.entries()) {
    const originalIndex = before.items.findIndex(original => original.id === item.id)
    const original = before.items[originalIndex]
    const label = taskItemLabel(item, index)
    if (!original) {
      const position = index ? `在 ${taskItemNumber(index - 1)} 后` : '在首位'
      descriptions.push(`已${position}新增 ${label}（${item.status === 'in_progress' ? '进行中' : '待办'}）`)
      continue
    }
    const moved = index !== originalIndex && changes.some(change =>
      change.action === 'edit' && change.item_id === taskItemNumber(originalIndex) && change.after_item_id !== undefined)
    if (moved) descriptions.push(`原 ${taskItemNumber(originalIndex)} 已移至 ${label}`)
    if (item.status !== original.status) {
      descriptions.push(item.status === 'completed' ? `已完成 ${label}` : `已开始 ${taskItemNumber(index)}`)
    } else if (!moved && item.outcome !== original.outcome) {
      descriptions.push(`已修订 ${label}`)
    }
  }
  return descriptions
}
