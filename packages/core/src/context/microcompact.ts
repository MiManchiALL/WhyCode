import type { ModelMessage, ToolResultPart } from 'ai'
import { READ_FILE_TOOL_NAME } from '../tools/read-file/index.ts'
import { LIST_DIR_TOOL_NAME, GLOB_TOOL_NAME } from '../tools/list-glob/index.ts'
import { GREP_TOOL_NAME } from '../tools/grep/index.ts'
import { WRITE_FILE_TOOL_NAME, EDIT_FILE_TOOL_NAME } from '../tools/write-edit/index.ts'
import { BASH_TOOL_NAME } from '../tools/run-command/index.ts'
import { BATCH_EDIT_TOOL_NAME } from '../tools/batch-edit/index.ts'
import { DELETE_FILE_TOOL_NAME, MOVE_FILE_TOOL_NAME } from '../tools/file-lifecycle/index.ts'
import { READ_PDF_TOOL_NAME } from '../tools/read-pdf/index.ts'
import { imageToolResultSourceId } from '../attachments/messages.ts'
import {
  GET_COMMAND_OUTPUT_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
  START_COMMAND_TOOL_NAME,
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
  BATCH_EDIT_TOOL_NAME,
  DELETE_FILE_TOOL_NAME,
  MOVE_FILE_TOOL_NAME,
  BASH_TOOL_NAME,
  START_COMMAND_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
  GET_COMMAND_OUTPUT_TOOL_NAME,
  WRITE_COMMAND_INPUT_TOOL_NAME,
  STOP_COMMAND_TOOL_NAME,
])

export const CLEARED_MESSAGE = '[旧工具输出已清理以节省上下文，如需内容请重新调用工具]'
export const CLEARED_PDF_IMAGE_MESSAGE = '[旧 PDF 页面图已随工具输出清理，如需内容请重新调用 ReadPdf]'

/** 保留最近 N 个可清理结果不动 */
const KEEP_RECENT = 5

/**
 * 原地不可变改写：返回新数组（未触碰的消息保持引用）。
 * 返回 null 表示没有可清理的内容。
 */
export function microcompact(messages: ModelMessage[]): ModelMessage[] | null {
  // 收集所有可清理且未清理的 tool-result 位置（消息下标 + part 下标）
  const targets: {
    msgIdx: number
    partIdx: number
    toolName: string
    toolCallId: string
  }[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role !== 'tool' || typeof msg.content === 'string') continue
    for (let j = 0; j < msg.content.length; j++) {
      const part = msg.content[j]!
      if (part.type !== 'tool-result') continue
      if (!COMPACTABLE_TOOLS.has(part.toolName)) continue
      if (isCleared(part)) continue
      targets.push({
        msgIdx: i,
        partIdx: j,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
      })
    }
  }
  const toClear = targets.slice(0, Math.max(0, targets.length - KEEP_RECENT))
  if (toClear.length === 0) return null

  const clearSet = new Map<number, Set<number>>()
  for (const t of toClear) {
    if (!clearSet.has(t.msgIdx)) clearSet.set(t.msgIdx, new Set())
    clearSet.get(t.msgIdx)!.add(t.partIdx)
  }
  const clearedPdfCalls = new Set(
    toClear.filter((target) => target.toolName === READ_PDF_TOOL_NAME)
      .map((target) => target.toolCallId),
  )

  return messages.map((msg, i) => {
    const imageSourceId = imageToolResultSourceId(msg)
    if (imageSourceId && clearedPdfCalls.has(imageSourceId) && msg.role === 'user') {
      return { ...msg, content: [{ type: 'text', text: CLEARED_PDF_IMAGE_MESSAGE }] }
    }
    const parts = clearSet.get(i)
    if (!parts || msg.role !== 'tool' || typeof msg.content === 'string') return msg
    return {
      ...msg,
      content: msg.content.map((part, j) =>
        parts.has(j) && part.type === 'tool-result'
          ? { ...part, output: { type: 'text' as const, value: CLEARED_MESSAGE } }
          : part,
      ),
    }
  })
}

function isCleared(part: ToolResultPart): boolean {
  return (
    typeof part.output === 'object' &&
    part.output !== null &&
    'value' in part.output &&
    part.output.value === CLEARED_MESSAGE
  )
}
