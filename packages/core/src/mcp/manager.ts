import type { McpConfiguration } from './config.ts'
import {
  MCP_MAX_TOTAL_TOOLS,
  type McpToolReference,
} from './catalog.ts'
import {
  MCP_CONNECTION_CONCURRENCY,
  mapWithConcurrency,
  type McpFetch,
} from './connection-utils.ts'
import type {
  McpBoundTool,
  McpManagerSnapshot,
  McpServerStatus,
} from './manager-types.ts'
import { McpServerConnection } from './server-connection.ts'

export type { McpFetch } from './connection-utils.ts'
export type { McpBoundTool, McpManagerSnapshot, McpServerStatus } from './manager-types.ts'

export class McpConnectionManager {
  private readonly connections = new Map<string, McpServerConnection>()
  readonly configuration: McpConfiguration
  private closed = false

  constructor(
    configuration: McpConfiguration,
    fetchImpl: McpFetch = globalThis.fetch,
  ) {
    this.configuration = configuration
    for (const config of configuration.servers) {
      this.connections.set(config.name, new McpServerConnection(config, fetchImpl))
    }
  }

  snapshot(includeProject: boolean): McpManagerSnapshot {
    const connections = [...this.connections.values()]
      .filter((connection) => includeProject || connection.config.scope !== 'project')
    const servers = connections
      .map((connection) => connection.status())
      .sort((left, right) => left.name.localeCompare(right.name))
    return {
      tools: connections
        .flatMap((connection) => connection.availableTools())
        .slice(0, MCP_MAX_TOTAL_TOOLS),
      servers,
      configDiagnostics: this.configuration.diagnostics,
    }
  }

  async refreshAll(signal: AbortSignal, includeProject: boolean): Promise<McpManagerSnapshot> {
    this.assertOpen()
    const connections = [...this.connections.values()]
      .filter((connection) => includeProject || connection.config.scope !== 'project')
    await mapWithConcurrency(connections, MCP_CONNECTION_CONCURRENCY, async (connection) => {
      await connection.refresh(signal)
    })
    return this.snapshot(includeProject)
  }

  async prepareReferences(
    references: readonly McpToolReference[],
    signal: AbortSignal,
    includeProject: boolean,
  ): Promise<McpManagerSnapshot> {
    if (references.length === 0) return this.snapshot(includeProject)
    const referencedServers = new Set(references.map((reference) => reference.serverName))
    const connections = [...this.connections.values()]
      .filter((connection) =>
        referencedServers.has(connection.config.name)
        && (includeProject || connection.config.scope !== 'project'))
    await mapWithConcurrency(connections, MCP_CONNECTION_CONCURRENCY, async (connection) => {
      await connection.prepare(signal)
    })
    return this.snapshot(includeProject)
  }

  bindReference(
    reference: McpToolReference,
    includeProject: boolean,
  ): McpBoundTool | null {
    const connection = this.connections.get(reference.serverName)
    if (!connection || (!includeProject && connection.config.scope === 'project')) return null
    return connection.bind(reference)
  }

  async callTool(
    binding: McpBoundTool,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress?: (output: string) => void,
  ): Promise<unknown> {
    this.assertOpen()
    const connection = this.connections.get(binding.tool.serverName)
    if (!connection) {
      throw new Error('MCP 工具目录在本步骤开始后发生变化，请重新调用 ToolSearch')
    }
    return connection.call(binding, input, signal, onProgress)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([...this.connections.values()].map((connection) => connection.close()))
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('MCP 会话已经关闭')
  }
}
