import type { McpConfiguration } from './config.ts'
import type { McpCatalogTool } from './catalog.ts'

export interface McpServerStatus {
  name: string
  scope: 'global' | 'project'
  state: 'idle' | 'connecting' | 'refreshing' | 'ready' | 'failed' | 'disconnected'
  error?: string
  toolCount: number
  diagnostics: readonly string[]
  /** WhyCode 维护的可信内置来源画像，只用于能力路由。 */
  capabilitySummary?: string
  /** MCP initialize.instructions；已限长，仍属于不可信外部元数据。 */
  serverInstructions?: string
}

export interface McpManagerSnapshot {
  tools: readonly McpCatalogTool[]
  servers: readonly McpServerStatus[]
  configDiagnostics: McpConfiguration['diagnostics']
}

export interface McpBoundTool {
  tool: McpCatalogTool
  serverRevision: number
}
