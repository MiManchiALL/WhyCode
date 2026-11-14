import { z } from 'zod'

export const taskItemStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
])

export const taskItemSchema = z.object({
  id: z.string().regex(/^T\d+$/),
  kind: z.enum(['work', 'verification']),
  outcome: z.string().min(1),
  status: taskItemStatusSchema,
  evidence: z.array(z.string().min(1)),
}).strict().superRefine((item, ctx) => {
  if (item.status === 'completed' && item.evidence.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'completed 任务项必须包含完成证据' })
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

export const endedTaskPlanSchema = taskPlanBaseSchema.extend({
  status: z.literal('ended'),
})

export type CompletedTaskPlan = z.infer<typeof completedTaskPlanSchema>

export const terminalTaskPlanSchema = z.discriminatedUnion('status', [completedTaskPlanSchema, endedTaskPlanSchema])
export type TerminalTaskPlan = z.infer<typeof terminalTaskPlanSchema>

export const taskPlanSchema = z.discriminatedUnion('status', [
  activeTaskPlanSchema.transform(resolveTaskPlanProgress),
  completedTaskPlanSchema,
  endedTaskPlanSchema,
])

export type TaskItemStatus = z.infer<typeof taskItemStatusSchema>
export type TaskItem = z.infer<typeof taskItemSchema>
export type ActiveTaskPlan = z.infer<typeof activeTaskPlanSchema>
export type TaskPlan = z.infer<typeof taskPlanSchema>

export function resolveTaskPlanProgress(plan: ActiveTaskPlan): ActiveTaskPlan | CompletedTaskPlan {
  return plan.items.every(item => item.status === 'completed') ? { ...plan, status: 'completed' } : plan
}

export const taskPlanStateSchema = z.object({
  version: z.number().int().nonnegative(),
  activePlan: activeTaskPlanSchema.nullable(),
})

export type TaskPlanState = z.infer<typeof taskPlanStateSchema>

export function emptyTaskPlanState(): TaskPlanState {
  return {
    version: 0,
    activePlan: null,
  }
}

export function cloneTaskPlanState(state: TaskPlanState): TaskPlanState {
  const copy = taskPlanStateSchema.parse(state)
  if (copy.activePlan && resolveTaskPlanProgress(copy.activePlan).status === 'completed') copy.activePlan = null
  return copy
}
