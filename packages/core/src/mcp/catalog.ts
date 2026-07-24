import { createHash } from 'node:crypto'
import type { McpConfigScope, McpServerConfig } from './config.ts'

export const MCP_MAX_TOOLS_PER_SERVER = 2_000
export const MCP_MAX_TOTAL_TOOLS = 10_000
export const MCP_MAX_SCHEMA_BYTES = 256 * 1024
export const MCP_MAX_LOADED_TOOLS = 64

const MODEL_TOOL_NAME_MAX_CHARS = 64
const TOOL_DESCRIPTION_MAX_CHARS = 8_000
const MCP_MAX_CATALOG_BYTES_PER_SERVER = 2 * 1024 * 1024

export interface McpAdvertisedTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown> & { type: 'object' }
  outputSchema?: Record<string, unknown> & { type: 'object' }
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  execution?: { taskSupport?: 'optional' | 'required' | 'forbidden' }
}

export interface McpCatalogTool {
  id: string
  descriptorHash: string
  exposedName: string
  serverName: string
  serverScope: McpConfigScope
  rawName: string
  title: string
  description: string
  inputSchema: Record<string, unknown> & { type: 'object' }
  inputSummary: string
  searchText: string
  advertisedReadOnly: boolean
}

export interface McpToolReference {
  id: string
  descriptorHash: string
  serverName: string
}

export interface McpCatalogBuildResult {
  tools: McpCatalogTool[]
  diagnostics: string[]
}

export function buildServerCatalog(
  server: McpServerConfig,
  advertisedTools: readonly McpAdvertisedTool[],
): McpCatalogBuildResult {
  const tools: McpCatalogTool[] = []
  const diagnostics: string[] = []
  const usedNames = new Set<string>()
  const usedIds = new Set<string>()
  let catalogBytes = 0
  const bounded = advertisedTools.slice(0, MCP_MAX_TOOLS_PER_SERVER)
  if (advertisedTools.length > MCP_MAX_TOOLS_PER_SERVER) {
    diagnostics.push(`工具数量超过单服务器上限 ${MCP_MAX_TOOLS_PER_SERVER}，其余已忽略`)
  }
  for (const advertised of bounded) {
    try {
      const tool = normalizeTool(server, advertised, usedNames)
      if (usedIds.has(tool.id)) {
        throw new Error('服务器返回了重复工具名')
      }
      const toolBytes = catalogToolBytes(tool)
      if (catalogBytes + toolBytes > MCP_MAX_CATALOG_BYTES_PER_SERVER) {
        diagnostics.push(`工具目录超过 ${MCP_MAX_CATALOG_BYTES_PER_SERVER / 1024} KiB 上限，其余已忽略`)
        break
      }
      tools.push(tool)
      catalogBytes += toolBytes
      usedNames.add(tool.exposedName)
      usedIds.add(tool.id)
    } catch (error) {
      diagnostics.push(
        `${safeToolLabel(advertised.name)}：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { tools, diagnostics: diagnostics.slice(0, 20) }
}

export function toolReference(tool: McpCatalogTool): McpToolReference {
  return {
    id: tool.id,
    descriptorHash: tool.descriptorHash,
    serverName: tool.serverName,
  }
}

export function sameToolReference(
  left: McpToolReference,
  right: McpToolReference,
): boolean {
  return left.id === right.id && left.descriptorHash === right.descriptorHash
    && left.serverName === right.serverName
}

export function sameMcpCatalog(
  left: readonly McpCatalogTool[],
  right: readonly McpCatalogTool[],
): boolean {
  return left.length === right.length
    && left.every((tool, index) =>
      tool.id === right[index]?.id
      && tool.descriptorHash === right[index]?.descriptorHash)
}

function normalizeTool(
  server: McpServerConfig,
  advertised: McpAdvertisedTool,
  usedNames: ReadonlySet<string>,
): McpCatalogTool {
  const rawName = cleanText(advertised.name, 256)
  if (!rawName) throw new Error('名称为空或包含控制字符')
  if (!isObjectSchema(advertised.inputSchema)) throw new Error('inputSchema 必须是对象 schema')
  if (advertised.execution?.taskSupport === 'required') {
    throw new Error('当前版本不支持必须通过 MCP Tasks 执行的工具')
  }
  const schemaBytes = byteLength(advertised.inputSchema)
  if (schemaBytes > MCP_MAX_SCHEMA_BYTES) {
    throw new Error(`inputSchema 超过 ${MCP_MAX_SCHEMA_BYTES / 1024} KiB 上限`)
  }
  if (
    advertised.outputSchema
    && (
      !isObjectSchema(advertised.outputSchema)
      || byteLength(advertised.outputSchema) > MCP_MAX_SCHEMA_BYTES
    )
  ) {
    throw new Error(`outputSchema 必须是对象 schema 且不超过 ${MCP_MAX_SCHEMA_BYTES / 1024} KiB`)
  }
  const description = cleanText(advertised.description ?? '', TOOL_DESCRIPTION_MAX_CHARS)
  const title = cleanText(
    advertised.title ?? advertised.annotations?.title ?? rawName,
    256,
  ) || rawName
  const id = stableHash([server.name, rawName])
  const modelDescriptor = {
    server: server.name,
    name: rawName,
    title,
    description,
    inputSchema: advertised.inputSchema,
    outputSchema: advertised.outputSchema,
    execution: advertised.execution,
    advertisedReadOnly: advertised.annotations?.readOnlyHint === true,
  }
  const descriptorHash = stableHash({
    ...modelDescriptor,
    sourceFingerprint: server.sourceFingerprint,
  })
  const exposedName = uniqueExposedName(
    server.name,
    rawName,
    stableHash(modelDescriptor),
    usedNames,
  )
  const inputSummary = describeInputSchema(advertised.inputSchema)
  return {
    id,
    descriptorHash,
    exposedName,
    serverName: server.name,
    serverScope: server.scope,
    rawName,
    title,
    description,
    inputSchema: advertised.inputSchema,
    inputSummary,
    searchText: collectSearchText({
      serverName: server.name,
      rawName,
      title,
      description,
      schema: advertised.inputSchema,
    }),
    advertisedReadOnly: advertised.annotations?.readOnlyHint === true,
  }
}

function uniqueExposedName(
  serverName: string,
  rawName: string,
  descriptorHash: string,
  usedNames: ReadonlySet<string>,
): string {
  const prefix = `Mcp__${toolNamePart(serverName)}__${toolNamePart(rawName)}`
  const suffix = `__${descriptorHash.slice(0, 8)}`
  const base = `${prefix.slice(0, MODEL_TOOL_NAME_MAX_CHARS - suffix.length)}${suffix}`
  if (!usedNames.has(base)) return base
  return `${prefix.slice(0, MODEL_TOOL_NAME_MAX_CHARS - suffix.length - 2)}_2${suffix}`
}

function toolNamePart(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^[_-]+|[_-]+$/gu, '')
  const safe = normalized || 'tool'
  return /^[A-Za-z_]/u.test(safe) ? safe : `_${safe}`
}

function describeInputSchema(schema: Record<string, unknown>): string {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  )
  const names = Object.keys(properties).slice(0, 20)
  if (names.length === 0) return '无已声明参数'
  const summary = names.map((name) => required.has(name) ? name : `${name}?`).join(', ')
  return Object.keys(properties).length > names.length ? `${summary}, …` : summary
}

function collectSearchText(input: {
  serverName: string
  rawName: string
  title: string
  description: string
  schema: Record<string, unknown>
}): string {
  const fragments = [input.serverName, input.rawName, input.title, input.description]
  collectSchemaText(input.schema, fragments, 0)
  return fragments.join('\n').slice(0, 32_000)
}

function collectSchemaText(
  value: unknown,
  fragments: string[],
  depth: number,
): void {
  if (depth > 6 || fragments.length > 200) return
  if (typeof value === 'string') {
    fragments.push(value.slice(0, 1_000))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) collectSchemaText(item, fragments, depth + 1)
    return
  }
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    fragments.push(key)
    collectSchemaText(item, fragments, depth + 1)
  }
}

function isObjectSchema(
  value: unknown,
): value is Record<string, unknown> & { type: 'object' } {
  return isRecord(value) && value.type === 'object'
}

function cleanText(value: string, maxChars: number): string {
  const bounded = value.slice(0, maxChars)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(bounded)) return ''
  return bounded.trim()
}

function safeToolLabel(value: unknown): string {
  return typeof value === 'string' && cleanText(value, 80)
    ? cleanText(value, 80)
    : '未命名工具'
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function catalogToolBytes(tool: McpCatalogTool): number {
  return byteLength(tool.inputSchema)
    + Buffer.byteLength(
      `${tool.exposedName}\n${tool.serverName}\n${tool.rawName}\n${tool.title}\n${
        tool.description
      }\n${tool.inputSummary}\n${tool.searchText}`,
      'utf8',
    )
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
