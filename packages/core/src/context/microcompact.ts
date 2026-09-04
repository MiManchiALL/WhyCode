import type { ModelMessage, ToolResultPart } from 'ai'
import { READ_FILE_TOOL_NAME } from '../tools/read-file/index.ts'
import { LIST_DIR_TOOL_NAME, GLOB_TOOL_NAME } from '../tools/list-glob/index.ts'
import { GREP_TOOL_NAME } from '../tools/grep/index.ts'
import { WRITE_FILE_TOOL_NAME, EDIT_FILE_TOOL_NAME } from '../tools/write-edit/index.ts'
import { RUN_COMMAND_TOOL_NAME } from '../tools/run-command/index.ts'
import { DELETE_FILE_TOOL_NAME, MOVE_FILE_TOOL_NAME } from '../tools/file-lifecycle/index.ts'
import { READ_PDF_TOOL_NAME } from '../tools/read-pdf/index.ts'
import {
  GET_COMMAND_OUTPUT_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
  STOP_COMMAND_TOOL_NAME,
  WRITE_COMMAND_INPUT_TOOL_NAME,
} from '../tools/background-command/constants.ts'

/**
 * 微清理（M2-d 第一级，零模型成本）：把「可重现」工具的旧输出替换为占位文本。
 * 幂等冻结：已清理的内容永不复原/再变（同一前缀字节稳定，不反复打破厂商缓存）。
 */

/** 只清理可重现/可再获取的工具输出 */
const COMPACTABLE_TOOLS = new Set([
  READ_FILE_TOOL_NAME,
  READ_PDF_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  DELETE_FILE_TOOL_NAME,
  MOVE_FILE_TOOL_NAME,
  RUN_COMMAND_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
  GET_COMMAND_OUTPUT_TOOL_NAME,
  WRITE_COMMAND_INPUT_TOOL_NAME,
  STOP_COMMAND_TOOL_NAME,
])

export const CLEARED_MESSAGE = '[旧工具输出已清理以节省上下文，如需内容请重新调用工具]'

/** 保留最近 N 个可清理结果不动 */
const KEEP_RECENT = 5

/**
 * 原地不可变改写：返回新数组（未触碰的消息保持引用）。
 * 返回 null 表示没有可清理的内容。
 */
export function microcompact(messages: ModelMessage[]): ModelMessage[] | null {
  let remaining = KEEP_RECENT
  let compacted: ModelMessage[] | null = null
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'tool' || typeof message.content === 'string') continue
    let content: typeof message.content | null = null
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex]!
      if (
        part.type !== 'tool-result'
        || !COMPACTABLE_TOOLS.has(part.toolName)
        || isCleared(part)
      ) continue
      if (remaining > 0) {
        remaining--
        continue
      }
      content ??= [...message.content]
      content[partIndex] = { ...part, output: { type: 'text', value: CLEARED_MESSAGE } }
    }
    if (content) {
      compacted ??= [...messages]
      compacted[index] = { ...message, content }
    }
  }
  return compacted
}

function isCleared(part: ToolResultPart): boolean {
  return (
    typeof part.output === 'object' &&
    part.output !== null &&
    'value' in part.output &&
    part.output.value === CLEARED_MESSAGE
  )
}
