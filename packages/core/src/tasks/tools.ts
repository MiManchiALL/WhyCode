import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import { formatTaskToolResult } from './context.ts'
import {
  TaskPlanController,
  type TaskMutationResult,
  type TaskPlanItemChange,
  type TaskPlanTransition,
} from './controller.ts'

export const CREATE_TASK_PLAN_TOOL_NAME = 'CreateTaskPlan'
export const RESUME_TASK_PLAN_TOOL_NAME = 'ResumeTaskPlan'
export const UPDATE_TASK_ITEM_TOOL_NAME = 'UpdateTaskItem'
export const CLOSE_TASK_PLAN_TOOL_NAME = 'CloseTaskPlan'

export interface TaskPlanEngagementAction {
  type: 'resume'
  planId: string
}

interface TaskPlanToolCallbacks {
  onEngagementAction: (action: TaskPlanEngagementAction) => void
  isEngaged: () => boolean
}

const draftSchema = z.object({
  kind: z.enum(['work', 'verification']).describe('普通里程碑用 work；最终整体验证用 verification'),
  outcome: z.string().min(1).describe('该里程碑完成后应达到的结果，不写操作步骤'),
}).strict()

const itemChangeSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    outcome: z.string().min(1).describe('新增里程碑应达到的结果'),
    after_item_id: z.string().regex(/^T\d+$/).optional().describe('可选；插在该项之后，默认放在最终验证前'),
  }).strict(),
  z.object({
    action: z.literal('edit'),
    item_id: z.string().regex(/^T\d+$/),
    outcome: z.string().min(1).optional().describe('修订后的结果描述'),
    after_item_id: z.string().regex(/^T\d+$/).optional().describe('可选；同时调整到该项之后'),
  }).strict().refine((change) => change.outcome !== undefined || change.after_item_id !== undefined, {
    message: 'edit 必须修改结果或顺序',
  }),
  z.object({
    action: z.literal('delete'),
    item_id: z.string().regex(/^T\d+$/),
  }).strict(),
])

const updateInputSchema = z.object({
  changes: z.array(itemChangeSchema).min(1).max(14).optional()
    .describe('可选；原子添加、修改、删除或重排当前与未来里程碑'),
  item_id: z.string().regex(/^T\d+$/).optional().describe('可选；要设置状态的里程碑 ID，与 status 同时提供'),
  status: z.enum(['in_progress', 'completed']).optional()
    .describe('可选；里程碑的目标状态，与 item_id 同时提供'),
  evidence: z.array(z.string().min(1)).min(1).optional()
    .describe('completed 必填；里程碑的可核验完成证据'),
}).strict().superRefine((input, context) => {
  const hasItemId = input.item_id !== undefined
  const hasStatus = input.status !== undefined
  if (input.changes === undefined && !hasItemId && !hasStatus) {
    context.addIssue({ code: 'custom', message: '必须提供 changes 或 item_id/status' })
  }
  if (hasItemId !== hasStatus) {
    context.addIssue({ code: 'custom', message: 'item_id 与 status 必须同时提供' })
  }
  if (input.status === 'completed' && input.evidence === undefined) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'completed 必须提供 evidence' })
  }
  if (input.status !== 'completed' && input.evidence !== undefined) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: '只有 completed 可以提供 evidence' })
  }
})

function toolResult(
  controller: TaskPlanController,
  operation: string,
  result: TaskMutationResult,
  grantsEngagement: boolean,
): { data: string; isError: boolean } {
  const activePlan = controller.snapshot
  return {
    data: formatTaskToolResult(
      operation,
      result,
      controller.stateSnapshot,
      result.ok && grantsEngagement ? activePlan?.id : undefined,
    ),
    isError: !result.ok,
  }
}

/** Main 专用控制工具；工具集合和 schema 在会话内保持稳定。 */
export function createTaskPlanTools(
  controller: TaskPlanController,
  callbacks: TaskPlanToolCallbacks,
): ToolDefinition[] {
  return [
    buildTool({
      name: CREATE_TASK_PLAN_TOOL_NAME,
      description: '为复杂目标建立宏观任务计划',
      prompt:
        '先定向扫描关键文件形成整体认知，再创建 3～7 个结果导向里程碑；不写详细步骤，最后一项必须是唯一 verification。创建后全部为 pending，下一步骤显式进入首项。本工具独占模型步骤。',
      inputSchema: z.object({
        goal: z.string().min(1).describe('整个任务最终要达到的可验证结果'),
        items: z.array(draftSchema).min(3).max(7).describe('3～7 个宏观里程碑'),
      }).strict(),
      isReadOnly: false,
      kind: 'control',
      requiresStandaloneStep: true,
      async execute(input) {
        return toolResult(
          controller,
          CREATE_TASK_PLAN_TOOL_NAME,
          controller.create(input.goal, input.items),
          true,
        )
      },
    }),
    buildTool({
      name: RESUME_TASK_PLAN_TOOL_NAME,
      description: '让当前执行接合保存的活动计划',
      prompt:
        '用户明确继续当前计划时调用；interrupted 或 dormant 都无需重复确认。接合后若没有进行中项，先显式进入下一项，再检查相关代码并实施。本工具独占模型步骤。',
      inputSchema: z.object({
        plan_id: z.string().uuid().describe('当前 active_plan 的 ID'),
      }).strict(),
      isReadOnly: false,
      kind: 'control',
      requiresStandaloneStep: true,
      async execute(input) {
        const result = controller.resume(input.plan_id)
        if (result.ok) callbacks.onEngagementAction({ type: 'resume', planId: input.plan_id })
        return toolResult(controller, RESUME_TASK_PLAN_TOOL_NAME, result, true)
      },
    }),
    buildTool({
      name: UPDATE_TASK_ITEM_TOOL_NAME,
      description: '原子调整活动计划并推进任务项状态',
      prompt:
        '用 changes 原子增删改排当前或未来里程碑；用顶层 item_id/status 设置目标状态，该操作幂等。开始里程碑时设为 in_progress；达到 outcome 后附真实 evidence 设为 completed。完成或删除当前项不自动开始下一项；禁止重复 outcome，已完成项不可修改。',
      inputSchema: updateInputSchema,
      isReadOnly: false,
      kind: 'control',
      async execute(input) {
        if (!callbacks.isEngaged()) {
          return toolResult(
            controller,
            UPDATE_TASK_ITEM_TOOL_NAME,
            {
              ok: false,
              error: 'not_engaged',
              message: 'UpdateTaskItem 只能在当前执行已接合计划后调用。',
            },
            false,
          )
        }
        const changes: TaskPlanItemChange[] = (input.changes ?? []).map((change) => {
          if (change.action === 'add') {
            return {
              action: 'add',
              outcome: change.outcome,
              ...(change.after_item_id ? { afterItemId: change.after_item_id } : {}),
            }
          }
          if (change.action === 'delete') return { action: 'delete', itemId: change.item_id }
          return {
            action: 'edit',
            itemId: change.item_id,
            ...(change.outcome !== undefined ? { outcome: change.outcome } : {}),
            ...(change.after_item_id ? { afterItemId: change.after_item_id } : {}),
          }
        })
        const transition: TaskPlanTransition | undefined = input.item_id && input.status
          ? input.status === 'in_progress'
            ? { itemId: input.item_id, status: 'in_progress' }
            : {
                itemId: input.item_id,
                status: 'completed',
                evidence: input.evidence!,
              }
          : undefined
        return toolResult(
          controller,
          UPDATE_TASK_ITEM_TOOL_NAME,
          controller.update(changes, transition),
          true,
        )
      },
    }),
    buildTool({
      name: CLOSE_TASK_PLAN_TOOL_NAME,
      description: '显式结束当前活动计划',
      prompt:
        '仅在用户放弃当前计划或确认切换独立目标时调用；正常最终答复会由会话协议自动结束计划，无需调用。切换时先结束，下一步骤扫描关键文件后再 CreateTaskPlan。本工具独占模型步骤。',
      inputSchema: z.object({}).strict(),
      isReadOnly: false,
      kind: 'control',
      requiresStandaloneStep: true,
      async execute() {
        return toolResult(
          controller,
          CLOSE_TASK_PLAN_TOOL_NAME,
          controller.close(),
          false,
        )
      },
    }),
  ]
}
