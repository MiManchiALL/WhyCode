import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import type { TaskMutationResult, TaskPlanController } from './controller.ts'

export const CREATE_TASK_PLAN_TOOL_NAME = 'CreateTaskPlan'
export const UPDATE_TASK_ITEM_TOOL_NAME = 'UpdateTaskItem'
export const CLOSE_TASK_PLAN_TOOL_NAME = 'CloseTaskPlan'

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

function toolResult(result: TaskMutationResult) {
  return {
    data: result.ok ? result.message : `${result.error}：${result.message}`,
    isError: !result.ok,
  }
}

export function createTaskPlanTools(controller: TaskPlanController): ToolDefinition[] {
  return [
    buildTool({
      name: CREATE_TASK_PLAN_TOOL_NAME,
      description: '为复杂目标建立宏观任务计划',
      prompt:
        '创建 3～7 个结果导向的里程碑，最后一项为整体验证（verification）。建议在建计划时就将接下来要做的项设为 in_progress，可同时指定多项，其余默认 pending。已有活动计划时直接替换。本工具独占一个模型步骤。',
      inputSchema: z.object({
        goal: z.string().min(1).describe('整个任务最终要达到的可验证结果'),
        items: z.array(draftSchema).min(3).max(7).describe('3～7 个宏观里程碑'),
      }).strict(),
      isReadOnly: false,
      kind: 'control',
      requiresStandaloneStep: true,
      async execute(input) {
        return toolResult(controller.create(input.goal, input.items))
      },
    }),
    buildTool({
      name: UPDATE_TASK_ITEM_TOOL_NAME,
      description: '调整计划项及其进度',
      prompt:
        '用 changes 一次更新一项或多项。T1、T2 等按位置编号，整批引用调用开始时的编号，提交后按新顺序编号。add 新增计划项，edit 修改未完成项的结果、顺序或状态，delete 删除未完成项。开始执行时设为 in_progress，达到预期结果后设为 completed 并为该项提供可核验的 evidence。已完成项及其证据不可修改。',
      inputSchema: z.object({
        changes: z.array(itemChangeSchema).min(1).max(14),
      }).strict(),
      isReadOnly: false,
      kind: 'control',
      async execute(input) {
        return toolResult(controller.update(input.changes))
      },
    }),
    buildTool({
      name: CLOSE_TASK_PLAN_TOOL_NAME,
      description: '显式结束当前活动计划',
      prompt:
        `当前计划整体已不再适用，或用户明确放弃时调用。局部调整用 ${UPDATE_TASK_ITEM_TOOL_NAME}，暂时等待时保留计划。无参数，独占一个模型步骤。`,
      inputSchema: z.object({}).strict(),
      isReadOnly: false,
      kind: 'control',
      requiresStandaloneStep: true,
      async execute() {
        return toolResult(controller.close())
      },
    }),
  ]
}
