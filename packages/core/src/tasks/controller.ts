import {
  activeTaskPlanSchema,
  cloneActiveTaskPlan,
  cloneTaskPlanState,
  emptyTaskPlanState,
  interruptTaskPlanState,
  supersededTaskPlanSchema,
  taskPlanSchema,
  type ActiveTaskPlan,
  type HistoricalTaskPlanSummary,
  type SupersededTaskPlan,
  type TaskItem,
  type TaskItemStatus,
  type TaskPlan,
  type TaskPlanState,
} from './types.ts'

export interface TaskPlanDraftItem {
  kind: 'work' | 'verification'
  title: string
  acceptance: string
}

export type TaskMutationError =
  | 'step_conflict'
  | 'active_plan_exists'
  | 'no_active_plan'
  | 'active_plan_conflict'
  | 'plan_id_mismatch'
  | 'resume_required'
  | 'not_engaged'
  | 'invalid_plan'
  | 'item_not_found'
  | 'invalid_transition'
  | 'evidence_required'
  | 'blocked_reason_required'
  | 'no_state_change'
  | 'incomplete_plan'

export type TaskMutationResult =
  | { ok: true; message: string }
  | { ok: false; error: TaskMutationError; message: string }

function mutationFailure(
  error: TaskMutationError,
  message: string,
): TaskMutationResult {
  return { ok: false, error, message }
}

export type NaturalStopDecision =
  | { kind: 'allow' }
  | { kind: 'pause' }
  | { kind: 'continue'; reminder: string }

export interface TaskPlanCommit {
  state: TaskPlanState
  displayUpdate:
    | { kind: 'updated'; plan: TaskPlan }
    | { kind: 'replaced'; previous: SupersededTaskPlan; plan: ActiveTaskPlan }
}

/**
 * Main 的单活动计划控制器。工具调用先修改内存草稿，只有模型 step 稳定提交后才落盘；
 * urgent/取消/异常丢弃 step 时恢复旧状态，避免会话中出现半截进度。
 */
export class TaskPlanController {
  private state: TaskPlanState
  private stepSnapshot: TaskPlanState | null = null
  private stepDirty = false
  private stepBoundary: 'create' | 'replace' | null = null
  private pendingDisplayUpdate: TaskPlanCommit['displayUpdate'] | null = null

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
    this.pendingDisplayUpdate = null
  }

  commitStep(): TaskPlanCommit | undefined {
    const update = this.stepDirty && this.pendingDisplayUpdate
      ? {
          state: cloneTaskPlanState(this.state),
          displayUpdate: structuredClone(this.pendingDisplayUpdate),
        }
      : undefined
    this.stepSnapshot = null
    this.stepDirty = false
    this.stepBoundary = null
    this.pendingDisplayUpdate = null
    return update
  }

  discardStep(): void {
    if (this.stepDirty && this.stepSnapshot) this.state = cloneTaskPlanState(this.stepSnapshot)
    this.stepSnapshot = null
    this.stepDirty = false
    this.stepBoundary = null
    this.pendingDisplayUpdate = null
  }

  restore(state: TaskPlanState): void {
    this.state = cloneTaskPlanState(state)
    this.stepSnapshot = null
    this.stepDirty = false
    this.stepBoundary = null
    this.pendingDisplayUpdate = null
  }

  create(goal: string, drafts: TaskPlanDraftItem[]): TaskMutationResult {
    if (this.stepDirty) {
      return mutationFailure('step_conflict', 'CreateTaskPlan 必须作为本步骤唯一的计划变更。')
    }
    if (this.state.activePlan) {
      return mutationFailure(
        'active_plan_exists',
        '当前已有 active 计划：验证完成后才能 CloseTaskPlan(completed)；明确切换独立复杂目标时使用 ReplaceTaskPlan；覆盖不明确时先询问。禁止用 CloseTaskPlan(abandoned)+CreateTaskPlan 代替 ReplaceTaskPlan。',
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
      message: `已建立任务计划，共 ${next.plan.items.length} 项；当前执行 ${next.plan.items[0]!.id}。`,
    }
  }

  replace(
    expectedPlanId: string,
    replacementAuthorized: boolean,
    goal: string,
    drafts: TaskPlanDraftItem[],
    reason: string,
  ): TaskMutationResult {
    if (this.stepDirty) {
      return mutationFailure('step_conflict', 'ReplaceTaskPlan 必须作为本步骤唯一的计划变更。')
    }
    const previous = this.state.activePlan
    if (!previous) return mutationFailure('no_active_plan', '当前没有可替换的活动任务计划。')
    if (previous.id !== expectedPlanId) {
      return mutationFailure('plan_id_mismatch', '活动计划已变化，请读取最新任务状态后重新判断。')
    }
    if (!replacementAuthorized) {
      return mutationFailure(
        'active_plan_conflict',
        `当前仍有活动计划“${previous.goal}”；请先确认用户是否授权覆盖。`,
      )
    }
    const normalizedReason = reason.trim()
    if (!normalizedReason) return mutationFailure('invalid_plan', '替换原因不能为空。')
    const next = this.buildPlan(goal, drafts)
    if ('error' in next) return mutationFailure('invalid_plan', next.error)
    const archived = supersededTaskPlanSchema.parse({
      ...previous,
      status: 'superseded',
      revision: previous.revision + 1,
      summary: normalizedReason,
      replacedByPlanId: next.plan.id,
    })
    this.state.activePlan = next.plan
    this.state.historicalPlans.push(this.toHistoricalSummary(archived))
    this.state.resumeRequired = false
    this.state.interruptionReason = null
    this.markDirty()
    this.stepBoundary = 'replace'
    this.pendingDisplayUpdate = {
      kind: 'replaced',
      previous: archived,
      plan: activeTaskPlanSchema.parse(structuredClone(next.plan)),
    }
    const completed = previous.items.filter((item) => item.status === 'completed').length
    return {
      ok: true,
      message: `已归档旧计划“${previous.goal}”（${completed}/${previous.items.length}），并建立新计划；当前执行 ${next.plan.items[0]!.id}。`,
    }
  }

  addItem(draft: TaskPlanDraftItem): TaskMutationResult {
    if (this.stepBoundary) {
      return mutationFailure('step_conflict', '计划身份刚刚变化；请在下一模型步骤再修改任务项。')
    }
    const plan = this.state.activePlan
    if (!plan) return mutationFailure('no_active_plan', '当前没有活动任务计划。')
    if (this.state.resumeRequired) return this.resumeRequiredError()
    if (draft.kind === 'verification') {
      return mutationFailure('invalid_plan', '计划已经有验证步骤，不能重复添加。')
    }
    const title = draft.title.trim()
    const acceptance = draft.acceptance.trim()
    if (!title || !acceptance) {
      return mutationFailure('invalid_plan', '任务项标题和验收标准不能为空。')
    }
    const nextNumber = Math.max(...plan.items.map((item) => Number(item.id.slice(1)))) + 1
    const item: TaskItem = {
      id: `T${nextNumber}`,
      kind: 'work',
      title,
      acceptance,
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
    if (this.stepBoundary) {
      return mutationFailure('step_conflict', '计划身份刚刚变化；请在下一模型步骤再更新任务项。')
    }
    const plan = this.state.activePlan
    if (!plan) return mutationFailure('no_active_plan', '当前没有活动任务计划。')
    if (this.state.resumeRequired) return this.resumeRequiredError()
    const item = plan.items.find((entry) => entry.id === itemId)
    if (!item) return mutationFailure('item_not_found', `任务项不存在：${itemId}`)
    if (item.status === 'completed') {
      return mutationFailure(
        'invalid_transition',
        `${itemId} 已完成；已确认的完成项不能静默重开。`,
      )
    }
    const normalizedEvidence = evidence.map((entry) => entry.trim()).filter(Boolean)
    if (status === 'in_progress') {
      if (item.status === 'in_progress') {
        return mutationFailure(
          'no_state_change',
          `${itemId} 已在进行中；请继续工作，不要用空更新制造进度。`,
        )
      }
      const running = plan.items.find(
        (entry) => entry.status === 'in_progress' && entry.id !== itemId,
      )
      if (running) {
        return mutationFailure(
          'invalid_transition',
          `同一时间只能执行一项；请先处理 ${running.id}。`,
        )
      }
      item.status = 'in_progress'
      item.blockedReason = undefined
    } else if (status === 'completed') {
      if (normalizedEvidence.length === 0) {
        return mutationFailure(
          'evidence_required',
          `完成 ${itemId} 必须提供可核验的 evidence。`,
        )
      }
      item.status = 'completed'
      item.evidence = normalizedEvidence
      item.blockedReason = undefined
      this.startNextPending(plan.items)
    } else {
      if (!blockedReason?.trim()) {
        return mutationFailure(
          'blocked_reason_required',
          `阻塞 ${itemId} 必须说明 blocked_reason。`,
        )
      }
      const normalizedReason = blockedReason.trim()
      if (
        item.status === 'blocked'
        && item.blockedReason === normalizedReason
        && item.evidence.length === normalizedEvidence.length
        && item.evidence.every((entry, index) => entry === normalizedEvidence[index])
      ) {
        return mutationFailure('no_state_change', `${itemId} 的阻塞状态没有实质变化。`)
      }
      item.status = 'blocked'
      item.blockedReason = normalizedReason
      item.evidence = normalizedEvidence
      this.startNextPending(plan.items)
    }
    plan.revision++
    this.publish(plan)
    return { ok: true, message: this.progressMessage(plan, item) }
  }

  close(outcome: 'completed' | 'abandoned', summary: string): TaskMutationResult {
    if (this.stepBoundary) {
      return mutationFailure('step_conflict', '计划身份刚刚变化；请在下一模型步骤再关闭计划。')
    }
    const plan = this.state.activePlan
    if (!plan) return mutationFailure('no_active_plan', '当前没有活动任务计划。')
    if (outcome === 'completed' && plan.items.some((item) => item.status !== 'completed')) {
      return mutationFailure(
        'incomplete_plan',
        '仍有未完成或阻塞的任务项，不能把整个计划标记为完成。',
      )
    }
    const normalizedSummary = summary.trim()
    if (!normalizedSummary) return mutationFailure('invalid_plan', '计划总结不能为空。')
    const closed = taskPlanSchema.parse({
      ...plan,
      status: outcome,
      revision: plan.revision + 1,
      summary: normalizedSummary,
    })
    if (closed.status === 'active') throw new Error('关闭计划产生了无效活动状态')
    this.state.activePlan = null
    this.state.historicalPlans.push(this.toHistoricalSummary(closed))
    this.state.resumeRequired = false
    this.state.interruptionReason = null
    this.publish(closed)
    return {
      ok: true,
      message: outcome === 'completed' ? '任务计划已核验完成。' : '任务计划已明确放弃。',
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

  naturalStopDecision(): NaturalStopDecision {
    const plan = this.state.activePlan
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
    this.markDirty()
    this.pendingDisplayUpdate = {
      kind: 'updated',
      plan: taskPlanSchema.parse(structuredClone(plan)),
    }
  }

  private markDirty(): void {
    this.state.version++
    this.stepDirty = true
  }

  private resumeRequiredError(): TaskMutationResult {
    return mutationFailure(
      'resume_required',
      '任务执行已被中断；请先调用 ResumeTaskPlan，或按用户明确意图替换/结束计划。',
    )
  }

  private toHistoricalSummary(plan: TaskPlan): HistoricalTaskPlanSummary {
    if (plan.status === 'active') throw new Error('活动计划不能写入历史目录')
    return {
      id: plan.id,
      goal: plan.goal,
      status: plan.status,
      summary: plan.summary,
      completedItems: plan.items.filter((item) => item.status === 'completed').length,
      totalItems: plan.items.length,
      revision: plan.revision,
    }
  }

  private buildPlan(
    goal: string,
    drafts: TaskPlanDraftItem[],
  ): { plan: ActiveTaskPlan } | { error: string } {
    const normalizedGoal = goal.trim()
    if (!normalizedGoal) return { error: '计划目标不能为空。' }
    if (drafts.at(-1)?.kind !== 'verification') {
      return { error: '计划最后一项必须是 verification 验证步骤。' }
    }
    if (drafts.filter((item) => item.kind === 'verification').length !== 1) {
      return { error: '一个计划必须且只能包含一个 verification 验证步骤。' }
    }
    const normalizedDrafts = drafts.map((draft) => ({
      ...draft,
      title: draft.title.trim(),
      acceptance: draft.acceptance.trim(),
    }))
    if (normalizedDrafts.some((draft) => !draft.title || !draft.acceptance)) {
      return { error: '任务项标题和验收标准不能为空。' }
    }
    const items: TaskItem[] = normalizedDrafts.map((draft, index) => ({
      id: `T${index + 1}`,
      kind: draft.kind,
      title: draft.title,
      acceptance: draft.acceptance,
      status: index === 0 ? 'in_progress' : 'pending',
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
