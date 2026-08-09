import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import { formatTaskToolResult } from './context.ts'
import { TaskPlanController, type TaskMutationResult } from './controller.ts'

export const CREATE_TASK_PLAN_TOOL_NAME = 'CreateTaskPlan'
export const RESUME_TASK_PLAN_TOOL_NAME = 'ResumeTaskPlan'
export const REPLACE_TASK_PLAN_TOOL_NAME = 'ReplaceTaskPlan'
export const ADD_TASK_ITEM_TOOL_NAME = 'AddTaskItem'
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
  kind: z.enum(['work', 'verification']).describe('工作项用 work；最终验收项用 verification'),
  title: z.string().min(1).describe('清晰、可执行的任务项标题'),
  acceptance: z.string().min(1).describe('可核验的完成标准'),
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

/** Main 专用控制面工具；Schema 在整个会话内保持稳定，状态合法性由控制器校验。 */
export function createTaskPlanTools(
  controller: TaskPlanController,
  callbacks: TaskPlanToolCallbacks,
): ToolDefinition[] {
  return [
    buildTool({
      name: CREATE_TASK_PLAN_TOOL_NAME,
      description: '为复杂任务建立可持久化计划',
      prompt:
        '复杂性按顶层目标判断；包含多个实质步骤、可能跨压缩或需多轮验证时，在首次写入或长测试前调用。已有 active 时，明确切换用 ReplaceTaskPlan，否则先询问；禁止 Close+Create。最后一项必须是唯一 verification；本工具独占模型步骤。',
      inputSchema: z.object({
        goal: z.string().min(1).describe('整个任务最终要达成的可验证目标'),
        items: z.array(draftSchema).min(2).max(20).describe('有序任务项，最后一项验证整体结果'),
      }),
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
        '最新用户明确要求继续或恢复 active 时调用，无论当前是 blocked 还是 dormant，均无需重复确认。成功后检查实际代码和运行状态再继续；本工具独占模型步骤。',
      inputSchema: z.object({
        plan_id: z.string().uuid().describe('TaskState 中当前 active_plan 的 ID'),
      }),
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
      name: REPLACE_TASK_PLAN_TOOL_NAME,
      description: '原子归档当前计划并建立独立的新复杂任务',
      prompt:
        'active 下切换独立复杂目标的唯一入口。用户明确表示放弃/替换/切换当前目标，或明确指定恢复某个历史目标，才算授权；仅提出或要求开始另一目标不算，不明确时先询问。恢复历史目标前先只读检查并重新规划；本工具独占模型步骤。',
      inputSchema: z.object({
        expected_active_plan_id: z.string().uuid().describe('调用前 TaskState 中的 active_plan ID'),
        replacement_authorized: z.boolean().describe('最新用户消息是否明确授权覆盖当前计划'),
        goal: z.string().min(1).describe('新任务最终要达成的可验证目标'),
        items: z.array(draftSchema).min(2).max(20).describe('重新规划的任务项，最后一项验证整体结果'),
        reason: z.string().min(1).describe('用户为什么明确授权切换当前计划'),
      }),
      isReadOnly: false,
      kind: 'control',
      requiresStandaloneStep: true,
      async execute(input) {
        const result = controller.replace(
          input.expected_active_plan_id,
          input.replacement_authorized,
          input.goal,
          input.items,
          input.reason,
        )
        return toolResult(controller, REPLACE_TASK_PLAN_TOOL_NAME, result, true)
      },
    }),
    buildTool({
      name: ADD_TASK_ITEM_TOOL_NAME,
      description: '向活动计划添加必要工作项',
      prompt: '发现计划遗漏的必要工作时使用；新项插在最终验证前，不为单次工具调用建项。',
      inputSchema: z.object({
        title: z.string().min(1).describe('新增工作项标题'),
        acceptance: z.string().min(1).describe('新增工作项的可核验完成标准'),
      }),
      isReadOnly: false,
      kind: 'control',
      async execute(input) {
        if (!callbacks.isEngaged()) {
          return toolResult(
            controller,
            ADD_TASK_ITEM_TOOL_NAME,
            {
              ok: false,
              error: 'not_engaged',
              message: 'AddTaskItem 只能在当前 execution run 已接合计划后调用。',
            },
            false,
          )
        }
        return toolResult(
          controller,
          ADD_TASK_ITEM_TOOL_NAME,
          controller.addItem({ ...input, kind: 'work' }),
          true,
        )
      },
    }),
    buildTool({
      name: UPDATE_TASK_ITEM_TOOL_NAME,
      description: '更新活动计划任务项的状态和证据',
      prompt:
        '开始、完成或阻塞任务项。completed 必须提供真实 evidence；blocked 必须说明 blocked_reason。硬中断后的计划必须先 Resume。',
      inputSchema: z.object({
        item_id: z.string().regex(/^T\d+$/).describe('任务项 ID，例如 T2'),
        status: z.enum(['in_progress', 'completed', 'blocked']).describe('任务项新状态'),
        evidence: z.array(z.string().min(1)).optional().describe('文件、测试结果或其它证据'),
        blocked_reason: z.string().min(1).optional().describe('标记 blocked 时必填'),
      }),
      isReadOnly: false,
      kind: 'control',
      async execute(input) {
        const result = controller.updateItem(
          input.item_id,
          input.status,
          input.evidence ?? [],
          input.blocked_reason,
        )
        return toolResult(controller, UPDATE_TASK_ITEM_TOOL_NAME, result, true)
      },
    }),
    buildTool({
      name: CLOSE_TASK_PLAN_TOOL_NAME,
      description: '完成或明确放弃整个活动计划',
      prompt:
        '全部任务项通过验证后 completed；只有用户明确不再继续且没有替代目标时才 abandoned。有替代目标必须 ReplaceTaskPlan，禁止 abandoned 后 Create。真实阻塞或自然语言暂缓不关闭计划。',
      inputSchema: z.object({
        outcome: z.enum(['completed', 'abandoned']).describe('计划最终状态'),
        summary: z.string().min(1).describe('完成结果或放弃原因'),
      }),
      isReadOnly: false,
      kind: 'control',
      async execute(input) {
        return toolResult(
          controller,
          CLOSE_TASK_PLAN_TOOL_NAME,
          controller.close(input.outcome, input.summary),
          false,
        )
      },
    }),
  ]
}
