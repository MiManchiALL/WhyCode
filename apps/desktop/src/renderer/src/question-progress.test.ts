import assert from 'node:assert/strict'
import { it } from 'node:test'
import { questionsForBatch } from '@whycode/core/events'
import { reconcileQuestionDraft } from './question-progress.ts'

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
