import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { editedQuestionSubmission, formatQuestionSubmission, questionReplySchema, questionSubmissionSchema, questionsForBatch } from '../user-questions.ts'
import { withoutConversationMetadata } from './user-turn.ts'
import { carryPendingQuestions, pendingUserQuestions, applyQuestionSkips, withQuestionReply, withQuestionBatch } from './question-state.ts'

describe('异步提问身份', () => {
  const batch = (id: string) => ({ id, questions: [{ header: '需求', question: '环境？' }] })
  const first = questionsForBatch(batch('a')), second = questionsForBatch(batch('b'))
  const issued = (id: string) => withQuestionBatch({ role: 'assistant', content: '提问' }, batch(id))
  it('相同标题由不同调用独立回答，普通文本无法关闭问题', () => {
    const messages = [issued('a'), issued('b'), { role: 'user' as const, content: '回答「环境？」：Linux' }]
    assert.deepEqual(pendingUserQuestions(messages), [...first, ...second])
    assert.deepEqual(pendingUserQuestions([...messages, withQuestionReply(messages[2]!, [{ id: first[0]!.id, answer: 'Linux' }])]), second)
  })
  it('整组答复保留同名题、跳过与多段正文，自由改写和再次编辑仍对应原题', () => {
    const all = [...first, ...second, ...questionsForBatch(batch('c'))]
    const answers = all.map((item, i) => ({ id: item.id, answer: i === 1 ? null : '第' + i + '个回答' }))
    const text = formatQuestionSubmission(all, answers)
    assert.ok(text)
    assert.deepEqual(editedQuestionSubmission(all, answers, text), answers)
    const changed = text.replace('第2个回答', '第一段\n\n第二段')
    assert.deepEqual(editedQuestionSubmission(all, answers, changed)?.map(item => item.answer), ['第0个回答', null, '第一段\n\n第二段'])
    const free = editedQuestionSubmission(all, answers, '改为做别的事')
    assert.deepEqual(free?.map(item => item.answer), [{ source: 'message' }, null, { source: 'message' }])
    assert.equal(questionReplySchema.safeParse(free).success, true)
    assert.equal(questionSubmissionSchema.safeParse(free).success, false)
    assert.deepEqual(editedQuestionSubmission(all, free, '我稍后再回答'), free)
    assert.deepEqual(editedQuestionSubmission(all, free, text), answers)
    assert.deepEqual(pendingUserQuestions([issued('a'), issued('b'), issued('c'), withQuestionReply({ role: 'user', content: '我稍后再回答' }, free!)]), [])
  })
  it('压缩保留未答题的身份，跳过不产生模型输入', () => {
    const source = [issued('a'), issued('b')]
    const unchanged = withoutConversationMetadata(source)
    const prefix = source[0]
    applyQuestionSkips(source, [first[0]!.id])
    assert.equal(source[0], prefix)
    assert.deepEqual(withoutConversationMetadata(source), unchanged)
    const rebuilt: ModelMessage[] = [{ role: 'user', content: '历史摘要' }]
    carryPendingQuestions(rebuilt, source)
    assert.deepEqual(pendingUserQuestions(rebuilt), second)
    applyQuestionSkips(rebuilt, [second[0]!.id])
    assert.deepEqual(pendingUserQuestions(rebuilt), [])
    assert.deepEqual(withoutConversationMetadata(rebuilt), [{ role: 'user', content: '历史摘要' }])
  })
})
