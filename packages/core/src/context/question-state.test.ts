import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { questionsForBatch } from '../user-questions.ts'
import { withoutConversationMetadata } from './user-turn.ts'
import { carryPendingQuestions, pendingUserQuestions, withQuestionReply, withQuestionBatch } from './question-state.ts'

describe('异步提问身份', () => {
  const batch = (id: string) => ({ id, questions: [{ header: '需求', question: '环境？' }] })
  const first = questionsForBatch(batch('a')), second = questionsForBatch(batch('b'))
  const issued = (id: string) => withQuestionBatch({ role: 'assistant', content: '提问' }, batch(id))
  it('相同标题由不同调用独立回答，普通文本无法关闭问题', () => {
    const messages = [issued('a'), issued('b'), { role: 'user' as const, content: '回答「环境？」：Linux' }]
    assert.deepEqual(pendingUserQuestions(messages), [...first, ...second])
    assert.deepEqual(pendingUserQuestions([...messages, withQuestionReply(messages[2]!, { id: first[0]!.id, answer: 'Linux' })]), second)
  })
  it('压缩保留未答题的身份，跳过不产生模型输入', () => {
    const skip = withQuestionReply({ role: 'user', content: '' }, { id: first[0]!.id, answer: null })
    const rebuilt: ModelMessage[] = [{ role: 'user', content: '历史摘要' }]
    carryPendingQuestions(rebuilt, [issued('a'), issued('b'), skip])
    assert.deepEqual(pendingUserQuestions(rebuilt), second)
    assert.deepEqual(withoutConversationMetadata([...rebuilt, skip]), [{ role: 'user', content: '历史摘要' }])
  })
})
