import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import type { TaskMutationResult, TaskPlanController } from './controller.ts'

export const TASK_PLAN_TOOL_NAME = 'TaskPlan'

const initialStatus = z.enum(['pending', 'in_progress']).optional()
const itemId = z.string().regex(/^T\d+$/)

const draftSchema = z.object({
  status: initialStatus,
  kind: z.enum(['work', 'verification']).describe('普通里程碑用 work；最终整体验证用 verification'),
  outcome: z.string().min(1).describe('该里程碑完成后应达到的结果，不写操作步骤'),
}).strict()

const itemChangeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    status: initialStatus,
    outcome: z.string().min(1).describe('新增里程碑应达到的结果'),
    after_item_id: itemId.optional().describe('可选；插在该项之后，默认放在最终验证前'),
  }).strict(),
  z.object({
    action: z.literal('edit'),
    item_id: itemId,
    outcome: z.string().min(1).optional().describe('修订后的结果描述'),
    after_item_id: itemId.optional().describe('可选；同时调整到该项之后'),
    status: z.enum(['in_progress', 'completed']).optional(),
    evidence: z.array(z.string().trim().min(1)).min(1).optional().describe('完成该项的可核验证据'),
  }).strict().superRefine((change, ctx) => {
    if (change.status === undefined && change.outcome === undefined && change.after_item_id === undefined) {
      ctx.addIssue({ code: 'custom', message: 'edit 需要指定状态、结果描述或顺序' })
    }
    if ((change.status === 'completed') !== (change.evidence !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['evidence'], message: '仅在设置 completed 时提供 evidence，且不能为空' })
    }
  }),
  z.object({
    action: z.literal('delete'),
    item_id: itemId,
  }).strict(),
])

export type TaskPlanDraftItem = z.infer<typeof draftSchema>
export type TaskPlanItemChange = z.infer<typeof itemChangeSchema>

const inputSchema = z.strictObject({
  action: z.enum(['create', 'update', 'close']),
  goal: z.string().min(1).optional().describe('create 必填，整个任务最终要达到的可验证结果'),
  items: z.array(draftSchema).min(3).max(7).optional().describe('create 必填，3～7 个宏观里程碑'),
  changes: z.array(itemChangeSchema).min(1).max(14).optional().describe('update 必填，本次的计划项变更'),
}).superRefine((input, ctx) => {
  for (const key of ['goal', 'items', 'changes'] as const) {
    const required = key === 'changes' ? input.action === 'update' : input.action === 'create'
    if (required !== (input[key] !== undefined)) {
      ctx.addIssue({ code: 'custom', path: [key], message: `${input.action} ${required ? '需要' : '不接受'} ${key}` })
    }
  }
})

function toolResult(result: TaskMutationResult) {
  return {
    data: result.ok ? result.message : `${result.error}：${result.message}`,
    isError: !result.ok,
  }
}

/** SDK 可能在执行前拒绝参数，甚至清空无法解析的输入，须按完整响应的调用顺序绑定目标。 */
export function taskPlanCallTargets(
  messages: readonly ModelMessage[],
  activePlanId: string | null,
): ReadonlyMap<string, string> {
  const targets = new Map<string, string>()
  let targetId = activePlanId
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const call of message.content) {
      if (call.type !== 'tool-call' || call.providerExecuted || call.toolName !== TASK_PLAN_TOOL_NAME) continue
      const input = call.input
      const action = typeof input === 'object' && input !== null && 'action' in input ? input.action : undefined
      if (action === 'create') targetId = crypto.randomUUID()
      else if (action !== 'update' && action !== 'close') targetId = null
      if (targetId !== null) targets.set(call.toolCallId, targetId)
    }
  }
  return targets
}

export function createTaskPlanTool(
  controller: TaskPlanController,
  targetForCall: (toolCallId: string) => string | undefined,
): ToolDefinition {
  return buildTool({
    name: TASK_PLAN_TOOL_NAME,
    description: '创建、更新或结束当前任务计划',
    prompt: [
      'action=create 用 goal 和 items 创建 3～7 个结果导向的里程碑，最后一项为整体验证（verification）。建议在建计划时就将接下来要做的项设为 in_progress，可同时指定多项，其余默认 pending。已有活动计划时直接替换。',
      'action=update 用 changes 一次更新一项或多项。T1、T2 等按位置编号，整批引用调用开始时的编号，提交后按新顺序编号。add 新增计划项，edit 修改未完成项的结果、顺序或状态，delete 删除未完成项。开始执行时设为 in_progress，达到预期结果后设为 completed 并为该项提供可核验的 evidence。已完成项只读。',
      'action=close 只填 action。当前计划整体已不再适用，或用户明确放弃时调用。局部调整用 update，暂时等待时保留计划。',
    ].join('\n'),
    inputSchema,
    isReadOnly: false,
    kind: 'control',
    async execute(input, { toolCallId }) {
      const target = toolCallId === undefined ? undefined : targetForCall(toolCallId)
      switch (input.action) {
        case 'create': return toolResult(controller.create(input.goal!, input.items!, target))
        case 'update': return toolResult(controller.update(input.changes!, target ?? null))
        case 'close': return toolResult(controller.close(target ?? null))
      }
    },
  })
}
