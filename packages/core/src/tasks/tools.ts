import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import { TaskPlanController } from './controller.ts'

export const CREATE_TASK_PLAN_TOOL_NAME = 'CreateTaskPlan'
export const ADD_TASK_ITEM_TOOL_NAME = 'AddTaskItem'
export const UPDATE_TASK_ITEM_TOOL_NAME = 'UpdateTaskItem'
export const CLOSE_TASK_PLAN_TOOL_NAME = 'CloseTaskPlan'

const draftSchema = z.object({
  kind: z.enum(['work', 'verification']).describe('工作项用 work；最终验收项用 verification'),
  title: z.string().min(1).describe('清晰、可执行的任务项标题'),
  acceptance: z.string().min(1).describe('可核验的完成标准'),
})

/** Main 专用控制面工具：kind=read 表示不触碰外部资源，因此无需审批或资源检查点。 */
export function createTaskPlanTools(controller: TaskPlanController): ToolDefinition[] {
  return [
    buildTool({
      name: CREATE_TASK_PLAN_TOOL_NAME,
      description: '为复杂任务建立可持久化计划',
      prompt:
        '仅用于需要至少三个实质步骤或可能跨压缩/重启的复杂任务。创建目标与有序任务项；最后一项必须是唯一的 verification 验证步骤。简单问答或一步操作不要创建计划。',
      inputSchema: z.object({
        goal: z.string().min(1).describe('整个任务最终要达成的可验证目标'),
        items: z.array(draftSchema).min(2).max(20).describe('有序任务项，最后一项必须验证整体结果'),
      }),
      isReadOnly: false,
      kind: 'read',
      availableWithoutProject: true,
      async execute(input) {
        const result = controller.create(input.goal, input.items)
        return { data: result.message, isError: !result.ok }
      },
    }),
    buildTool({
      name: ADD_TASK_ITEM_TOOL_NAME,
      description: '向活动计划添加新发现的工作项',
      prompt:
        '执行过程中发现必要的新工作时添加任务项。新工作会插入最终验证步骤之前；不要为细碎的单次工具调用创建任务项。',
      inputSchema: z.object({
        title: z.string().min(1).describe('新增工作项标题'),
        acceptance: z.string().min(1).describe('新增工作项的可核验完成标准'),
      }),
      isReadOnly: false,
      kind: 'read',
      availableWithoutProject: true,
      async execute(input) {
        const result = controller.addItem({ ...input, kind: 'work' })
        return { data: result.message, isError: !result.ok }
      },
    }),
    buildTool({
      name: UPDATE_TASK_ITEM_TOOL_NAME,
      description: '更新当前任务项的状态和证据',
      prompt:
        '开始、完成或阻塞任务项。completed 必须提供真实可核验的 evidence；blocked 必须说明 blocked_reason。控制器会在完成/阻塞后自动启动下一 pending 项。',
      inputSchema: z.object({
        item_id: z.string().regex(/^T\d+$/).describe('任务项 ID，例如 T2'),
        status: z.enum(['in_progress', 'completed', 'blocked']).describe('任务项新状态'),
        evidence: z.array(z.string().min(1)).optional().describe('文件、测试结果或其它完成证据'),
        blocked_reason: z.string().min(1).optional().describe('标记 blocked 时必填'),
      }),
      isReadOnly: false,
      kind: 'read',
      availableWithoutProject: true,
      async execute(input) {
        const result = controller.updateItem(
          input.item_id,
          input.status,
          input.evidence ?? [],
          input.blocked_reason,
        )
        return { data: result.message, isError: !result.ok }
      },
    }),
    buildTool({
      name: CLOSE_TASK_PLAN_TOOL_NAME,
      description: '完成或明确放弃整个任务计划',
      prompt:
        '所有任务项（包括 verification）都有证据并完成后，调用 completed。只有用户改变目标或明确不再继续时才调用 abandoned，并解释原因。阻塞时不要关闭计划，保留它等待后续继续。',
      inputSchema: z.object({
        outcome: z.enum(['completed', 'abandoned']).describe('计划最终状态'),
        summary: z.string().min(1).describe('完成结果或放弃原因'),
      }),
      isReadOnly: false,
      kind: 'read',
      availableWithoutProject: true,
      async execute(input) {
        const result = controller.close(input.outcome, input.summary)
        return { data: result.message, isError: !result.ok }
      },
    }),
  ]
}
