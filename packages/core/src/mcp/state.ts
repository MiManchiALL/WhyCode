import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { MCP_MAX_LOADED_TOOLS, type McpToolReference } from './catalog.ts'

const MCP_TOOL_STATE_PREFIX = '<whycode-mcp-tool-state:v1>'
const MCP_TOOL_STATE_SUFFIX = '</whycode-mcp-tool-state>'

const stateSchema = z.strictObject({
  version: z.literal(1),
  tools: z.array(z.strictObject({
    id: z.string().regex(/^[0-9a-f]{64}$/u),
    descriptorHash: z.string().regex(/^[0-9a-f]{64}$/u),
    serverName: z.string().min(1).max(128),
  })).max(MCP_MAX_LOADED_TOOLS),
})

export function createMcpToolStateMessage(
  tools: readonly McpToolReference[],
): ModelMessage {
  const state = stateSchema.parse({
    version: 1,
    tools: tools.slice(-MCP_MAX_LOADED_TOOLS),
  })
  return {
    role: 'system',
    content: `${MCP_TOOL_STATE_PREFIX}${JSON.stringify(state)}${MCP_TOOL_STATE_SUFFIX}`,
  }
}

export function findMcpToolState(
  messages: readonly ModelMessage[],
): McpToolReference[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const parsed = parseMcpToolStateMessage(messages[index]!)
    if (parsed) return parsed
  }
  return []
}

export function isMcpToolStateMessage(message: ModelMessage): boolean {
  return parseMcpToolStateMessage(message) !== null
}

/** 内部状态通过工具 schema 生效，永不作为普通 user 文本发给模型或交给摘要模型。 */
export function withoutMcpToolState(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  return messages.filter((message) => !isMcpToolStateMessage(message))
}

export function sameMcpToolState(
  left: readonly McpToolReference[],
  right: readonly McpToolReference[],
): boolean {
  return left.length === right.length
    && left.every((reference, index) => (
      reference.id === right[index]?.id
      && reference.descriptorHash === right[index]?.descriptorHash
      && reference.serverName === right[index]?.serverName
    ))
}

function parseMcpToolStateMessage(
  message: ModelMessage,
): McpToolReference[] | null {
  if (message.role !== 'system' || typeof message.content !== 'string') return null
  if (
    !message.content.startsWith(MCP_TOOL_STATE_PREFIX)
    || !message.content.endsWith(MCP_TOOL_STATE_SUFFIX)
  ) return null
  const json = message.content.slice(
    MCP_TOOL_STATE_PREFIX.length,
    -MCP_TOOL_STATE_SUFFIX.length,
  )
  try {
    return stateSchema.parse(JSON.parse(json)).tools
  } catch {
    // 损坏或伪造的普通消息不能改变运行时工具目录。
    return null
  }
}
