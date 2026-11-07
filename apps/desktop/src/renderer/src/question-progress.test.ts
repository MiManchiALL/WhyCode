import assert from 'node:assert/strict'
import { it } from 'node:test'
import { questionsForBatch } from '@whycode/core/events'
import { questionSubmission, reconcileQuestionDraft } from './question-progress.ts'

it('追加同名题保留所选题和草稿，已提交的题释放', () => {
  const item = { header: '范围', question: '需要什么？' }
  const a = questionsForBatch({ id: 'a', questions: [item, item] })
  const b = questionsForBatch({ id: 'b', questions: [item, item] })
  const id = a[1]!.id
  const draft = { currentId: id, collapsed: true, answers: { [id]: '未发出的文字' } }
  assert.equal(reconcileQuestionDraft(draft, [...a, ...b]), draft)
  assert.deepEqual(reconcileQuestionDraft(draft, b), { currentId: undefined, collapsed: true, answers: {} })
  assert.equal(reconcileQuestionDraft(draft, []), undefined)
})

it('整组按题目顺序提交，自由输入去空格，显式跳过可提交，未答不可提交', () => {
  const questions = questionsForBatch({ id: '同组', questions: Array(3).fill({ header: '选择', question: '哪个？' }) })
  const [a, b, c] = questions.map(q => q.id) as [string, string, string]
  assert.equal(questionSubmission(questions, { [a]: '选项一', [b]: '  ' }), null)
  assert.deepEqual(questionSubmission(questions, { [b]: null, [a]: ' 选项一 ', [c]: '末题' }), [
    { id: a, answer: '选项一' }, { id: b, answer: null }, { id: c, answer: '末题' },
  ])
})
