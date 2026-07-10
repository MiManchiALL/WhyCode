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
])

export type TaskItemStatus = z.infer<typeof taskItemStatusSchema>
export type TaskItem = z.infer<typeof taskItemSchema>
export type ActiveTaskPlan = z.infer<typeof activeTaskPlanSchema>
export type TaskPlan = z.infer<typeof taskPlanSchema>

export type TaskPlanStepUpdate = ActiveTaskPlan | null | undefined

export function cloneActiveTaskPlan(plan: ActiveTaskPlan | null): ActiveTaskPlan | null {
  return plan ? activeTaskPlanSchema.parse(structuredClone(plan)) : null
}
