import type { ModelMessage } from 'ai'
import type { TaskPlanDraftItem, TaskPlanItemChange } from './tools.ts'
import { taskProgressReminder } from './reminder.ts'
import {
  activeTaskPlanSchema,
  cloneTaskPlanState,
  emptyTaskPlanState,
  resolveTaskPlanProgress,
  type ActiveTaskPlan,
  type TaskItem,
  type TaskPlan,
  type TaskPlanState,
} from './types.ts'

export type TaskMutationError =
  | 'step_conflict'
  | 'no_active_plan'
  | 'invalid_plan'
  | 'item_not_found'
  | 'invalid_transition'
  | 'evidence_required'
  | 'no_state_change'

export type TaskMutationResult =
  | { ok: true; message: string }
  | { ok: false; error: TaskMutationError; message: string }

function mutationFailure(
  error: TaskMutationError,
  message: string,
): TaskMutationResult {
  return { ok: false, error, message }
}

export interface TaskPlanCommit {
  state: TaskPlanState
  plan: TaskPlan
}

/**
 * 单活动计划的事务控制器。未提交草稿可撤销，持久提交边界由调用方持有。
 */
export class TaskPlanController {
  private state: TaskPlanState
  private pending: TaskPlanCommit | undefined

  constructor(initialState: TaskPlanState = emptyTaskPlanState()) {
    this.state = cloneTaskPlanState(initialState)
  }

  get hasActivePlan(): boolean {
    return this.state.activePlan !== null
  }

  progressReminder(messages: readonly ModelMessage[]): ModelMessage | null {
    return taskProgressReminder(messages, this.state.activePlan)
  }

  get stateSnapshot(): TaskPlanState {
    return structuredClone(this.state)
  }

  get pendingUpdate(): TaskPlanCommit | undefined {
    return this.pending && structuredClone(this.pending)
  }

  commitUpdate(): void {
    if (this.pending) this.state = this.pending.state
    this.pending = undefined
  }

  discardUpdate(): void {
    this.pending = undefined
  }

  restore(state: TaskPlanState): void {
    this.state = cloneTaskPlanState(state)
    this.pending = undefined
  }

  create(goal: string, drafts: TaskPlanDraftItem[]): TaskMutationResult {
    const next = this.buildPlan(goal, drafts)
    if ('error' in next) return mutationFailure('invalid_plan', next.error)
    return this.stage(next.plan, this.progressMessage(next.plan, `已建立 ${next.plan.items.length} 项宏观计划`))
  }

  update(changes: readonly TaskPlanItemChange[]): TaskMutationResult {
    const current = this.state.activePlan
    if (!current) return mutationFailure('no_active_plan', '当前没有活动任务计划。')
    if (changes.length === 0) {
      return mutationFailure('no_state_change', '必须提供任务项变化或状态更新。')
    }

    const plan = structuredClone(current)
    for (const change of changes) {
      const failure = this.applyItemChange(plan, change)
      if (failure) return failure
    }
    if (JSON.stringify(plan.items) === JSON.stringify(current.items)) {
      if (changes.every(change => change.action === 'edit' && change.status && !change.outcome && !change.after_item_id)) {
        return { ok: true, message: this.progressMessage(current, '计划状态无需更新') }
      }
      return mutationFailure('no_state_change', '计划内容和状态没有实质变化。')
    }

    plan.revision++
    const parsed = activeTaskPlanSchema.safeParse(plan)
    if (!parsed.success) {
      return mutationFailure('invalid_plan', parsed.error.issues[0]?.message ?? '计划结构无效。')
    }
    const updated = resolveTaskPlanProgress(parsed.data)
    return this.stage(updated, updated.status === 'completed' ? '全部里程碑已完成，计划已关闭。' : this.progressMessage(updated))
  }

  close(): TaskMutationResult {
    const plan = this.state.activePlan
    if (!plan) return mutationFailure('no_active_plan', '当前没有活动任务计划。')
    return this.stage({ ...plan, revision: plan.revision + 1, status: 'ended' }, '任务计划已结束。')
  }

  private applyItemChange(
    plan: ActiveTaskPlan,
    change: TaskPlanItemChange,
  ): TaskMutationResult | null {
    if (change.action === 'add') return this.addItem(plan, change)
    const index = plan.items.findIndex((item) => item.id === change.item_id)
    if (index < 0) return mutationFailure('item_not_found', `任务项不存在：${change.item_id}`)
    const item = plan.items[index]!
    if (item.status === 'completed') {
      if (change.action === 'edit' && change.status === 'completed'
        && change.outcome === undefined && change.after_item_id === undefined
        && change.evidence && sameStrings(item.evidence, change.evidence)) {
        return null
      }
      return mutationFailure('invalid_transition', `${item.id} 已完成，不能再修改或删除。`)
    }
    if (change.action === 'delete') {
      if (item.kind === 'verification') {
        return mutationFailure('invalid_plan', '最终 verification 不能删除，只能修改其结果描述。')
      }
      plan.items.splice(index, 1)
      return null
    }
    return this.editItem(plan, item, change)
  }

  private addItem(
    plan: ActiveTaskPlan,
    change: Extract<TaskPlanItemChange, { action: 'add' }>,
  ): TaskMutationResult | null {
    const outcome = change.outcome.trim()
    if (!outcome) return mutationFailure('invalid_plan', '新增里程碑的结果描述不能为空。')
    if (plan.items.length >= 7) {
      return mutationFailure('invalid_plan', '计划最多保留 7 个宏观里程碑；请先合并或删除未来项。')
    }
    const insertionIndex = this.insertionIndex(plan, change.after_item_id)
    if (typeof insertionIndex !== 'number') return insertionIndex
    const nextNumber = Math.max(...plan.items.map((item) => Number(item.id.slice(1)))) + 1
    plan.items.splice(insertionIndex, 0, {
      id: `T${nextNumber}`,
      kind: 'work',
      outcome,
      status: change.status ?? 'pending',
      evidence: [],
    })
    return null
  }

  private editItem(
    plan: ActiveTaskPlan,
    item: TaskItem,
    change: Extract<TaskPlanItemChange, { action: 'edit' }>,
  ): TaskMutationResult | null {
    if (change.outcome !== undefined) {
      const outcome = change.outcome.trim()
      if (!outcome) return mutationFailure('invalid_plan', '里程碑结果描述不能为空。')
      item.outcome = outcome
    }
    if (change.status === 'completed') {
      if (item.status !== 'in_progress') {
        return mutationFailure('invalid_transition', `${item.id} 必须先进入 in_progress 才能完成。`)
      }
      if (!change.evidence?.length) {
        return mutationFailure('evidence_required', `完成 ${item.id} 需要可核验的 evidence。`)
      }
      item.evidence = change.evidence
    }
    if (change.status) item.status = change.status
    if (change.after_item_id === undefined) return null
    if (item.kind === 'verification') {
      return mutationFailure('invalid_plan', '最终 verification 必须保持在计划末尾。')
    }
    if (change.after_item_id === item.id) {
      return mutationFailure('invalid_plan', '任务项不能排在自身之后。')
    }
    const originalIndex = plan.items.findIndex((entry) => entry.id === item.id)
    plan.items.splice(originalIndex, 1)
    const insertionIndex = this.insertionIndex(plan, change.after_item_id)
    if (typeof insertionIndex !== 'number') return insertionIndex
    plan.items.splice(insertionIndex, 0, item)
    return null
  }

  private insertionIndex(
    plan: ActiveTaskPlan,
    afterItemId?: string,
  ): number | TaskMutationResult {
    if (!afterItemId) return plan.items.length - 1
    const referenceIndex = plan.items.findIndex((item) => item.id === afterItemId)
    if (referenceIndex < 0) {
      return mutationFailure('item_not_found', `定位任务项不存在：${afterItemId}`)
    }
    if (plan.items[referenceIndex]!.kind === 'verification') {
      return mutationFailure('invalid_plan', '工作里程碑不能排在最终 verification 之后。')
    }
    return referenceIndex + 1
  }

  private stage(plan: TaskPlan, message: string): TaskMutationResult {
    if (this.pending) return mutationFailure('step_conflict', '上一项计划变更尚未提交。')
    const activePlan = plan.status === 'active' ? plan : null
    this.pending = { state: { version: this.state.version + 1, activePlan }, plan }
    return { ok: true, message }
  }

  private buildPlan(
    goal: string,
    drafts: TaskPlanDraftItem[],
  ): { plan: ActiveTaskPlan } | { error: string } {
    const normalizedGoal = goal.trim()
    if (!normalizedGoal) return { error: '计划目标不能为空。' }
    if (drafts.length < 3 || drafts.length > 7) {
      return { error: '初始计划必须包含 3～7 个宏观里程碑。' }
    }
    if (drafts.at(-1)?.kind !== 'verification') {
      return { error: '计划最后一项必须是 verification。' }
    }
    if (drafts.filter((item) => item.kind === 'verification').length !== 1) {
      return { error: '一个计划必须且只能包含一个 verification。' }
    }
    const items: TaskItem[] = drafts.map((draft, index) => ({
      id: `T${index + 1}`,
      kind: draft.kind,
      outcome: draft.outcome.trim(),
      status: draft.status ?? 'pending',
      evidence: [],
    }))
    if (items.some(item => !item.outcome)) return { error: '里程碑结果描述不能为空。' }
    return {
      plan: activeTaskPlanSchema.parse({
        id: crypto.randomUUID(),
        goal: normalizedGoal,
        status: 'active',
        items,
        revision: 1,
      }),
    }
  }

  private progressMessage(plan: ActiveTaskPlan, message = '计划已更新'): string {
    const done = plan.items.filter((item) => item.status === 'completed').length
    const running = plan.items.filter(item => item.status === 'in_progress')
    const progress = `${message}，进度 ${done}/${plan.items.length}。`
    return progress + (running.length
      ? `进行中：${running.map(item => `${item.id}「${item.outcome}」`).join('、')}。`
      : '当前没有进行中的计划项。')
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
