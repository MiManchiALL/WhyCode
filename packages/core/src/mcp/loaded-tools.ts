import {
  MCP_MAX_LOADED_TOOLS,
  type McpCatalogTool,
} from './catalog.ts'

export const MCP_MAX_LOADED_DEFINITION_BYTES = 256 * 1024

export interface McpLoadedToolSelection {
  tools: McpCatalogTool[]
  acceptedRequested: McpCatalogTool[]
}

/**
 * 新检索结果按相关性优先占用预算；剩余空间再保留最近加载的旧工具。
 * 只维护目录对象，不建立另一份 schema/cache 状态。
 */
export function mergeLoadedMcpTools(
  current: readonly McpCatalogTool[],
  requested: readonly McpCatalogTool[],
): McpLoadedToolSelection {
  const uniqueRequested = uniqueTools(requested)
  const requestedKeys = new Set(uniqueRequested.map(toolKey))
  const acceptedRequested: McpCatalogTool[] = []
  let usedBytes = 0

  for (const tool of uniqueRequested) {
    const bytes = mcpModelDefinitionBytes(tool)
    if (
      acceptedRequested.length < MCP_MAX_LOADED_TOOLS
      && usedBytes + bytes <= MCP_MAX_LOADED_DEFINITION_BYTES
    ) {
      acceptedRequested.push(tool)
      usedBytes += bytes
    }
  }

  const retainedNewestFirst: McpCatalogTool[] = []
  for (let index = current.length - 1; index >= 0; index--) {
    const tool = current[index]!
    if (requestedKeys.has(toolKey(tool))) continue
    const bytes = mcpModelDefinitionBytes(tool)
    if (
      acceptedRequested.length + retainedNewestFirst.length < MCP_MAX_LOADED_TOOLS
      && usedBytes + bytes <= MCP_MAX_LOADED_DEFINITION_BYTES
    ) {
      retainedNewestFirst.push(tool)
      usedBytes += bytes
    }
  }

  return {
    tools: [...retainedNewestFirst.reverse(), ...acceptedRequested],
    acceptedRequested,
  }
}

export function mcpModelDefinitionBytes(tool: McpCatalogTool): number {
  return Buffer.byteLength(JSON.stringify(tool.inputSchema), 'utf8')
    + Buffer.byteLength(
      `${tool.exposedName}\n${tool.title}\n${tool.description}\n${tool.inputSummary}`,
      'utf8',
    )
}

function uniqueTools(tools: readonly McpCatalogTool[]): McpCatalogTool[] {
  const unique = new Map<string, McpCatalogTool>()
  for (const tool of tools) {
    const key = toolKey(tool)
    if (!unique.has(key)) unique.set(key, tool)
  }
  return [...unique.values()]
}

function toolKey(tool: McpCatalogTool): string {
  return `${tool.id}:${tool.descriptorHash}:${tool.serverName}`
}
