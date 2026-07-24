import type { McpConfiguration } from './config.ts'
import type { McpCatalogTool } from './catalog.ts'

export interface McpServerStatus {
  name: string
  scope: 'global' | 'project'
  state: 'idle' | 'connecting' | 'refreshing' | 'ready' | 'failed' | 'disconnected'
  error?: string
  toolCount: number
  diagnostics: readonly string[]
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
