import type { AgentSession } from '../agent/session.ts'
import { formatQuestionAnswer, type UserQuestionItem } from '../user-questions.ts'
import { withQuestionBatch } from '../context/question-state.ts'

export function questionResult(batch: { id: string; questions: UserQuestionItem[] }, planId: string | null) {
  return withQuestionBatch({ role: 'tool', content: [{ type: 'tool-result', toolName: 'AskUserQuestion',
    toolCallId: batch.id, output: { type: 'text', value: '问题已提交。' } }] }, { ...batch, ...(planId ? { planId } : {}) })
}

export function answerFirstQuestion(session: AgentSession, answer: string) {
  const question = session.pendingQuestions[0]!
  return session.handleUserMessage(formatQuestionAnswer(question, answer), false, [], undefined, [], [], 'native', [{ id: question.id, answer }])
}
