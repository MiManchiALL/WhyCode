import { asSchema, type ModelMessage, type ToolSet } from 'ai'
import type { ContextUsageInfo } from '../events.ts'
import { isProjectInstructionsMessage } from '../instructions/project.ts'
import { MCP_TOOL_NAME_PREFIX } from '../mcp/catalog.ts'
import type { CustomSystemPromptSnapshot } from '../prompts/custom-system.ts'
import { isSkillCatalogMessage } from '../skills/context.ts'
import { isSubagentCatalogSnapshotMessage } from '../subagents/context.ts'
import { estimateMessageTokens, estimateTextTokens } from './tokens.ts'

export type RequestContextOverhead = Pick<
  ContextUsageInfo['breakdown'], 'systemPromptTokens' | 'toolTokens'
> & Pick<ContextUsageInfo['details'], 'system' | 'tools'>

/** 与请求使用相同的 System、工具数组及自定义快照，不重新读取配置。 */
export async function estimateRequestContextOverhead(
  systemPrompt: string,
  tools: ToolSet | undefined,
  customSystemPrompt?: CustomSystemPromptSnapshot,
): Promise<RequestContextOverhead> {
  const toolTokens = await Promise.all(Object.entries(tools ?? {}).map(async ([name, tool]) => ({
    name, tokens: await estimateToolTokens(name, tool),
  })))
  const toolDetails = { builtIn: 0, mcp: 0 }
  for (const { name, tokens } of toolTokens) {
    toolDetails[name.startsWith(MCP_TOOL_NAME_PREFIX) ? 'mcp' : 'builtIn'] += tokens
  }
  const systemPromptTokens = estimateTextTokens(systemPrompt)
  const customTokens = customSystemPrompt ? estimateTextTokens(customSystemPrompt.content) : 0
  return {
    systemPromptTokens,
    toolTokens: toolDetails.builtIn + toolDetails.mcp,
    system: {
      // 追加分隔符与舍入差计入内置部分；覆盖模式下完整 System 就是自定义正文。
      builtIn: systemPromptTokens - customTokens,
      custom: customTokens,
      mode: customSystemPrompt?.mode ?? 'off',
    },
    tools: toolDetails,
  }
}

async function estimateToolTokens(name: string, tool: ToolSet[string]): Promise<number> {
  if (tool.type === 'provider') {
    return estimateTextTokens(JSON.stringify({ name, id: tool.id, args: tool.args }))
  }
  const description = typeof tool.description === 'string' ? tool.description : ''
  try {
    return estimateTextTokens(JSON.stringify({
      name, description, inputSchema: await asSchema(tool.inputSchema).jsonSchema,
    }))
  } catch {
    // 计量失败不能阻断请求；无法转换的 schema 仅估算名称与说明。
    return estimateTextTokens(`${name}\n${description}`)
  }
}

/** 只拆分请求顶部的三个配置块；后续目录增量与活动指引仍属于上下文。 */
export function estimateMessageContextDetails(
  messages: readonly ModelMessage[],
): ContextUsageInfo['details']['messages'] {
  const details = { agents: 0, subagents: 0, skills: 0, context: 0 }
  let index = 0
  for (const [key, matches] of [
    ['agents', isProjectInstructionsMessage],
    ['subagents', isSubagentCatalogSnapshotMessage],
    ['skills', isSkillCatalogMessage],
  ] as const) {
    const message = messages[index]
    if (message && matches(message)) {
      details[key] = estimateMessageTokens(message)
      index++
    }
  }
  for (; index < messages.length; index++) details.context += estimateMessageTokens(messages[index]!)
  return details
}
