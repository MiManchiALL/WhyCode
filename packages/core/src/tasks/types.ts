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
  outcome: z.string().min(1),
  status: taskItemStatusSchema,
  evidence: z.array(z.string().min(1)),
  blockedReason: z.string().min(1).optional(),
}).strict().superRefine((item, ctx) => {
  if (item.status === 'completed' && item.evidence.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'completed 任务项必须包含完成证据' })
  }
  if (item.status === 'blocked' && !item.blockedReason) {
    ctx.addIssue({ code: 'custom', message: 'blocked 任务项必须包含阻塞原因' })
  }
  if (item.status !== 'blocked' && item.blockedReason) {
    ctx.addIssue({ code: 'custom', message: '只有 blocked 任务项可以包含阻塞原因' })
  }
  if ((item.status === 'pending' || item.status === 'in_progress') && item.evidence.length > 0) {
    ctx.addIssue({ code: 'custom', message: '未完成任务项不能包含完成证据' })
  }
})

const taskItemsSchema = z.array(taskItemSchema).min(2).max(7).superRefine((items, ctx) => {
  const ids = items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: '计划任务项 ID 必须唯一' })
  }
  const verificationIndexes = items.flatMap((item, index) =>
    item.kind === 'verification' ? [index] : [],
  )
  if (verificationIndexes.length !== 1 || verificationIndexes[0] !== items.length - 1) {
    ctx.addIssue({ code: 'custom', message: '计划最后一项必须是唯一的 verification' })
  }
  const running = items.filter((item) => item.status === 'in_progress').length
  if (running > 1) {
    ctx.addIssue({ code: 'custom', message: '计划至多只能有一个进行中项' })
  }
})

const taskPlanBaseSchema = z.object({
  id: z.string().uuid(),
  goal: z.string().min(1),
  items: taskItemsSchema,
  revision: z.number().int().positive(),
}).strict()

export const activeTaskPlanSchema = taskPlanBaseSchema.extend({
  status: z.literal('active'),
})

export const completedTaskPlanSchema = taskPlanBaseSchema.extend({
  status: z.literal('completed'),
}).superRefine((plan, ctx) => {
  if (plan.items.some((item) => item.status !== 'completed')) {
    ctx.addIssue({ code: 'custom', message: 'completed 计划的全部任务项都必须完成' })
  }
})

export const abandonedTaskPlanSchema = taskPlanBaseSchema.extend({
  status: z.literal('abandoned'),
})

export const taskPlanSchema = z.discriminatedUnion('status', [
  activeTaskPlanSchema,
  completedTaskPlanSchema,
  abandonedTaskPlanSchema,
])

export type TaskItemStatus = z.infer<typeof taskItemStatusSchema>
export type TaskItem = z.infer<typeof taskItemSchema>
export type ActiveTaskPlan = z.infer<typeof activeTaskPlanSchema>
export type TaskPlan = z.infer<typeof taskPlanSchema>

export const taskPlanStateSchema = z.object({
  version: z.number().int().nonnegative(),
  activePlan: activeTaskPlanSchema.nullable(),
  resumeRequired: z.boolean(),
  interruptionReason: z
    .enum(['user-cancel', 'process-interruption', 'consensus-failure'])
    .nullable(),
}).strict().superRefine((state, ctx) => {
  if (state.resumeRequired !== Boolean(state.interruptionReason)) {
    ctx.addIssue({ code: 'custom', message: 'resumeRequired 与 interruptionReason 必须同时存在或清空' })
  }
  if (!state.activePlan && state.resumeRequired) {
    ctx.addIssue({ code: 'custom', message: '没有 activePlan 时不能要求恢复' })
  }
})

export type TaskPlanState = z.infer<typeof taskPlanStateSchema>
export type TaskPlanStepUpdate = TaskPlanState | undefined

export function cloneActiveTaskPlan(plan: ActiveTaskPlan | null): ActiveTaskPlan | null {
  return plan ? activeTaskPlanSchema.parse(structuredClone(plan)) : null
}

export function emptyTaskPlanState(): TaskPlanState {
  return {
    version: 0,
    activePlan: null,
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
