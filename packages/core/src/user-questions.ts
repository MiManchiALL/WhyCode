import { z } from 'zod'

export const MAX_USER_QUESTIONS = 6
export const userQuestionItemSchema = z.strictObject({
  header: z.string().trim().min(1).max(12).describe('问题卡的短标题'),
  question: z.string().trim().min(1).max(500).describe('包含回答所需背景的简短问题'),
  options: z.array(z.strictObject({
    label: z.string().trim().min(1).max(40),
    description: z.string().trim().min(1).max(240).optional(),
  })).min(2).max(4).optional().describe('可选的互斥建议，界面会自动提供自由输入，无需添加“其它”'),
})
export const askUserQuestionSchema = z.strictObject({
  questions: z.array(userQuestionItemSchema).min(1).max(MAX_USER_QUESTIONS),
})
export const userQuestionSchema = askUserQuestionSchema.extend({
  id: z.string().min(1),
  planId: z.string().optional(),
})
export type UserQuestion = z.infer<typeof userQuestionSchema>
export const pendingQuestionSchema = z.strictObject({
  id: z.string().min(1),
  toolUseId: z.string().min(1),
  item: userQuestionItemSchema,
  planId: z.string().nullable(),
})
export const questionResolutionSchema = z.strictObject({
  id: z.string().min(1),
  answer: z.string().trim().min(1).nullable(),
})
const answerInUserMessage = z.strictObject({ source: z.literal('message') })
const recordedResolutionSchema = questionResolutionSchema.extend({
  answer: z.union([questionResolutionSchema.shape.answer, answerInUserMessage]),
})
function uniqueQuestions(items: { id: string }[]) {
  return new Set(items.map(item => item.id)).size === items.length
}
export const questionSubmissionSchema = z.array(questionResolutionSchema).nonempty().refine(uniqueQuestions, '问题重复')
export const questionReplySchema = z.array(recordedResolutionSchema).nonempty().refine(uniqueQuestions, '问题重复')
export type QuestionSubmission = z.infer<typeof questionSubmissionSchema>
export type QuestionReply = z.infer<typeof questionReplySchema>
export type UserQuestionItem = z.infer<typeof userQuestionItemSchema>
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>
export type QuestionResolution = z.infer<typeof questionResolutionSchema>

export function questionsForBatch(batch: UserQuestion): PendingQuestion[] {
  return batch.questions.map((item, index) => ({ id: JSON.stringify([batch.id, index]), toolUseId: batch.id, item, planId: batch.planId ?? null }))
}

export function formatQuestionAnswer(question: PendingQuestion, answer: string): string {
  return `回答「${question.item.question}」：${answer}`
}

export function formatQuestionSubmission(questions: readonly PendingQuestion[], answers: QuestionSubmission): string | null {
  const byId = new Map(answers.map(item => [item.id, item.answer]))
  const parts: string[] = []
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) continue
    if (answer !== null) parts.push(formatQuestionAnswer(question, answer))
    byId.delete(question.id)
  }
  return byId.size ? null : parts.join('\n\n')
}

/** 编辑不会改变这条用户消息回答的是哪些题。自由改写只取消逐题归属，正文仍由用户消息持有。 */
export function editedQuestionSubmission(questions: PendingQuestion[], previous: QuestionReply | undefined, text: string): QuestionReply | undefined {
  if (!previous) return undefined
  const byId = new Map(questions.map(question => [question.id, question]))
  const retained = previous.filter(item => byId.has(item.id))
  if (!retained.length) return undefined
  const answered = retained.filter(item => item.answer !== null)
  if (!answered.length) return retained
  const linked = () => retained.map(item => item.answer === null ? item : { id: item.id, answer: { source: 'message' as const } })
  const prefixes = answered.map(item => formatQuestionAnswer(byId.get(item.id)!, ''))
  const updates = new Map<string, string>()
  let offset = 0
  for (const [index, item] of answered.entries()) {
    const prefix = prefixes[index]!
    if (!text.startsWith(prefix, offset)) return linked()
    const start = offset + prefix.length
    const next = prefixes[index + 1]
    const end = next === undefined ? text.length : text.indexOf('\n\n' + next, start)
    if (end < 0) return linked()
    const answer = text.slice(start, end).trim()
    if (!answer) return linked()
    updates.set(item.id, answer)
    offset = end + 2
  }
  return retained.map(item => item.answer === null ? item : { ...item, answer: updates.get(item.id)! })
}
