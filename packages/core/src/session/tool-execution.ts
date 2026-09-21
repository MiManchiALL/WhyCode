import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'

export const TOOL_NOT_STARTED = '工具未执行：调用在进入执行阶段前已取消。'
export const TOOL_OUTCOME_UNKNOWN = '工具执行结果未知：调用已开始，但没有取得完整结果，可能已产生部分副作用。继续相关工作前先核实实际状态，不要直接重试有副作用的操作。'

export function pendingToolCalls(messages: readonly ModelMessage[]): ToolCallPart[] {
  const pending = new Map<string, ToolCallPart>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === 'tool-call' && !part.providerExecuted) pending.set(part.toolCallId, part)
      if (part.type === 'tool-result') pending.delete(part.toolCallId)
    }
  }
  return [...pending.values()]
}

export function toolResultMessage(
  call: ToolCallPart,
  value: string,
  isError = false,
): ModelMessage {
  const output: ToolResultPart['output'] = { type: isError ? 'error-text' : 'text', value }
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output }],
  }
}

/** 只补齐尚无结果的调用；已有结果及供应商元数据始终保留。 */
export function interruptedToolResults(
  messages: readonly ModelMessage[],
  started: ReadonlySet<string>,
): ModelMessage[] {
  return pendingToolCalls(messages).map((call) => toolResultMessage(
    call,
    started.has(call.toolCallId) ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED,
    true,
  ))
}
