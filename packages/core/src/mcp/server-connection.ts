import { Client } from '@modelcontextprotocol/sdk/client'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig } from './config.ts'
import {
  buildServerCatalog,
  sameMcpCatalog,
  type McpAdvertisedTool,
  type McpCatalogTool,
  type McpToolReference,
} from './catalog.ts'
import {
  createMcpTransport,
  listAllMcpTools,
  safeMcpConnectionError,
  waitForMcpOperation,
  type McpFetch,
} from './connection-utils.ts'
import type { McpBoundTool, McpServerStatus } from './manager-types.ts'

export class McpServerConnection {
  readonly config: McpServerConfig
  private readonly fetchImpl: McpFetch
  private readonly lifetimeAbort = new AbortController()
  private state: McpServerStatus['state'] = 'idle'
  private revision = 0
  private tools: McpCatalogTool[] = []
  private diagnostics: string[] = []
  private error?: string
  private client?: Client
  private transport?: Transport
  private operation?: Promise<void>
  private closed = false

  constructor(config: McpServerConfig, fetchImpl: McpFetch) {
    this.config = config
    this.fetchImpl = fetchImpl
  }

  status(): McpServerStatus {
    return {
      name: this.config.name,
      scope: this.config.scope,
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      toolCount: this.tools.length,
      diagnostics: this.diagnostics,
    }
  }

  availableTools(): readonly McpCatalogTool[] {
    return this.state === 'ready' ? this.tools : []
  }

  async prepare(signal: AbortSignal): Promise<void> {
    const pending = this.operation
    if (pending) {
      await waitForMcpOperation(pending, signal)
      if (this.state === 'refreshing') await this.refresh(signal)
      return
    }
    if (this.state !== 'ready' || !this.client) await this.refresh(signal)
  }

  async refresh(signal: AbortSignal): Promise<void> {
    this.assertOpen()
    if (this.operation) {
      await waitForMcpOperation(this.operation, signal)
      if (this.state === 'refreshing') return this.refresh(signal)
      return
    }
    const operation = this.refreshUnshared(
      AbortSignal.any([signal, this.lifetimeAbort.signal]),
    ).finally(() => {
      if (this.operation === operation) this.operation = undefined
    })
    this.operation = operation
    return waitForMcpOperation(operation, signal)
  }

  bind(reference: McpToolReference): McpBoundTool | null {
    if (this.state !== 'ready') return null
    const tool = this.tools.find((candidate) =>
      candidate.id === reference.id
      && candidate.descriptorHash === reference.descriptorHash)
    return tool ? { tool, serverRevision: this.revision } : null
  }

  async call(
    binding: McpBoundTool,
    input: Record<string, unknown>,
    signal: AbortSignal,
    onProgress?: (output: string) => void,
  ): Promise<unknown> {
    this.assertOpen()
    if (
      this.state !== 'ready'
      || !this.client
      || this.revision !== binding.serverRevision
      || !this.tools.some((tool) =>
        tool.id === binding.tool.id
        && tool.descriptorHash === binding.tool.descriptorHash)
    ) {
      throw new Error('MCP 工具目录在本步骤开始后发生变化，请重新调用 ToolSearch')
    }
    try {
      return await this.client.callTool(
        { name: binding.tool.rawName, arguments: input },
        undefined,
        {
          signal: AbortSignal.any([signal, this.lifetimeAbort.signal]),
          timeout: this.config.toolTimeoutMs,
          maxTotalTimeout: this.config.toolTimeoutMs,
          ...(onProgress
            ? {
                onprogress: (progress) => {
                  const current = progress.progress
                  const total = progress.total
                  onProgress(total === undefined ? `进度：${current}` : `进度：${current}/${total}`)
                },
              }
            : {}),
        },
      )
    } catch (error) {
      if (signal.aborted || this.lifetimeAbort.signal.aborted || isAbortError(error)) throw error
      throw new Error(`MCP 工具调用失败：${safeMcpConnectionError(error, this.config)}`)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetimeAbort.abort()
    const operation = this.operation
    const client = this.client
    this.client = undefined
    this.transport = undefined
    this.state = 'disconnected'
    this.revision++
    await client?.close().catch(() => {})
    await operation?.catch(() => {})
  }

  private async refreshUnshared(signal: AbortSignal): Promise<void> {
    try {
      if (!this.client) {
        await this.connect(signal)
        return
      }
      const startingRevision = this.revision
      this.state = 'refreshing'
      const advertised = await listAllMcpTools(
        this.client,
        signal,
        this.config.startupTimeoutMs,
      )
      if (this.revision !== startingRevision) return
      this.publishCatalog(advertised)
      this.error = undefined
    } catch (error) {
      if (signal.aborted || this.closed || isAbortError(error)) throw error
      this.error = safeMcpConnectionError(error, this.config)
      this.state = 'failed'
    }
  }

  private async connect(signal: AbortSignal): Promise<void> {
    const previous = this.client
    this.client = undefined
    this.transport = undefined
    this.state = 'connecting'
    this.revision++
    await previous?.close().catch(() => {})

    const client = new Client(
      { name: 'WhyCode', version: '0.1.0' },
      {
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              if (this.closed || this.client !== client) return
              this.revision++
              this.state = 'refreshing'
              void this.refreshAfterCurrent()
            },
          },
        },
      },
    )
    const transport = createMcpTransport(this.config, this.fetchImpl)
    this.client = client
    this.transport = transport
    client.onclose = () => {
      if (this.closed || this.client !== client) return
      this.client = undefined
      this.transport = undefined
      this.state = 'disconnected'
      this.error = '连接已关闭'
      this.revision++
    }
    client.onerror = (error) => {
      if (this.client === client) {
        this.error = safeMcpConnectionError(error, this.config)
      }
    }
    try {
      await client.connect(transport, {
        signal,
        timeout: this.config.startupTimeoutMs,
        maxTotalTimeout: this.config.startupTimeoutMs,
      })
      const startingRevision = this.revision
      const advertised = await listAllMcpTools(
        client,
        signal,
        this.config.startupTimeoutMs,
      )
      if (this.closed || this.client !== client || signal.aborted) throw abortError()
      if (this.revision !== startingRevision) return
      this.publishCatalog(advertised)
      this.error = undefined
    } catch (error) {
      if (this.client === client) {
        this.client = undefined
        this.transport = undefined
        this.state = 'failed'
        this.revision++
      }
      await client.close().catch(() => {})
      throw error
    }
  }

  private publishCatalog(advertised: readonly McpAdvertisedTool[]): void {
    const next = buildServerCatalog(this.config, advertised)
    if (!sameMcpCatalog(this.tools, next.tools)) this.revision++
    this.tools = next.tools
    this.diagnostics = next.diagnostics
    this.state = 'ready'
  }

  private async refreshAfterCurrent(): Promise<void> {
    const pending = this.operation
    if (pending) await pending.catch(() => {})
    if (this.closed || !this.client || this.state !== 'refreshing') return
    await this.refresh(new AbortController().signal).catch(() => {})
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('MCP 会话已经关闭')
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortError(): Error {
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}
