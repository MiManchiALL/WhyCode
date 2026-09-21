import type { ModelMessage, ToolCallPart, ToolSet } from 'ai'
import type { CoreEvent } from '../events.ts'
import {
  pendingToolCalls,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  toolResultMessage,
} from '../session/tool-execution.ts'

export type ToolEndEvent = Extract<CoreEvent, { type: 'tool-end' }> & { result: string }

/** 模型先生成完整调用，再由宿主执行；供应商推理签名和调用参数一起写稳后才允许副作用。 */
export function toolsForModel(tools: ToolSet | undefined): ToolSet | undefined {
  if (!tools) return undefined
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    const { execute: _execute, ...definition } = tool
    return [name, definition]
  }))
}

interface ToolExecutionOptions {
  messages: readonly ModelMessage[]
  abort: AbortController
  emit: (event: CoreEvent) => void
  recordStart: (toolCallId: string) => Promise<void>
  recordResult: (message: ModelMessage, event: ToolEndEvent) => Promise<void>
}

export class ToolExecutionBatch {
  private readonly options: ToolExecutionOptions
  private readonly calls: Map<string, ToolCallPart>
  private readonly started = new Set<string>()
  private readonly completed = new Set<string>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: ToolExecutionOptions) {
    this.options = options
    this.calls = new Map(pendingToolCalls(options.messages).map((call) => [call.toolCallId, call]))
  }

  async start(toolCallId: string): Promise<void> {
    await this.options.recordStart(toolCallId)
    this.started.add(toolCallId)
  }

  finish(event: ToolEndEvent): Promise<string> {
    const call = this.calls.get(event.toolUseId)
    if (!call) throw new Error(`未登记的工具调用：${event.toolUseId}`)
    const write = this.writeQueue.then(async () => {
      const message = toolResultMessage(call, event.result, event.isError)
      await this.options.recordResult(message, event)
      this.completed.add(event.toolUseId)
      this.options.emit(event)
    })
    this.writeQueue = write
    return write.then(() => event.result, (error) => {
      this.options.abort.abort('tool-persistence-failure')
      throw error
    })
  }

  async run(tools: ToolSet | undefined): Promise<void> {
    // 副作用队列由工具包装器持有；这里保留只读并发，并等待所有已启动调用真正收尾。
    const results = await Promise.allSettled([...this.calls.values()].map(async (call) => {
      const execute = tools?.[call.toolName]?.execute
      if (!execute) {
        await this.finish({
          type: 'tool-end', toolUseId: call.toolCallId, isError: true,
          result: `工具不存在，未执行：${call.toolName}`,
        })
        return
      }
      try {
        await execute(call.input, {
          toolCallId: call.toolCallId,
          messages: [...this.options.messages],
          abortSignal: this.options.abort.signal,
          context: undefined,
        })
      } catch (error) {
        // 持久化失败不能伪造成成功提交；其它调度错误也要逐项留下明确结果。
        await this.writeQueue
        if (this.completed.has(call.toolCallId)) throw error
        await this.finish({
          type: 'tool-end', toolUseId: call.toolCallId, isError: true,
          result: `${this.started.has(call.toolCallId) ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED}\n${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }))
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
  }
}
