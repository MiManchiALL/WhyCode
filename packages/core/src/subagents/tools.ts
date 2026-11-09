import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import {
  MAX_CONCURRENT_SUBAGENTS_PER_PARENT,
  MAX_SUBAGENT_PROMPT_CHARS,
  subagentTaskDescriptionSchema,
  subagentNameSchema,
  type SubagentContinueRequest,
  type SubagentListEntry,
  type SubagentLaunchRequest,
  type SubagentLaunchResult,
} from './types.ts'

export const SUBAGENT_TOOL_NAME = 'Subagent'

export interface SubagentToolHost {
  launch(request: SubagentLaunchRequest): Promise<SubagentLaunchResult>
  send(request: SubagentContinueRequest): Promise<SubagentLaunchResult>
  stop(subagentId: string): Promise<SubagentLaunchResult>
  list(): Promise<SubagentListEntry[]>
}

const inputSchema = z.object({
  action: z.enum(['spawn', 'send', 'stop', 'list']),
  name: subagentNameSchema.optional().describe('spawn：可用子代理定义名称'),
  description: subagentTaskDescriptionSchema.optional().describe('spawn：本次子任务的短描述'),
  prompt: z.string().trim().min(1).max(MAX_SUBAGENT_PROMPT_CHARS).optional().describe('spawn 或 send：任务或追加消息'),
  subagent_id: z.string().uuid().optional().describe(
    'send 或 stop 的目标实例 ID。后续任务依赖某个子代理先前的工作上下文时，优先用 send 复用该实例。',
  ),
}).strict().superRefine((input, ctx) => {
  const fields: readonly string[] = {
    spawn: ['name', 'description', 'prompt'],
    send: ['subagent_id', 'prompt'],
    stop: ['subagent_id'],
    list: [],
  }[input.action]
  for (const key of ['name', 'description', 'prompt', 'subagent_id'] as const) {
    if (fields.includes(key) !== (input[key] !== undefined)) {
      ctx.addIssue({ code: 'custom', path: [key], message: fields.includes(key)
        ? `${input.action} 需要 ${key}` : `${input.action} 不接受 ${key}` })
    }
  }
})

export function createSubagentTools(host: SubagentToolHost): ToolDefinition[] {
  return [buildTool({
    name: SUBAGENT_TOOL_NAME,
    description: '启动、发送消息、停止或查看当前会话的子代理',
    prompt: [
      'action=spawn 按 <available_subagents> 及最新增量选择 name，用 description 简述任务。同一定义可创建多个实例。',
      '新实例看不到父会话的其它消息。prompt 写明目标、已知事实、范围与禁区、期望结果和证据。实施任务还需写明文件或符号、预期行为、验收标准及是否允许修改。',
      '工具与权限受定义和宿主约束。检查文档时提供可访问的绝对路径，父会话的附件 ID 无法转交。视觉核验交给具备视觉能力的代理，向用户提问或进一步委派由父代理负责。',
      'action=send 用 subagent_id 和 prompt 补充任务。运行中的实例在下一稳定步骤收到消息，已结束的实例沿用自己的历史继续。',
      'action=stop 用 subagent_id 停止指定实例，保留已有结果和历史，之后仍可用 send 继续。',
      'action=list 只填 action，返回当前会话保留实例的 ID、任务描述和状态。',
      `每个父会话最多同时运行 ${MAX_CONCURRENT_SUBAGENTS_PER_PARENT} 个子代理。spawn 和 send 立即返回稳定的 subagent_id，结果自动交付到正在执行的父回合。`,
    ].join('\n'),
    inputSchema,
    isReadOnly: false,
    kind: 'control',
    behavior: (input) => ({ kind: 'control', isReadOnly: input.action === 'list' }),
    async execute(input, ctx) {
      if (input.action === 'list') {
        const subagents = await host.list()
        return { data: JSON.stringify({ subagents: subagents.map(item => ({
          subagent_id: item.subagentId, description: item.description, status: item.status,
        })) }), isError: false }
      }
      if (input.action === 'stop') return toolResult(await host.stop(input.subagent_id!), '已停止')
      if (!ctx.turnId || !ctx.toolCallId) {
        return { data: '子代理调用缺少父回合身份', isError: true }
      }
      const request = {
        prompt: input.prompt!,
        parentTurnId: ctx.turnId,
        parentToolCallId: ctx.toolCallId,
        ...(ctx.engagedPlanId ? { engagedPlanId: ctx.engagedPlanId } : {}),
      }
      if (input.action === 'send') {
        return toolResult(await host.send({ ...request, subagentId: input.subagent_id! }), '已发送消息给')
      }
      const definition = ctx.subagentDefinitions?.find(item => item.name === input.name)
      if (!definition) return { data: `本次请求没有可用的子代理定义：${input.name}`, isError: true }
      return toolResult(await host.launch({ ...request, definition, taskDescription: input.description! }), '已启动')
    },
  })]
}

function toolResult(result: SubagentLaunchResult, verb: string) {
  if (!result.ok || !result.subagentId) {
    return { data: result.error ?? '子代理操作失败', isError: true }
  }
  return {
    data: `${verb}子代理「${result.description ?? ''}」（subagent_id: ${result.subagentId}）。`,
    isError: false,
  }
}
