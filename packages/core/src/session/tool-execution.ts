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

/** 日志按完成时刻追加；规范历史只在同一连续工具结果组内按调用顺序投影。 */
export function appendOrderedMessages(target: ModelMessage[], messages: readonly ModelMessage[]): void {
  for (const message of messages) {
    target.push(message)
    if (message.role === 'tool') orderToolResultTail(target)
  }
}

function orderToolResultTail(messages: ModelMessage[]): void {
  let start = messages.length - 1
  while (start > 0 && messages[start - 1]!.role === 'tool') start--
  let head = start
  while (head > 0 && messages[head - 1]!.role === 'assistant') head--
  const callIds = messages.slice(head, start).flatMap((message) =>
    Array.isArray(message.content) ? message.content.flatMap((part) =>
      part.type === 'tool-call' ? [part.toolCallId] : []) : [])
  if (callIds.length < 2) return
  const order = new Map(callIds.map((id, index) => [id, index]))
  const results = messages.slice(start).flatMap((message) => message.role === 'tool'
    ? message.content.map((part) => ({ message, part })) : [])
  // 不跨用户消息、其它步骤或无关联的协议块搬动结果。
  if (results.some(({ part }) => part.type !== 'tool-result' || !order.has(part.toolCallId))) return
  const sorted = [...results].sort((a, b) =>
    order.get((a.part as ToolResultPart).toolCallId)! - order.get((b.part as ToolResultPart).toolCallId)!)
  if (sorted.every((result, index) => result === results[index])) return
  messages.splice(start, messages.length - start, ...sorted.map(({ message, part }) =>
    message.content.length === 1 ? message : { ...message, content: [part] }))
}
