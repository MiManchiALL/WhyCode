import type { ModelMessage, ToolResultPart } from 'ai'
import { fileReadKind } from '../file-read.ts'
import { READ_FILE_TOOL_NAME } from '../tools/read-file/prompt.ts'

export const TOOL_RESULT_MAX_CHARS = 8192
export const TOOL_RESULT_HEAD_CHARS = 4096
export const TOOL_RESULT_TAIL_CHARS = 1024
export const TOOL_RESULT_PRUNED = '\n\n[... tool result middle pruned ...]\n\n'

/** 以 Unicode 码点限制意外长文本；不清空旧结果，也不拆损多模态资料。 */
export function microcompact(messages: ModelMessage[]): ModelMessage[] | null {
  const protectedReads = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolName !== READ_FILE_TOOL_NAME) continue
      const input = part.input as { path?: unknown } | null
      if (typeof input?.path === 'string' && fileReadKind(input.path) !== 'text') protectedReads.add(part.toolCallId)
    }
  }
  let changed = false
  const compacted = messages.map(message => {
    if (message.role !== 'tool') return message
    let changedMessage = false
    const content = message.content.map(part => {
      if (part.type !== 'tool-result' || protectedReads.has(part.toolCallId)) return part
      const output = pruneOutput(part.output)
      if (output === part.output) return part
      changed = changedMessage = true
      return { ...part, output }
    })
    return changedMessage ? { ...message, content } : message
  })
  return changed ? compacted : null
}

function pruneText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text
  const chars = Array.from(text)
  return chars.length <= TOOL_RESULT_MAX_CHARS ? text
    : chars.slice(0, TOOL_RESULT_HEAD_CHARS).join('') + TOOL_RESULT_PRUNED
      + chars.slice(-TOOL_RESULT_TAIL_CHARS).join('')
}

function pruneOutput(output: ToolResultPart['output']): ToolResultPart['output'] {
  if (output.type === 'text' || output.type === 'error-text') {
    const value = pruneText(output.value)
    return value === output.value ? output : { ...output, value }
  }
  if (output.type !== 'content' || output.value.some(item => item.type !== 'text')) return output
  // 多个纯文本块共享一次结果预算；包含图片、文件或其它非文本块时整份结果豁免。
  const text = output.value.map(item => item.type === 'text' ? item.text : '').join('')
  const pruned = pruneText(text)
  return text === pruned ? output : { ...output, value: [{ type: 'text', text: pruned }] }
}
