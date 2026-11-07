import type { PendingQuestion, QuestionSubmission } from '@whycode/core/events'
import type { QuestionDraft } from './composer-drafts.ts'

export function reconcileQuestionDraft(draft: QuestionDraft | undefined, questions: readonly PendingQuestion[]): QuestionDraft | undefined {
  if (!draft || !questions.length) return undefined
  const remaining = new Set(questions.map(question => question.id))
  if ((!draft.currentId || remaining.has(draft.currentId)) && Object.keys(draft.answers).every(id => remaining.has(id))) return draft
  return { collapsed: draft.collapsed, currentId: remaining.has(draft.currentId ?? '') ? draft.currentId : undefined,
    answers: Object.fromEntries(Object.entries(draft.answers).filter(([id]) => remaining.has(id))) }
}

/** null 是用户明确跳过，尚未填写的题目不能参与提交。 */
export function questionSubmission(questions: readonly PendingQuestion[], answers: QuestionDraft['answers']): QuestionSubmission | null {
  const result: QuestionSubmission = []
  for (const question of questions) {
    const value = answers[question.id]
    if (value !== null && !value?.trim()) return null
    result.push({ id: question.id, answer: value === null ? null : value.trim() })
  }
  return result.length ? result : null
}
