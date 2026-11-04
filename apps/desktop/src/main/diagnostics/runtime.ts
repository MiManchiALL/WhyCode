import type { CoreEvent } from '@whycode/core'
import type { DiagnosticStore } from './store.ts'

/** 从事件中显式选取元数据，工具输入、输出和聊天正文不进入诊断存储。 */
export class RuntimeDiagnostics {
  private readonly tools = new Map<string, { started: number; name: string }>()
  private readonly store: DiagnosticStore
  constructor(store: DiagnosticStore) { this.store = store }

  record(runtimeId: string, sessionId: string | null, event: CoreEvent, occurredAt: string): void {
    const details: Record<string, unknown> = { runtimeId, sessionId }
    let level: 'info' | 'warn' | 'error' = 'info'
    switch (event.type) {
      case 'tool-start': {
        if (this.tools.size >= 256) this.tools.delete(this.tools.keys().next().value!)
        this.tools.set(`${runtimeId}:${event.toolUseId}`, { started: Date.parse(occurredAt), name: event.toolName })
        Object.assign(details, { toolUseId: event.toolUseId, toolName: event.toolName })
        break
      }
      case 'tool-end': {
        const key = `${runtimeId}:${event.toolUseId}`
        const tool = this.tools.get(key)
        this.tools.delete(key)
        Object.assign(details, { toolUseId: event.toolUseId, toolName: tool?.name, isError: event.isError,
          durationMs: tool ? Date.parse(occurredAt) - tool.started : undefined })
        if (event.isError) level = 'warn'
        break
      }
      case 'turn-start': case 'turn-end':
        details.turnId = event.turnId
        if (event.type === 'turn-end') details.stopReason = event.stopReason
        break
      case 'work-started': break
      case 'work-discarded': case 'work-finished':
        for (const key of this.tools.keys()) if (key.startsWith(`${runtimeId}:`)) this.tools.delete(key)
        if (event.type === 'work-finished') {
          Object.assign(details, { durationMs: event.durationMs, outcome: event.outcome, error: event.error })
          if (event.outcome === 'error') level = 'error'
        }
        break
      case 'model-request-retry':
        Object.assign(details, { retry: event.retry, maxRetries: event.maxRetries, delayMs: event.delayMs, message: event.message })
        level = 'warn'
        break
      case 'error':
        Object.assign(details, { message: event.message, recoverable: event.recoverable })
        level = 'error'
        break
      default: return
    }
    this.store.log({ source: 'runtime', event: event.type, level, details })
  }
}
