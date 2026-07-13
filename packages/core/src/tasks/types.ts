import { z } from 'zod'

export const taskItemStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'blocked',
])

export const taskItemSchema = z.object({
  id: z.string().regex(/^T\d+$/),
  kind: z.enum(['work', 'verification']),
  title: z.string().min(1),
  acceptance: z.string().min(1),
  status: taskItemStatusSchema,
  evidence: z.array(z.string().min(1)),
  blockedReason: z.string().min(1).optional(),
}).superRefine((item, ctx) => {
  if (item.status === 'completed' && item.evidence.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'completed 任务项必须包含完成证据' })
  }
  if (item.status === 'blocked' && !item.blockedReason) {
    ctx.addIssue({ code: 'custom', message: 'blocked 任务项必须包含阻塞原因' })
  }
})

const taskItemsSchema = z.array(taskItemSchema).min(2).max(20).superRefine((items, ctx) => {
  const verificationIndexes = items.flatMap((item, index) =>
    item.kind === 'verification' ? [index] : [],
  )
  if (verificationIndexes.length !== 1 || verificationIndexes[0] !== items.length - 1) {
    ctx.addIssue({ code: 'custom', message: '计划最后一项必须是唯一的 verification' })
  }
  const running = items.filter((item) => item.status === 'in_progress').length
  if (running > 1 || (running === 0 && items.some((item) => item.status === 'pending'))) {
    ctx.addIssue({ code: 'custom', message: '计划必须至多有一个进行中项，存在 pending 时必须有进行中项' })
  }
})

export const activeTaskPlanSchema = z.object({
  id: z.string().uuid(),
  goal: z.string().min(1),
  status: z.literal('active'),
  items: taskItemsSchema,
  revision: z.number().int().positive(),
})

export const supersededTaskPlanSchema = activeTaskPlanSchema.extend({
  status: z.literal('superseded'),
  summary: z.string().min(1),
  replacedByPlanId: z.string().uuid(),
})

export const taskPlanSchema = z.discriminatedUnion('status', [
  activeTaskPlanSchema,
  activeTaskPlanSchema.extend({
    status: z.literal('completed'),
    summary: z.string().min(1),
  }),
  activeTaskPlanSchema.extend({
    status: z.literal('abandoned'),
    summary: z.string().min(1),
  }),
  supersededTaskPlanSchema,
])

export type TaskItemStatus = z.infer<typeof taskItemStatusSchema>
export type TaskItem = z.infer<typeof taskItemSchema>
export type ActiveTaskPlan = z.infer<typeof activeTaskPlanSchema>
export type SupersededTaskPlan = z.infer<typeof supersededTaskPlanSchema>
export type TaskPlan = z.infer<typeof taskPlanSchema>

export const historicalTaskPlanSummarySchema = z.object({
  id: z.string().uuid(),
  goal: z.string().min(1),
  status: z.enum(['completed', 'abandoned', 'superseded']),
  summary: z.string().min(1),
  completedItems: z.number().int().nonnegative(),
  totalItems: z.number().int().positive(),
  revision: z.number().int().positive(),
}).superRefine((plan, ctx) => {
  if (plan.completedItems > plan.totalItems) {
    ctx.addIssue({ code: 'custom', message: '历史计划的完成项不能超过总项数' })
  }
})

export const taskPlanStateSchema = z.object({
  version: z.number().int().nonnegative(),
  activePlan: activeTaskPlanSchema.nullable(),
  historicalPlans: z.array(historicalTaskPlanSummarySchema),
  resumeRequired: z.boolean(),
  interruptionReason: z
    .enum(['user-cancel', 'process-interruption', 'consensus-failure'])
    .nullable(),
}).superRefine((state, ctx) => {
  if (state.resumeRequired !== Boolean(state.interruptionReason)) {
    ctx.addIssue({ code: 'custom', message: 'resumeRequired 与 interruptionReason 必须同时存在或清空' })
  }
  if (!state.activePlan && state.resumeRequired) {
    ctx.addIssue({ code: 'custom', message: '没有 activePlan 时不能要求恢复' })
  }
  const ids = state.historicalPlans.map((plan) => plan.id)
  if (new Set(ids).size !== ids.length || ids.includes(state.activePlan?.id ?? '')) {
    ctx.addIssue({ code: 'custom', message: '活动计划和历史计划 ID 必须唯一' })
  }
})

export type HistoricalTaskPlanSummary = z.infer<typeof historicalTaskPlanSummarySchema>
export type TaskPlanState = z.infer<typeof taskPlanStateSchema>
export type TaskPlanStepUpdate = TaskPlanState | undefined

export function cloneActiveTaskPlan(plan: ActiveTaskPlan | null): ActiveTaskPlan | null {
  return plan ? activeTaskPlanSchema.parse(structuredClone(plan)) : null
}

export function emptyTaskPlanState(): TaskPlanState {
  return {
    version: 0,
    activePlan: null,
    historicalPlans: [],
    resumeRequired: false,
    interruptionReason: null,
  }
}

export function cloneTaskPlanState(state: TaskPlanState): TaskPlanState {
  return taskPlanStateSchema.parse(structuredClone(state))
}

export function interruptTaskPlanState(
  state: TaskPlanState,
  reason: NonNullable<TaskPlanState['interruptionReason']>,
): TaskPlanState {
  const next = cloneTaskPlanState(state)
  if (!next.activePlan) return next
  if (next.resumeRequired && next.interruptionReason === reason) return next
  next.version++
  next.resumeRequired = true
  next.interruptionReason = reason
  return taskPlanStateSchema.parse(next)
}
