import type { ModelMessage } from 'ai'
import type { ConversationMessage } from './user-turn.ts'
import { questionsForBatch, type PendingQuestion, type QuestionSubmission, type UserQuestion } from '../user-questions.ts'

/** 题目来自已提交的工具结果，回答来自宿主接收的输入。普通消息不能凭文字匹配结题。 */
export function pendingUserQuestions(messages: readonly ConversationMessage[]): PendingQuestion[] {
  const pending = new Map<string, PendingQuestion>()
  for (const message of messages) {
    if (message.whycode?.questionBatch) {
      for (const item of questionsForBatch(message.whycode.questionBatch)) pending.set(item.id, item)
    }
    const reply = message.whycode?.questionReply
    if (reply) for (const item of reply) pending.delete(item.id)
    if (message.whycode?.pendingQuestions) {
      pending.clear()
      for (const question of message.whycode.pendingQuestions) pending.set(question.id, question)
    }
  }
  return [...pending.values()]
}

export function availableQuestions(pending: PendingQuestion[], inputs: Iterable<{ questionReply?: QuestionSubmission; state?: 'queued' | 'restored' }>): PendingQuestion[] {
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

export function withQuestionReply(message: ConversationMessage, reply: QuestionSubmission): ConversationMessage {
  return { ...message, whycode: { ...message.whycode, questionReply: reply } }
}

/** 跳过只更新提问结果或压缩快照的宿主元数据，不改变模型消息的数量、顺序或正文。 */
export function applyQuestionSkips(messages: ConversationMessage[], ids: readonly string[]): void {
  const remaining = new Set(ids)
  for (let i = messages.length - 1; i >= 0 && remaining.size; i--) {
    const message = messages[i]!
    const meta = message.whycode
    if (meta?.pendingQuestions) {
      messages[i] = { ...message, whycode: { ...meta, pendingQuestions: meta.pendingQuestions.filter(item => !remaining.has(item.id)) } }
      break
    }
    if (!meta?.questionBatch) continue
    const skipped = questionsForBatch(meta.questionBatch).filter(item => remaining.delete(item.id))
    if (skipped.length) messages[i] = withQuestionReply(message, [...(meta.questionReply ?? []), ...skipped.map(item => ({ id: item.id, answer: null }))])
  }
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
