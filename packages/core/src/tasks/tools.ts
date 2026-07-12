import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import { TaskPlanController } from './controller.ts'

export const CREATE_TASK_PLAN_TOOL_NAME = 'CreateTaskPlan'
export const RESUME_TASK_PLAN_TOOL_NAME = 'ResumeTaskPlan'
export const PAUSE_TASK_PLAN_TOOL_NAME = 'PauseTaskPlan'
export const REPLACE_TASK_PLAN_TOOL_NAME = 'ReplaceTaskPlan'
export const ADD_TASK_ITEM_TOOL_NAME = 'AddTaskItem'
export const UPDATE_TASK_ITEM_TOOL_NAME = 'UpdateTaskItem'
export const CLOSE_TASK_PLAN_TOOL_NAME = 'CloseTaskPlan'

export type TaskPlanToolMode = 'empty' | 'dormant' | 'engaged'
export interface TaskPlanEngagementAction {
  type: 'resume' | 'pause'
  planId: string
}

interface TaskPlanToolCallbacks {
  onEngagementAction: (action: TaskPlanEngagementAction) => void
}

const draftSchema = z.object({
  kind: z.enum(['work', 'verification']).describe('工作项用 work；最终验收项用 verification'),
  title: z.string().min(1).describe('清晰、可执行的任务项标题'),
  acceptance: z.string().min(1).describe('可核验的完成标准'),
})

function createReplaceTaskPlanTool(
  controller: TaskPlanController,
): ToolDefinition {
  return buildTool({
    name: REPLACE_TASK_PLAN_TOOL_NAME,
    description: '用新的复杂任务原子替换休眠中的旧计划',
    prompt:
      '仅当最新真实用户消息要开始一个与旧目标不同的独立复杂任务时使用，并且必须在该新任务的任何写入或执行之前调用。若用户已经明确表示要改做、替换或放弃旧目标，可直接调用；若用户只提出了新复杂目标、但是否覆盖旧计划仍不明确，先用 AskUserQuestion 让用户在保留旧计划和替换旧计划之间选择。本工具必须是当前模型步骤唯一的工具调用；稳定提交后的下一模型步骤再读取新计划并执行工作。旧计划会以 superseded 状态完整归档，新计划成为唯一活动计划。无关问答、状态咨询、独立的一步操作或旧任务续作不要调用。',
    inputSchema: z.object({
      goal: z.string().min(1).describe('新任务最终要达成的可验证目标'),
      items: z.array(draftSchema).min(2).max(20).describe('新任务的有序任务项，最后一项必须验证整体结果'),
      reason: z.string().min(1).describe('为什么最新用户要求已取代旧任务'),
    }),
    isReadOnly: false,
    kind: 'control',
    availableWithoutProject: true,
    requiresStandaloneStep: true,
    async execute(input) {
      const result = controller.replace(input.goal, input.items, input.reason)
      return { data: result.message, isError: !result.ok }
    },
  })
}

/** Main 专用控制面工具：不触碰外部资源，因此无需审批或资源检查点。 */
export function createTaskPlanTools(
  controller: TaskPlanController,
  mode: TaskPlanToolMode,
  callbacks: TaskPlanToolCallbacks,
): ToolDefinition[] {
  const createTool = buildTool({
    name: CREATE_TASK_PLAN_TOOL_NAME,
    description: '为复杂任务建立可持久化计划',
    prompt:
      '仅用于最新真实用户请求中需要至少三个实质步骤、可能跨压缩/重启或需要多轮验证的复杂任务。创建目标与有序任务项；最后一项必须是唯一的 verification 验证步骤。本工具必须是当前模型步骤唯一的工具调用；稳定提交后的下一模型步骤再读取完整计划并执行工作。不要根据中断前的旧请求创建计划；无关问答、状态咨询或一步操作不要创建计划。',
    inputSchema: z.object({
      goal: z.string().min(1).describe('整个任务最终要达成的可验证目标'),
      items: z.array(draftSchema).min(2).max(20).describe('有序任务项，最后一项必须验证整体结果'),
    }),
    isReadOnly: false,
    kind: 'control',
    availableWithoutProject: true,
    requiresStandaloneStep: true,
    async execute(input) {
      const result = controller.create(input.goal, input.items)
      return { data: result.message, isError: !result.ok }
    },
  })
  if (mode === 'empty') return [createTool]

  const currentPlanIdSchema = z.object({
    plan_id: z.string().uuid().describe('动态任务上下文中给出的未结束计划 ID'),
  })
  const engagementTool = (
    action: TaskPlanEngagementAction['type'],
    name: string,
    description: string,
    prompt: string,
    success: string,
  ): ToolDefinition => buildTool({
    name,
    description,
    prompt,
    inputSchema: currentPlanIdSchema,
    isReadOnly: false,
    kind: 'control',
    availableWithoutProject: true,
    requiresStandaloneStep: true,
    async execute(input) {
      const plan = controller.snapshot
      if (!plan) return { data: '当前没有未结束的任务计划。', isError: true }
      if (plan.id !== input.plan_id) {
        return {
          data: '计划 ID 已变化；请依据下一次模型请求提供的最新任务上下文重新判断。',
          isError: true,
        }
      }
      callbacks.onEngagementAction({ type: action, planId: plan.id })
      return { data: success, isError: false }
    },
  })
  const replaceTool = createReplaceTaskPlanTool(controller)
  if (mode === 'dormant') {
    return [
      engagementTool(
        'resume',
        RESUME_TASK_PLAN_TOOL_NAME,
        '把当前回合接合到保存的未结束任务计划',
        '由你根据最新真实用户消息的完整语义判断是否调用，不要做关键词匹配。用户明确要求继续、恢复、调整或处理该旧任务时，直接调用即可，不需要再次向用户确认；状态询问、方案讨论、无关请求或独立的一步操作不要调用。本工具必须是当前模型步骤唯一的工具调用。成功只表示当前回合重新取得该计划的执行权；请在下一模型步骤读取完整计划、检查中断后实际状态，再继续工作。',
        '当前回合已接合保存的任务计划；下一模型步骤会提供完整计划。请先检查中断后实际状态，再继续执行。',
      ),
      replaceTool,
    ]
  }

  return [
    engagementTool(
      'pause',
      PAUSE_TASK_PLAN_TOOL_NAME,
      '暂停当前回合对未结束任务计划的执行',
      '仅当最新真实用户消息明确要求暂停、停止或暂时搁置当前任务，但没有要求放弃计划时调用。本工具必须是当前模型步骤唯一的工具调用。成功后计划及进度仍会保存，但当前回合不再受未完成保护约束；随后在下一模型步骤优先处理用户的其它当前请求。若用户只是补充信息或提出临时问题但没有要求暂停，不要擅自暂停。',
      '当前任务计划已暂停执行并保留进度；请按最新用户消息处理当前请求。',
    ),
    replaceTool,
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
      kind: 'control',
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
      kind: 'control',
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
      kind: 'control',
      availableWithoutProject: true,
      async execute(input) {
        const result = controller.close(input.outcome, input.summary)
        return { data: result.message, isError: !result.ok }
      },
    }),
  ]
}
