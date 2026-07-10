import type { ModelMessage } from 'ai'
import {
  activeTaskPlanSchema,
  cloneActiveTaskPlan,
  taskPlanSchema,
  type ActiveTaskPlan,
  type TaskItem,
  type TaskItemStatus,
  type TaskPlan,
} from './types.ts'

export interface TaskPlanDraftItem {
  kind: 'work' | 'verification'
  title: string
  acceptance: string
}

export interface TaskMutationResult {
  ok: boolean
  message: string
}

export type NaturalStopDecision =
  | { kind: 'allow' }
  | { kind: 'pause' }
  | { kind: 'continue'; reminder: string }

export interface TaskPlanCommit {
  activePlan: ActiveTaskPlan | null
  displayPlan: TaskPlan
}

/**
 * Main 的单活动计划控制器。工具调用先修改内存草稿，只有模型 step 稳定提交后才落盘；
 * urgent/取消/异常丢弃 step 时恢复旧状态，避免会话中出现半截进度。
 */
export class TaskPlanController {
  private activePlan: ActiveTaskPlan | null
  private stepSnapshot: ActiveTaskPlan | null = null
  private stepDirty = false
  private pendingDisplayPlan: TaskPlan | null = null

  constructor(initialPlan: ActiveTaskPlan | null) {
    this.activePlan = cloneActiveTaskPlan(initialPlan)
  }

  get snapshot(): ActiveTaskPlan | null {
    return cloneActiveTaskPlan(this.activePlan)
  }

  beginStep(): void {
    this.stepSnapshot = cloneActiveTaskPlan(this.activePlan)
    this.stepDirty = false
    this.pendingDisplayPlan = null
  }

  commitStep(): TaskPlanCommit | undefined {
    const update = this.stepDirty && this.pendingDisplayPlan
      ? {
          activePlan: cloneActiveTaskPlan(this.activePlan),
          displayPlan: taskPlanSchema.parse(structuredClone(this.pendingDisplayPlan)),
        }
      : undefined
    this.stepSnapshot = null
    this.stepDirty = false
    this.pendingDisplayPlan = null
    return update
  }

  discardStep(): void {
    if (this.stepDirty) this.activePlan = cloneActiveTaskPlan(this.stepSnapshot)
    this.stepSnapshot = null
    this.stepDirty = false
    this.pendingDisplayPlan = null
  }

  restore(plan: ActiveTaskPlan | null): void {
    this.activePlan = cloneActiveTaskPlan(plan)
    this.stepSnapshot = null
    this.stepDirty = false
    this.pendingDisplayPlan = null
  }

  create(goal: string, drafts: TaskPlanDraftItem[]): TaskMutationResult {
    if (this.activePlan) {
      return { ok: false, message: '已有未结束的任务计划；请先完成或放弃当前计划。' }
    }
    if (drafts.at(-1)?.kind !== 'verification') {
      return { ok: false, message: '计划最后一项必须是 verification 验证步骤。' }
    }
    if (drafts.filter((item) => item.kind === 'verification').length !== 1) {
      return { ok: false, message: '一个计划必须且只能包含一个 verification 验证步骤。' }
    }
    const items: TaskItem[] = drafts.map((draft, index) => ({
      id: `T${index + 1}`,
      kind: draft.kind,
      title: draft.title.trim(),
      acceptance: draft.acceptance.trim(),
      status: index === 0 ? 'in_progress' : 'pending',
      evidence: [],
    }))
    this.activePlan = activeTaskPlanSchema.parse({
      id: crypto.randomUUID(),
      goal: goal.trim(),
      status: 'active',
      items,
      revision: 1,
    })
    this.publish(this.activePlan)
    return { ok: true, message: `已建立任务计划，共 ${items.length} 项；当前执行 ${items[0]!.id}。` }
  }

  addItem(draft: TaskPlanDraftItem): TaskMutationResult {
    const plan = this.activePlan
    if (!plan) return { ok: false, message: '当前没有活动任务计划。' }
    if (draft.kind === 'verification') {
      return { ok: false, message: '计划已经有验证步骤，不能重复添加。' }
    }
    const nextNumber = Math.max(...plan.items.map((item) => Number(item.id.slice(1)))) + 1
    const item: TaskItem = {
      id: `T${nextNumber}`,
      kind: 'work',
      title: draft.title.trim(),
      acceptance: draft.acceptance.trim(),
      status: plan.items.some((entry) => entry.status === 'in_progress') ? 'pending' : 'in_progress',
      evidence: [],
    }
    const verificationIndex = plan.items.findIndex((entry) => entry.kind === 'verification')
    plan.items.splice(verificationIndex, 0, item)
    plan.revision++
    this.publish(plan)
    return { ok: true, message: `已添加 ${item.id}：${item.title}` }
  }

  updateItem(
    itemId: string,
    status: Exclude<TaskItemStatus, 'pending'>,
    evidence: string[],
    blockedReason?: string,
  ): TaskMutationResult {
    const plan = this.activePlan
    if (!plan) return { ok: false, message: '当前没有活动任务计划。' }
    const item = plan.items.find((entry) => entry.id === itemId)
    if (!item) return { ok: false, message: `任务项不存在：${itemId}` }
    if (item.status === 'completed') {
      return { ok: false, message: `${itemId} 已完成；已确认的完成项不能静默重开。` }
    }
    if (status === 'in_progress') {
      const running = plan.items.find(
        (entry) => entry.status === 'in_progress' && entry.id !== itemId,
      )
      if (running) {
        return { ok: false, message: `同一时间只能执行一项；请先处理 ${running.id}。` }
      }
      item.status = 'in_progress'
      item.blockedReason = undefined
    } else if (status === 'completed') {
      if (evidence.length === 0) {
        return { ok: false, message: `完成 ${itemId} 必须提供可核验的 evidence。` }
      }
      item.status = 'completed'
      item.evidence = [...evidence]
      item.blockedReason = undefined
      this.startNextPending(plan.items)
    } else {
      if (!blockedReason?.trim()) {
        return { ok: false, message: `阻塞 ${itemId} 必须说明 blocked_reason。` }
      }
      item.status = 'blocked'
      item.blockedReason = blockedReason.trim()
      item.evidence = [...evidence]
      this.startNextPending(plan.items)
    }
    plan.revision++
    this.publish(plan)
    return { ok: true, message: this.progressMessage(plan, item) }
  }

  close(outcome: 'completed' | 'abandoned', summary: string): TaskMutationResult {
    const plan = this.activePlan
    if (!plan) return { ok: false, message: '当前没有活动任务计划。' }
    if (outcome === 'completed' && plan.items.some((item) => item.status !== 'completed')) {
      return { ok: false, message: '仍有未完成或阻塞的任务项，不能把整个计划标记为完成。' }
    }
    const closed = taskPlanSchema.parse({
      ...plan,
      status: outcome,
      revision: plan.revision + 1,
      summary: summary.trim(),
    })
    this.activePlan = null
    this.publish(closed)
    return {
      ok: true,
      message: outcome === 'completed' ? '任务计划已核验完成。' : '任务计划已明确放弃。',
    }
  }

  reminderMessage(): ModelMessage | null {
    const plan = this.activePlan
    if (!plan) return null
    const lines = [
      '<system-reminder>',
      `当前长任务目标：${plan.goal}`,
      `计划版本：${plan.revision}`,
      ...plan.items.map((item) => {
        const detail = item.status === 'blocked'
          ? `；阻塞原因：${item.blockedReason}`
          : item.evidence.length > 0
            ? `；证据：${item.evidence.join('；')}`
            : ''
        return `- ${item.id} [${item.status}] ${item.title}；完成标准：${item.acceptance}${detail}`
      }),
      '继续围绕当前 in_progress 项工作；完成时用 UpdateTaskItem 写入证据。所有项完成后必须调用 CloseTaskPlan。',
      '</system-reminder>',
    ]
    return { role: 'user', content: lines.join('\n') }
  }

  naturalStopDecision(): NaturalStopDecision {
    const plan = this.activePlan
    if (!plan) return { kind: 'allow' }
    if (plan.items.every((item) => item.status === 'completed')) {
      return {
        kind: 'continue',
        reminder: '所有任务项已经完成，但计划尚未正式关闭。请调用 CloseTaskPlan，并给出最终总结。',
      }
    }
    const unfinished = plan.items.filter((item) =>
      item.status === 'pending' || item.status === 'in_progress',
    )
    if (unfinished.length === 0) return { kind: 'pause' }
    return {
      kind: 'continue',
      reminder: `任务计划仍有未完成项：${unfinished.map((item) => item.id).join('、')}。请继续执行；若无法推进，明确标记 blocked 或放弃计划，不能直接宣称全部完成。`,
    }
  }

  private publish(plan: TaskPlan): void {
    this.stepDirty = true
    this.pendingDisplayPlan = taskPlanSchema.parse(structuredClone(plan))
  }

  private startNextPending(items: TaskItem[]): void {
    if (items.some((item) => item.status === 'in_progress')) return
    const next = items.find((item) => item.status === 'pending')
    if (next) next.status = 'in_progress'
  }

  private progressMessage(plan: ActiveTaskPlan, item: TaskItem): string {
    const done = plan.items.filter((entry) => entry.status === 'completed').length
    const current = plan.items.find((entry) => entry.status === 'in_progress')
    return `${item.id} 已更新为 ${item.status}；进度 ${done}/${plan.items.length}${current ? `，当前执行 ${current.id}` : ''}。`
  }
}
