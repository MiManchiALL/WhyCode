import type { ModelMessage } from 'ai'
import type { ConversationMessage } from './user-turn.ts'
import { questionsForBatch, type PendingQuestion, type QuestionReply, type UserQuestion } from '../user-questions.ts'

/** 题目来自已提交的工具结果，回答来自宿主接收的输入。普通消息不能凭文字匹配结题。 */
export function pendingUserQuestions(messages: readonly ConversationMessage[]): PendingQuestion[] {
  const pending = new Map<string, PendingQuestion>()
  for (const message of messages) {
    if (message.whycode?.questionBatch) {
      for (const item of questionsForBatch(message.whycode.questionBatch)) pending.set(item.id, item)
    }
    const reply = message.whycode?.questionReply
    if (reply) for (const item of reply) pending.delete(item.id)
    for (const id of message.whycode?.skippedQuestionIds ?? []) pending.delete(id)
    if (message.whycode?.pendingQuestions) {
      pending.clear()
      for (const question of message.whycode.pendingQuestions) pending.set(question.id, question)
    }
  }
  return [...pending.values()]
}

export function availableQuestions(pending: PendingQuestion[], inputs: Iterable<{ questionReply?: QuestionReply; state?: 'queued' | 'restored' }>): PendingQuestion[] {
  const reserved = new Set<string>()
  for (const input of inputs) {
    if (input.state !== 'restored') for (const reply of input.questionReply ?? []) reserved.add(reply.id)
  }
  return reserved.size ? pending.filter(item => !reserved.has(item.id)) : pending
}

export function hasPendingUserQuestion(messages: readonly ModelMessage[]): boolean {
  return pendingUserQuestions(messages).length > 0
}

export function withQuestionBatch(message: ConversationMessage, questionBatch: UserQuestion): ConversationMessage {
  return { ...message, whycode: { ...message.whycode, questionBatch } }
}

export function withQuestionReply(message: ConversationMessage, reply: QuestionReply): ConversationMessage {
  return { ...message, whycode: { ...message.whycode, questionReply: reply } }
}

/** 把跳过记在发生时的历史末尾。改写早先的工具结果会使已保存的回合前缀失效。 */
export function applyQuestionSkips(messages: ConversationMessage[], ids: readonly string[]): void {
  const last = messages.at(-1)
  if (!last) return
  const meta = last.whycode
  const skippedQuestionIds = [...new Set([...(meta?.skippedQuestionIds ?? []), ...ids])]
  messages[messages.length - 1] = { ...last, whycode: { ...meta, skippedQuestionIds,
    ...(meta?.pendingQuestions ? { pendingQuestions: meta.pendingQuestions.filter(item => !ids.includes(item.id)) } : {}),
  } }
}

export function answersPlanQuestion(pending: readonly PendingQuestion[], inputs: readonly ConversationMessage[], planId?: string): boolean {
  return Boolean(planId && inputs.some(message => {
    const reply = message.whycode?.questionReply
    return reply?.some(item => item.answer !== null && pending.some(question => question.id === item.id && question.planId === planId))
  }))
}

/** 压缩只携带仍待回答的题目，提问所在的整个旧回合可以正常移出尾部。 */
export function carryPendingQuestions(messages: ModelMessage[], source: readonly ModelMessage[]): void {
  const last = messages.at(-1) as ConversationMessage | undefined
  if (!last) return
  const pending = pendingUserQuestions(source)
  const retained = pendingUserQuestions(messages)
  if (retained.length !== pending.length || retained.some((item, index) => item.id !== pending[index]?.id)) {
    messages[messages.length - 1] = { ...last, whycode: { ...last.whycode, pendingQuestions: pending } } as ConversationMessage
  }
}
