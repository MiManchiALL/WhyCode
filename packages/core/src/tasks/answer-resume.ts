import type { ModelMessage } from 'ai'
import {
  MAX_USER_QUESTIONS,
  userQuestionAnswerPrefix,
  type UserQuestion,
  type UserQuestionItem,
} from '../events.ts'

const USER_QUESTION_MARKER_OPEN = '<whycode-user-question version="2">'
const USER_QUESTION_MARKER_CLOSE = '</whycode-user-question>'

export interface UserQuestionBinding {
  question: UserQuestion
  resumesTaskPlan: boolean
}

/** 所有成功 Ask 都持久化完整问题；是否接合旧计划由显式字段决定。 */
export function createUserQuestionMarker(
  question: UserQuestion,
  resumesTaskPlan: boolean,
): ModelMessage {
  const binding: UserQuestionBinding = {
    question: structuredClone(question),
    resumesTaskPlan,
  }
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      USER_QUESTION_MARKER_OPEN,
      JSON.stringify(binding),
      resumesTaskPlan
        ? '上一回合的问题是继续当前活动计划所必需的等待点。只有通过问题卡提交、且明确引用原问题的回答才恢复原计划；其它新消息优先处理，旧计划保持休眠。'
        : '上一回合正在等待这个问题的回答。问题卡提交会明确引用原问题，但该回答不自动接合任何旧任务计划；其它新消息按新的回合意图处理。',
      USER_QUESTION_MARKER_CLOSE,
      '</system-reminder>',
    ].join('\n'),
  }
}

export function findPendingUserQuestionIndex(messages: ModelMessage[]): number | null {
  let markerIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isUserQuestionMarker(messages[index]!)) {
      markerIndex = index
      break
    }
  }
  if (markerIndex < 0) return null
  return messages.slice(markerIndex + 1).some(isRealUserMessage) ? null : markerIndex
}

export function hasPendingUserQuestion(messages: ModelMessage[]): boolean {
  return findPendingUserQuestionIndex(messages) !== null
}

export function findPendingUserQuestion(
  messages: ModelMessage[],
): UserQuestionBinding | null {
  const index = findPendingUserQuestionIndex(messages)
  return index === null ? null : parseBinding(messages[index]!)
}

/** Renderer 的问题卡统一生成该可见格式；普通输入不会误唤醒旧计划。 */
export function isUserQuestionAnswer(
  binding: UserQuestionBinding,
  text: string,
): boolean {
  const normalized = text.trim()
  const items = binding.question.questions
  if (items.length === 1) {
    const prefix = userQuestionAnswerPrefix(items[0]!, 0, 1)
    return normalized.startsWith(prefix) && normalized.slice(prefix.length).trim().length > 0
  }
  const lines = normalized.split('\n')
  if (lines.length !== items.length) return false
  return items.every((item, index) => {
    const prefix = userQuestionAnswerPrefix(item, index, items.length)
    const line = lines[index]
    return Boolean(line?.startsWith(prefix) && line.slice(prefix.length).trim().length > 0)
  })
}

function isUserQuestionMarker(message: ModelMessage): boolean {
  if (message.role !== 'user') return false
  const content = messageText(message).trim()
  return content.startsWith(`<system-reminder>\n${USER_QUESTION_MARKER_OPEN}\n`)
    && content.endsWith(`${USER_QUESTION_MARKER_CLOSE}\n</system-reminder>`)
}

function isRealUserMessage(message: ModelMessage): boolean {
  if (message.role !== 'user') return false
  return !messageText(message).trimStart().startsWith('<system-reminder>')
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

function parseBinding(message: ModelMessage): UserQuestionBinding | null {
  const content = messageText(message)
  const start = content.indexOf(USER_QUESTION_MARKER_OPEN)
  if (start < 0) return null
  const body = content.slice(start + USER_QUESTION_MARKER_OPEN.length).trimStart()
  const line = body.split('\n', 1)[0]
  if (!line) return null
  try {
    const parsed = JSON.parse(line) as Partial<UserQuestionBinding>
    return isUserQuestion(parsed.question) && typeof parsed.resumesTaskPlan === 'boolean'
      ? {
          question: structuredClone(parsed.question),
          resumesTaskPlan: parsed.resumesTaskPlan,
        }
      : null
  } catch {
    return null
  }
}

function isUserQuestion(value: unknown): value is UserQuestion {
  if (!value || typeof value !== 'object') return false
  if (Object.keys(value).some((key) => key !== 'id' && key !== 'questions')) return false
  const question = value as Partial<UserQuestion>
  return typeof question.id === 'string'
    && Array.isArray(question.questions)
    && question.questions.length >= 1
    && question.questions.length <= MAX_USER_QUESTIONS
    && question.questions.every(isUserQuestionItem)
}

function isUserQuestionItem(value: unknown): value is UserQuestionItem {
  if (!value || typeof value !== 'object') return false
  const question = value as Partial<UserQuestionItem>
  return typeof question.header === 'string'
    && typeof question.question === 'string'
    && Array.isArray(question.options)
    && question.options.length >= 2
    && question.options.length <= 4
    && question.options.every((option) =>
      Boolean(
        option
        && typeof option === 'object'
        && 'label' in option
        && typeof option.label === 'string'
        && 'description' in option
        && typeof option.description === 'string',
      ))
}
