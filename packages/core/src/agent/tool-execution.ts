import type { ModelMessage, ToolCallPart, ToolSet } from 'ai'
import type { CoreEvent } from '../events.ts'
import {
  pendingToolCalls,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  toolResultMessage,
} from '../session/tool-execution.ts'

export type ToolEndEvent = Extract<CoreEvent, { type: 'tool-end' }> & { result: string }

export interface StepTool {
  definition: ToolSet[string]
  isReadOnly: boolean
  /** 校验和审批可以合并准备；返回的执行函数只由批次调度器派发。 */
  prepare: (input: unknown, toolCallId: string) => Promise<() => Promise<string>>
}

export type StepToolSet = Record<string, StepTool>
const MAX_PARALLEL_TOOL_CALLS = 10

/** 模型先生成完整调用，再由宿主执行；供应商推理签名和调用参数一起写稳后才允许副作用。 */
export function toolsForModel(tools: StepToolSet | undefined): ToolSet | undefined {
  if (!tools) return undefined
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, tool.definition]))
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

  async run(tools: StepToolSet | undefined): Promise<void> {
    const calls = [...this.calls.values()]
    const prepared = await Promise.all(calls.map((call) => this.prepare(call, tools?.[call.toolName])))
    const running = new Set<Promise<void>>()
    let failure: { error: unknown } | undefined
    let next = 0
    while (next < calls.length && !this.options.abort.signal.aborted && !failure) {
      const call = calls[next]!
      if (!tools?.[call.toolName]?.isReadOnly) {
        // 屏障前的读取全部结算后，独占调用才能进入；后面的读取不能越过它。
        await Promise.all(running)
        if (this.options.abort.signal.aborted || failure) break
      } else if (running.size >= MAX_PARALLEL_TOOL_CALLS) {
        await Promise.race(running)
        continue
      }
      const execution = this.invoke(call, prepared[next]!).catch((error) => {
        failure ??= { error }
        this.options.abort.abort('tool-execution-failure')
      }).finally(() => running.delete(execution))
      running.add(execution)
      next++
      if (!tools?.[call.toolName]?.isReadOnly) await execution
    }
    await Promise.all(running)
    if (failure) throw failure.error
    for (const call of calls.slice(next)) {
      await this.finish({ type: 'tool-end', toolUseId: call.toolCallId, result: TOOL_NOT_STARTED, isError: true })
    }
    await this.writeQueue
  }

  private async prepare(call: ToolCallPart, tool: StepTool | undefined): Promise<() => Promise<string>> {
    this.options.emit({ type: 'tool-start', toolUseId: call.toolCallId, toolName: call.toolName, input: call.input })
    try {
      if (!tool) throw new Error(`工具不存在：${call.toolName}`)
      return await tool.prepare(call.input, call.toolCallId)
    } catch (error) {
      return () => this.finish({
        type: 'tool-end', toolUseId: call.toolCallId, isError: true,
        result: `工具未执行：准备失败。${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  private async invoke(call: ToolCallPart, execute: () => Promise<string>): Promise<void> {
    try {
      await execute()
    } catch (error) {
      // 持久化失败不能伪造成工具错误，也不能让后续调用继续产生副作用。
      await this.writeQueue
      if (this.completed.has(call.toolCallId)) throw error
      await this.finish({
        type: 'tool-end', toolUseId: call.toolCallId, isError: true,
        result: `${this.started.has(call.toolCallId) ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED}\n${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
}
