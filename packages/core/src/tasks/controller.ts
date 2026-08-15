import {
  activeTaskPlanSchema,
  cloneActiveTaskPlan,
  cloneTaskPlanState,
  emptyTaskPlanState,
  interruptTaskPlanState,
  taskPlanSchema,
  type ActiveTaskPlan,
  type TaskItem,
  type TaskPlan,
  type TaskPlanState,
} from './types.ts'

export interface TaskPlanDraftItem {
  kind: 'work' | 'verification'
  outcome: string
}

export type TaskPlanItemChange =
  | { action: 'add'; outcome: string; afterItemId?: string }
  | { action: 'edit'; itemId: string; outcome?: string; afterItemId?: string }
  | { action: 'delete'; itemId: string }

export type TaskPlanTransition =
  | { itemId: string; status: 'in_progress' }
  | { itemId: string; status: 'completed'; evidence: string[] }

export type TaskMutationError =
  | 'step_conflict'
  | 'active_plan_exists'
  | 'no_active_plan'
  | 'plan_id_mismatch'
  | 'resume_required'
  | 'not_engaged'
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
 * 单活动计划的事务控制器。模型步骤提交前只修改内存草稿；取消或异常会整体回滚。
 */
export class TaskPlanController {
  private state: TaskPlanState
  private stepSnapshot: TaskPlanState | null = null
  private stepDirty = false
  private stepBoundary: 'create' | 'close' | null = null
  private pendingDisplayPlan: TaskPlan | null = null

  constructor(initialState: TaskPlanState = emptyTaskPlanState()) {
    this.state = cloneTaskPlanState(initialState)
  }

  get snapshot(): ActiveTaskPlan | null {
    return cloneActiveTaskPlan(this.state.activePlan)
  }

  get stateSnapshot(): TaskPlanState {
    return cloneTaskPlanState(this.state)
  }

  beginStep(): void {
    this.stepSnapshot = cloneTaskPlanState(this.state)
    this.stepDirty = false
    this.stepBoundary = null
    this.pendingDisplayPlan = null
  }

  commitStep(): TaskPlanCommit | undefined {
    const update = this.stepDirty && this.pendingDisplayPlan
      ? {
          state: cloneTaskPlanState(this.state),
          plan: taskPlanSchema.parse(structuredClone(this.pendingDisplayPlan)),
        }
      : undefined
    this.resetStep()
    return update
  }

  discardStep(): void {
    if (this.stepDirty && this.stepSnapshot) this.state = cloneTaskPlanState(this.stepSnapshot)
    this.resetStep()
  }

  restore(state: TaskPlanState): void {
    this.state = cloneTaskPlanState(state)
    this.resetStep()
  }

  create(goal: string, drafts: TaskPlanDraftItem[]): TaskMutationResult {
    if (this.stepDirty) {
      return mutationFailure('step_conflict', 'CreateTaskPlan 必须作为本步骤唯一的计划变更。')
    }
    if (this.state.activePlan) {
      return mutationFailure(
        'active_plan_exists',
        '当前已有活动计划；继续时先 ResumeTaskPlan，不再执行时先 CloseTaskPlan。',
      )
    }
    const next = this.buildPlan(goal, drafts)
    if ('error' in next) return mutationFailure('invalid_plan', next.error)
    this.state.activePlan = next.plan
    this.state.resumeRequired = false
    this.state.interruptionReason = null
    this.stepBoundary = 'create'
    this.publish(next.plan)
    return {
      ok: true,
      message: `已建立 ${next.plan.items.length} 项宏观计划；里程碑尚未开始，下一步先进入 ${next.plan.items[0]!.id}。`,
    }
  }

  update(
    changes: TaskPlanItemChange[],
    transition?: TaskPlanTransition,
  ): TaskMutationResult {
    if (this.stepBoundary) {
      return mutationFailure('step_conflict', '计划边界刚刚变化；请在下一模型步骤再更新任务项。')
    }
    const current = this.state.activePlan
    if (!current) return mutationFailure('no_active_plan', '当前没有活动任务计划。')
    if (this.state.resumeRequired) return this.resumeRequiredError()
    if (changes.length === 0 && !transition) {
      return mutationFailure('no_state_change', '必须提供任务项变化或状态更新。')
    }

    const plan = activeTaskPlanSchema.parse(structuredClone(current))
    for (const change of changes) {
      const failure = this.applyItemChange(plan, change)
      if (failure) return failure
    }
    if (transition) {
      const failure = this.applyTransition(plan, transition)
      if (failure) return failure
    }
    if (JSON.stringify(plan.items) === JSON.stringify(current.items)) {
      if (changes.length === 0 && transition) {
        return {
          ok: true,
          message: `${transition.itemId} 已处于 ${transition.status}；计划无需更新。`,
        }
      }
      return mutationFailure('no_state_change', '计划内容和状态没有实质变化。')
    }

    plan.revision++
    const parsed = activeTaskPlanSchema.safeParse(plan)
    if (!parsed.success) {
      return mutationFailure('invalid_plan', parsed.error.issues[0]?.message ?? '计划结构无效。')
    }
    this.state.activePlan = parsed.data
    this.publish(parsed.data)
    return { ok: true, message: this.progressMessage(parsed.data) }
  }

  close(): TaskMutationResult {
    if (this.stepDirty) {
      return mutationFailure('step_conflict', 'CloseTaskPlan 必须作为本步骤唯一的计划变更。')
    }
    const plan = this.state.activePlan
    if (!plan) return mutationFailure('no_active_plan', '当前没有活动任务计划。')
    this.finish(plan, 'ended')
    return { ok: true, message: '任务计划已结束。' }
  }

  /** 模型正文自然结束时，由会话协议在同一步事务内确定计划终态。 */
  finishNaturalRun(): TaskMutationResult {
    if (this.stepDirty) {
      return mutationFailure('step_conflict', '当前模型步骤已有计划变更，不能同时自然结束计划。')
    }
    const plan = this.state.activePlan
    if (!plan) return mutationFailure('no_active_plan', '当前没有活动任务计划。')
    const status = plan.items.every((item) => item.status === 'completed')
      ? 'completed'
      : 'ended'
    this.finish(plan, status)
    return {
      ok: true,
      message: status === 'completed' ? '任务计划已核验完成。' : '任务计划已随本次执行结束。',
    }
  }

  resume(planId: string): TaskMutationResult {
    const plan = this.state.activePlan
    if (!plan) return mutationFailure('no_active_plan', '当前没有未结束的任务计划。')
    if (plan.id !== planId) {
      return mutationFailure('plan_id_mismatch', '计划 ID 已变化，请读取最新任务状态。')
    }
    if (this.state.resumeRequired) {
      this.state.resumeRequired = false
      this.state.interruptionReason = null
      this.publish(plan)
    }
    return { ok: true, message: '当前执行已接合活动计划。' }
  }

  interrupt(
    reason: NonNullable<TaskPlanState['interruptionReason']>,
  ): TaskPlanState | null {
    if (!this.state.activePlan) return null
    if (this.state.resumeRequired && this.state.interruptionReason === reason) return null
    this.state = interruptTaskPlanState(this.state, reason)
    return this.stateSnapshot
  }

  hasUnfinishedWork(): boolean {
    return Boolean(this.state.activePlan?.items.some((item) => item.status !== 'completed'))
  }

  private applyItemChange(
    plan: ActiveTaskPlan,
    change: TaskPlanItemChange,
  ): TaskMutationResult | null {
    if (change.action === 'add') return this.addItem(plan, change)
    const index = plan.items.findIndex((item) => item.id === change.itemId)
    if (index < 0) return mutationFailure('item_not_found', `任务项不存在：${change.itemId}`)
    const item = plan.items[index]!
    if (item.status === 'completed') {
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
    const insertionIndex = this.insertionIndex(plan, change.afterItemId)
    if (typeof insertionIndex !== 'number') return insertionIndex
    const nextNumber = Math.max(...plan.items.map((item) => Number(item.id.slice(1)))) + 1
    plan.items.splice(insertionIndex, 0, {
      id: `T${nextNumber}`,
      kind: 'work',
      outcome,
      status: 'pending',
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
    if (change.afterItemId === undefined) return null
    if (item.kind === 'verification') {
      return mutationFailure('invalid_plan', '最终 verification 必须保持在计划末尾。')
    }
    if (item.status === 'in_progress') {
      return mutationFailure('invalid_transition', '当前进行中的里程碑不能重排。')
    }
    if (change.afterItemId === item.id) {
      return mutationFailure('invalid_plan', '任务项不能排在自身之后。')
    }
    const originalIndex = plan.items.findIndex((entry) => entry.id === item.id)
    plan.items.splice(originalIndex, 1)
    const insertionIndex = this.insertionIndex(plan, change.afterItemId)
    if (typeof insertionIndex !== 'number') return insertionIndex
    plan.items.splice(insertionIndex, 0, item)
    return null
  }

  private insertionIndex(
    plan: ActiveTaskPlan,
    afterItemId?: string,
  ): number | TaskMutationResult {
    const verificationIndex = plan.items.findIndex((item) => item.kind === 'verification')
    if (!afterItemId) return verificationIndex
    const referenceIndex = plan.items.findIndex((item) => item.id === afterItemId)
    if (referenceIndex < 0) {
      return mutationFailure('item_not_found', `定位任务项不存在：${afterItemId}`)
    }
    if (plan.items[referenceIndex]!.kind === 'verification') {
      return mutationFailure('invalid_plan', '工作里程碑不能排在最终 verification 之后。')
    }
    return referenceIndex + 1
  }

  private applyTransition(
    plan: ActiveTaskPlan,
    transition: TaskPlanTransition,
  ): TaskMutationResult | null {
    const item = plan.items.find((entry) => entry.id === transition.itemId)
    if (!item) return mutationFailure('item_not_found', `任务项不存在：${transition.itemId}`)

    if (transition.status === 'in_progress') {
      if (item.status === 'completed') {
        return mutationFailure('invalid_transition', `${item.id} 已完成，不能重新打开。`)
      }
      if (item.status === 'in_progress') return null
      const running = plan.items.find((entry) => entry.status === 'in_progress')
      if (running) {
        return mutationFailure('invalid_transition', `请先处理当前里程碑 ${running.id}。`)
      }
      item.status = 'in_progress'
      item.evidence = []
      return null
    }

    if (transition.status === 'completed') {
      const evidence = transition.evidence.map((entry) => entry.trim()).filter(Boolean)
      if (evidence.length === 0) {
        return mutationFailure('evidence_required', `完成 ${item.id} 必须提供可核验的 evidence。`)
      }
      if (item.status === 'completed') {
        if (sameStrings(item.evidence, evidence)) return null
        return mutationFailure('invalid_transition', `${item.id} 已完成，不能改写完成证据。`)
      }
      if (item.status !== 'in_progress') {
        return mutationFailure('invalid_transition', `${item.id} 必须先进入 in_progress 才能完成。`)
      }
      item.status = 'completed'
      item.evidence = evidence
      return null
    }
    return null
  }

  private finish(plan: ActiveTaskPlan, status: 'completed' | 'ended'): void {
    const closed = taskPlanSchema.parse({
      ...plan,
      status,
      revision: plan.revision + 1,
    })
    this.state.activePlan = null
    this.state.resumeRequired = false
    this.state.interruptionReason = null
    this.stepBoundary = 'close'
    this.publish(closed)
  }

  private publish(plan: TaskPlan): void {
    this.state.version++
    this.stepDirty = true
    this.pendingDisplayPlan = taskPlanSchema.parse(structuredClone(plan))
  }

  private resetStep(): void {
    this.stepSnapshot = null
    this.stepDirty = false
    this.stepBoundary = null
    this.pendingDisplayPlan = null
  }

  private resumeRequiredError(): TaskMutationResult {
    return mutationFailure(
      'resume_required',
      '任务执行已被中断；继续时先调用 ResumeTaskPlan，不再执行时调用 CloseTaskPlan。',
    )
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
    const normalizedDrafts = drafts.map((draft) => ({
      ...draft,
      outcome: draft.outcome.trim(),
    }))
    if (normalizedDrafts.some((draft) => !draft.outcome)) {
      return { error: '里程碑结果描述不能为空。' }
    }
    const items: TaskItem[] = normalizedDrafts.map((draft, index) => ({
      id: `T${index + 1}`,
      kind: draft.kind,
      outcome: draft.outcome,
      status: 'pending',
      evidence: [],
    }))
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

  private progressMessage(plan: ActiveTaskPlan): string {
    const done = plan.items.filter((item) => item.status === 'completed').length
    const current = plan.items.find((item) => item.status === 'in_progress')
    return `计划已更新；进度 ${done}/${plan.items.length}${current ? `，当前里程碑 ${current.id}` : ''}。`
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
