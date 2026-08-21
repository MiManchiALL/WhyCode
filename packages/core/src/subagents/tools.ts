import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import type { SubagentDefinitionCatalogService } from './catalog.ts'
import {
  MAX_SUBAGENT_PROMPT_CHARS,
  type SubagentContinueRequest,
  type SubagentLaunchRequest,
  type SubagentLaunchResult,
} from './types.ts'

export const SUBAGENT_TOOL_NAME = 'Subagent'
export const SEND_SUBAGENT_MESSAGE_TOOL_NAME = 'SendSubagentMessage'

export interface SubagentToolHost {
  launch(request: SubagentLaunchRequest): Promise<SubagentLaunchResult>
  continue(request: SubagentContinueRequest): Promise<SubagentLaunchResult>
}

export function createSubagentTools(
  catalog: SubagentDefinitionCatalogService,
  projectDir: string,
  host: SubagentToolHost,
): ToolDefinition[] {
  return [
    buildTool({
      name: SUBAGENT_TOOL_NAME,
      description: '启动一个隔离的子代理处理边界明确的任务',
      prompt: [
        '把可独立并行、需要专门调查或能返回明确交付结果的工作委派给一个可用子代理。',
        'agent_id 必须来自系统提示词中的 <available_subagents>；工具和权限由该定义及父会话边界固定，不能在调用参数中扩展。',
        '同一父会话最多并行运行 8 个子代理。工具会立即返回稳定 subagent_id；不要轮询，子代理终态会由 WhyCode 自动注入父会话。',
        '委派内容应自包含，写清目标、边界、必要上下文和期望结果；不要要求子代理向用户提问或再创建子代理。',
      ].join('\n'),
      inputSchema: z.object({
        agent_id: z.string().min(1).max(160).describe('可用子代理定义 ID'),
        prompt: z.string().min(1).max(MAX_SUBAGENT_PROMPT_CHARS).describe('自包含的委派任务'),
      }).strict(),
      isReadOnly: true,
      kind: 'control',
      async execute(input, ctx) {
        if (!ctx.turnId || !ctx.toolCallId) {
          return { data: '子代理调用缺少父回合身份', isError: true }
        }
        const snapshot = await catalog.snapshot(projectDir)
        const definition = snapshot.definitions.find((item) => item.id === input.agent_id)
        if (!definition) return { data: `未知或已移除的子代理：${input.agent_id}`, isError: true }
        const result = await host.launch({
          definition,
          prompt: input.prompt,
          parentTurnId: ctx.turnId,
          parentToolCallId: ctx.toolCallId,
          ...(ctx.engagedPlanId ? { engagedPlanId: ctx.engagedPlanId } : {}),
        })
        return toolResult(result, '已启动')
      },
    }),
    buildTool({
      name: SEND_SUBAGENT_MESSAGE_TOOL_NAME,
      description: '按稳定 ID 继续一个已结束的子代理',
      prompt: [
        '向当前父会话拥有的既有子代理追加一条消息。WhyCode 会从磁盘冷恢复其独立 transcript，完成本次激活后立即释放运行体。',
        '只能继续已结束的子代理；同一子代理不能并发激活。工具会立即返回，终态仍由 WhyCode 自动注入，不要轮询。',
      ].join('\n'),
      inputSchema: z.object({
        subagent_id: z.string().uuid().describe('此前 Subagent 返回的稳定 ID'),
        prompt: z.string().min(1).max(MAX_SUBAGENT_PROMPT_CHARS).describe('追加给子代理的消息'),
      }).strict(),
      isReadOnly: true,
      kind: 'control',
      async execute(input, ctx) {
        if (!ctx.turnId || !ctx.toolCallId) {
          return { data: '子代理调用缺少父回合身份', isError: true }
        }
        const result = await host.continue({
          subagentId: input.subagent_id,
          prompt: input.prompt,
          parentTurnId: ctx.turnId,
          parentToolCallId: ctx.toolCallId,
          ...(ctx.engagedPlanId ? { engagedPlanId: ctx.engagedPlanId } : {}),
        })
        return toolResult(result, '已继续')
      },
    }),
  ]
}

function toolResult(result: SubagentLaunchResult, verb: string) {
  if (!result.ok || !result.subagentId) {
    return { data: result.error ?? '子代理启动失败', isError: true }
  }
  return {
    data: `${verb}子代理 ${result.name ?? ''}（subagent_id: ${result.subagentId}）。终态将由 WhyCode 自动送达。`,
    isError: false,
  }
}
