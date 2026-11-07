import type { PendingQuestion } from '@whycode/core/events'
import type { QuestionDraft } from './composer-drafts.ts'

export function reconcileQuestionDraft(draft: QuestionDraft | undefined, questions: readonly PendingQuestion[]): QuestionDraft | undefined {
  if (!draft || !questions.length) return undefined
  const remaining = new Set(questions.map(question => question.id))
  if ((!draft.currentId || remaining.has(draft.currentId)) && Object.keys(draft.answers).every(id => remaining.has(id))) return draft
  return { collapsed: draft.collapsed, currentId: remaining.has(draft.currentId ?? '') ? draft.currentId : undefined,
    answers: Object.fromEntries(Object.entries(draft.answers).filter(([id]) => remaining.has(id))) }
}
