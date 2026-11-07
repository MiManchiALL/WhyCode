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
export type UserQuestionItem = z.infer<typeof userQuestionItemSchema>
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>
export type QuestionResolution = z.infer<typeof questionResolutionSchema>

export function questionsForBatch(batch: UserQuestion): PendingQuestion[] {
  return batch.questions.map((item, index) => ({ id: JSON.stringify([batch.id, index]), toolUseId: batch.id, item, planId: batch.planId ?? null }))
}

export function formatQuestionAnswer(question: PendingQuestion, answer: string): string {
  return `回答「${question.item.question}」：${answer}`
}
