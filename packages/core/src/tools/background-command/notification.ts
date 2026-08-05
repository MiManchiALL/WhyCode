import type { ModelMessage } from 'ai'
import { unicodeSafePrefix } from '../../text.ts'
import type { CommandTaskTerminalNotification } from './types.ts'

const MAX_COMMAND_CHARS = 2_000
const MAX_FAILURE_REASON_CHARS = 2_000
export const COMMAND_TASK_NOTIFICATION_OPEN =
  '<task-notification source="background-command" version="1">'
export const COMMAND_TASK_NOTIFICATION_CLOSE = '</task-notification>'

export function isCommandTaskNotificationText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith(`${COMMAND_TASK_NOTIFICATION_OPEN}\n`)
    && trimmed.endsWith(`\n${COMMAND_TASK_NOTIFICATION_CLOSE}`)
}

/** 只携带权威终态与读取入口；完整日志继续由 GetCommandOutput 按需提供。 */
export function createCommandTaskNotificationMessage(
  notification: CommandTaskTerminalNotification,
): ModelMessage {
  const { task } = notification
  const payload = {
    task_id: task.id,
    status: task.status,
    exit_code: task.exitCode ?? null,
    command: unicodeSafePrefix(task.command, MAX_COMMAND_CHARS),
    working_directory: task.cwd,
    output_bytes: task.outputBytes,
    output_truncated: task.outputTruncated,
    failure_reason: task.failureReason
      ? unicodeSafePrefix(task.failureReason, MAX_FAILURE_REASON_CHARS)
      : null,
  }
  return {
    role: 'user',
    content: [
      COMMAND_TASK_NOTIFICATION_OPEN,
      serializePayload(payload),
      '这是应用生成的后台任务终态，不是用户输入。请读取尚未检查的输出并据此继续当前工作；不要只复述通知。',
      COMMAND_TASK_NOTIFICATION_CLOSE,
    ].join('\n'),
  }
}

/** JSON 放进 XML 文本节点前转义三个标记字符，避免命令文本伪造通知边界。 */
function serializePayload(payload: object): string {
  return JSON.stringify(payload)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
}
