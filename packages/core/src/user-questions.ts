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
export const questionSubmissionSchema = z.array(questionResolutionSchema).nonempty().refine(
  items => new Set(items.map(item => item.id)).size === items.length, '问题重复',
)
export type QuestionSubmission = z.infer<typeof questionSubmissionSchema>
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

/** 编辑器展示的是普通用户消息。保留仍可明确对应的题目，完全改写的多题正文作为新请求。 */
export function editedQuestionSubmission(questions: PendingQuestion[], previous: QuestionSubmission | undefined, text: string): QuestionSubmission | undefined {
  if (!previous) return undefined
  const byId = new Map(questions.map(question => [question.id, question]))
  const answered = previous.filter(item => item.answer !== null)
  if (!answered.length || !previous.every(item => byId.has(item.id))) return undefined
  if (answered.length === 1) {
    const item = answered[0]!
    const prefix = formatQuestionAnswer(byId.get(item.id)!, '')
    const answer = (text.startsWith(prefix) ? text.slice(prefix.length) : text).trim()
    if (!answer) throw new Error('回答不能为空')
    return previous.map(entry => entry.id === item.id ? { ...entry, answer } : entry)
  }
  if (formatQuestionSubmission(questions, previous) === text) return previous
  const prefixes = answered.map(item => formatQuestionAnswer(byId.get(item.id)!, ''))
  const updates = new Map<string, string>()
  let offset = 0
  for (const [index, item] of answered.entries()) {
    const prefix = prefixes[index]!
    if (!text.startsWith(prefix, offset)) return undefined
    const start = offset + prefix.length
    const next = prefixes[index + 1]
    const end = next === undefined ? text.length : text.indexOf('\n\n' + next, start)
    if (end < 0) return undefined
    const answer = text.slice(start, end).trim()
    if (!answer) throw new Error('回答不能为空')
    updates.set(item.id, answer)
    offset = end + 2
  }
  return previous.map(item => item.answer === null ? item : { ...item, answer: updates.get(item.id)! })
}
