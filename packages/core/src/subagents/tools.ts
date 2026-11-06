import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import {
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
  subagent_id: z.string().uuid().optional().describe('send 或 stop：已有子代理 ID'),
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
      'action=spawn：把可独立并行、需要专门调查或能返回明确结果的任务委派给子代理；填写 name、description、prompt。',
      'name 来自 <available_subagents> 及最新增量通知；同一 name 可创建多个实例。description 简短标识本次任务。定义决定工具与权限，调用参数不能扩展。',
      '委派必须自包含：交代目标、已知事实、范围与禁区、期望结果和证据；实施任务还需写明文件或符号、预期行为、验收标准及是否允许修改。子代理看不到父会话其它消息。',
      'action=send：填写 subagent_id、prompt；运行中在下一稳定步骤交付，已结束则沿用独立历史继续。',
      'action=stop：填写 subagent_id；停止该实例并保留已产生的结果与历史，后续仍可 send 继续。',
      'action=list：不填其它字段，查看当前会话保留实例的 ID、描述与状态；复用职责匹配的实例。',
      '当前会话最多同时运行 8 个子代理。启动与发送立即返回稳定 ID，终态自动交付到正在执行的父回合，不要轮询。',
      '不要把尚未完成的理解和方案选择整体交给子代理，也不要要求子代理向用户提问或再创建子代理。',
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
