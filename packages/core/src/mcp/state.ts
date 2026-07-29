import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { MCP_MAX_LOADED_TOOLS, type McpToolReference } from './catalog.ts'
import type { McpServerInstructionsSnapshot } from './manager-types.ts'

const MCP_TOOL_STATE_V1_PREFIX = '<whycode-mcp-tool-state:v1>'
const MCP_TOOL_STATE_V2_PREFIX = '<whycode-mcp-tool-state:v2>'
const MCP_TOOL_STATE_SUFFIX = '</whycode-mcp-tool-state>'
const MCP_MAX_INSTRUCTION_SERVERS = 32
const MCP_MAX_INSTRUCTION_CHARS_PER_SERVER = 2 * 1024
const MCP_MAX_INSTRUCTION_BYTES_TOTAL = 8 * 1024
const MCP_INSTRUCTION_TOTAL_TRUNCATED = '\n[服务器初始化说明已按会话总上限截断]'

const toolReferenceSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{64}$/u),
  descriptorHash: z.string().regex(/^[0-9a-f]{64}$/u),
  serverName: z.string().min(1).max(128),
})

const instructionSnapshotSchema = z.strictObject({
  serverName: z.string().min(1).max(128),
  runtimeFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  instructions: z.string().min(1).max(MCP_MAX_INSTRUCTION_CHARS_PER_SERVER),
})

const stateV1Schema = z.strictObject({
  version: z.literal(1),
  tools: z.array(toolReferenceSchema).max(MCP_MAX_LOADED_TOOLS),
})

const stateV2Schema = z.strictObject({
  version: z.literal(2),
  tools: z.array(toolReferenceSchema).max(MCP_MAX_LOADED_TOOLS),
  serverInstructions: z.array(instructionSnapshotSchema)
    .max(MCP_MAX_INSTRUCTION_SERVERS),
  trustedProjectConfigurationFingerprint: z.string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
})

export interface McpToolState {
  tools: McpToolReference[]
  serverInstructions: McpServerInstructionsSnapshot[]
  trustedProjectConfigurationFingerprint: string | null
}

export function createMcpToolStateMessage(
  state: McpToolState,
): ModelMessage {
  const parsed = stateV2Schema.parse({
    version: 2,
    tools: state.tools.slice(-MCP_MAX_LOADED_TOOLS),
    serverInstructions: uniqueInstructionSnapshots(state.serverInstructions),
    trustedProjectConfigurationFingerprint:
      state.trustedProjectConfigurationFingerprint,
  })
  return {
    role: 'system',
    content: `${MCP_TOOL_STATE_V2_PREFIX}${JSON.stringify(parsed)}${MCP_TOOL_STATE_SUFFIX}`,
  }
}

export function findMcpToolState(
  messages: readonly ModelMessage[],
): McpToolState {
  for (let index = messages.length - 1; index >= 0; index--) {
    const parsed = parseMcpToolStateMessage(messages[index]!)
    if (parsed) return parsed
  }
  return {
    tools: [],
    serverInstructions: [],
    trustedProjectConfigurationFingerprint: null,
  }
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

/**
 * 压缩不让模型总结内部工具状态；摘要完成后把压缩前的最新状态原样语义重建。
 * 这样工具数组和 server instructions 不因压缩退回首次检索状态。
 */
export function carryMcpToolState(
  source: readonly ModelMessage[],
  compacted: readonly ModelMessage[],
): ModelMessage[] {
  const state = findMcpToolState(source)
  const next = withoutMcpToolState(compacted)
  return state.tools.length > 0 || state.serverInstructions.length > 0
    || state.trustedProjectConfigurationFingerprint !== null
    ? [...next, createMcpToolStateMessage(state)]
    : next
}

export function sameMcpToolState(
  left: McpToolState,
  right: McpToolState,
): boolean {
  return sameToolReferences(left.tools, right.tools)
    && sameInstructionSnapshots(left.serverInstructions, right.serverInstructions)
    && left.trustedProjectConfigurationFingerprint
      === right.trustedProjectConfigurationFingerprint
}

function parseMcpToolStateMessage(
  message: ModelMessage,
): McpToolState | null {
  if (message.role !== 'system' || typeof message.content !== 'string') return null
  const prefix = message.content.startsWith(MCP_TOOL_STATE_V2_PREFIX)
    ? MCP_TOOL_STATE_V2_PREFIX
    : message.content.startsWith(MCP_TOOL_STATE_V1_PREFIX)
      ? MCP_TOOL_STATE_V1_PREFIX
      : null
  if (!prefix || !message.content.endsWith(MCP_TOOL_STATE_SUFFIX)) return null
  const json = message.content.slice(prefix.length, -MCP_TOOL_STATE_SUFFIX.length)
  try {
    const value: unknown = JSON.parse(json)
    if (prefix === MCP_TOOL_STATE_V2_PREFIX) {
      const state = stateV2Schema.parse(value)
      return {
        tools: state.tools,
        serverInstructions: uniqueInstructionSnapshots(state.serverInstructions),
        trustedProjectConfigurationFingerprint:
          state.trustedProjectConfigurationFingerprint,
      }
    }
    return {
      tools: stateV1Schema.parse(value).tools,
      serverInstructions: [],
      trustedProjectConfigurationFingerprint: null,
    }
  } catch {
    // 损坏或伪造的普通消息不能改变运行时工具目录。
    return null
  }
}

function sameToolReferences(
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

function sameInstructionSnapshots(
  left: readonly McpServerInstructionsSnapshot[],
  right: readonly McpServerInstructionsSnapshot[],
): boolean {
  return left.length === right.length
    && left.every((snapshot, index) => (
      snapshot.serverName === right[index]?.serverName
      && snapshot.runtimeFingerprint === right[index]?.runtimeFingerprint
      && snapshot.instructions === right[index]?.instructions
    ))
}

function uniqueInstructionSnapshots(
  snapshots: readonly McpServerInstructionsSnapshot[],
): McpServerInstructionsSnapshot[] {
  const byServer = new Map<string, McpServerInstructionsSnapshot>()
  for (const snapshot of snapshots) byServer.set(snapshot.serverName, snapshot)
  const unique = [...byServer.values()]
    .sort((left, right) => left.serverName.localeCompare(right.serverName))
    .slice(0, MCP_MAX_INSTRUCTION_SERVERS)
  const bounded: McpServerInstructionsSnapshot[] = []
  let remainingBytes = MCP_MAX_INSTRUCTION_BYTES_TOTAL
  for (const snapshot of unique) {
    const instructionBytes = Buffer.byteLength(snapshot.instructions, 'utf8')
    if (instructionBytes <= remainingBytes) {
      bounded.push(snapshot)
      remainingBytes -= instructionBytes
      continue
    }
    const markerBytes = Buffer.byteLength(MCP_INSTRUCTION_TOTAL_TRUNCATED, 'utf8')
    if (remainingBytes > markerBytes) {
      bounded.push({
        ...snapshot,
        instructions: `${
          truncateUtf8(snapshot.instructions, remainingBytes - markerBytes)
        }${MCP_INSTRUCTION_TOTAL_TRUNCATED}`,
      })
    }
    break
  }
  return bounded
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}
