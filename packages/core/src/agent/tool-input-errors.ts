import { InvalidToolInputError, JSONParseError, TypeValidationError, type ModelMessage, type ToolSet, type TypedToolCall } from 'ai'
import { z } from 'zod'
import { unicodeSafePrefix } from '../text.ts'

function shortMessage(message: string): string {
  return message.length <= 300 ? message : unicodeSafePrefix(message, 299) + '…'
}

const typeNames: Readonly<Record<string, string>> = {
  boolean: '布尔值', string: '字符串', number: '数字', int: '整数', array: '数组', object: '对象', null: 'null',
}

function describeIssue(issue: z.core.$ZodIssue, input: unknown): string {
  const field = z.core.toDotPath(issue.path) || '参数'
  let value = input
  for (const key of issue.path) {
    value = value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
  }
  if (issue.code === 'invalid_type') {
    const expected = typeNames[issue.expected] ?? issue.expected
    if (value === undefined) return `缺少 ${field}，应为${expected}。`
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    return `${field} 应为${expected}，收到${typeNames[actual] ?? actual}。`
  }
  if (typeof value === 'number') {
    if (issue.code === 'too_small' && issue.inclusive) return `${field} 至少为 ${issue.minimum}，收到 ${value}。`
    if (issue.code === 'too_big' && issue.inclusive) return `${field} 最大为 ${issue.maximum}，收到 ${value}。`
  }
  return issue.message.startsWith(field + ' ') ? issue.message : `${field}：${issue.message}`
}

export function formatToolInputError(error: unknown, input: unknown): string {
  if (TypeValidationError.isInstance(error)) return formatToolInputError(error.cause, input)
  if (JSONParseError.isInstance(error)) return '工具参数必须是有效的 JSON。'
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? shortMessage(error.message) : '工具参数无效。'
  }
  const issues = error.issues
  const messages = issues.slice(0, 3).map(issue => shortMessage(describeIssue(issue, input)))
  if (issues.length > messages.length) messages.push(`另有 ${issues.length - messages.length} 处参数错误。`)
  return messages.join('\n')
}

/** SDK 在工具派发前已配对的校验失败也会进入历史，按调用 ID 替换对应的错误正文。 */
export function compactToolInputErrors(messages: ModelMessage[], calls: readonly TypedToolCall<ToolSet>[]): ModelMessage[] {
  const errors = new Map<string, string>()
  for (const call of calls) {
    if (!call.providerExecuted && call.invalid && InvalidToolInputError.isInstance(call.error)) {
      errors.set(call.toolCallId, formatToolInputError(call.error.cause, call.input))
    }
  }
  if (!errors.size) return messages
  return messages.map(message => message.role !== 'tool' ? message : {
    ...message,
    content: message.content.map(part => {
      if (part.type !== 'tool-result' || part.output.type !== 'error-text') return part
      const value = errors.get(part.toolCallId)
      return value === undefined ? part : { ...part, output: { ...part.output, value } }
    }),
  })
}
