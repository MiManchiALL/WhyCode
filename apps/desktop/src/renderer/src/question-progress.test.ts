import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  advanceQuestionProgress,
  previousQuestionIndex,
} from './question-progress.ts'

describe('问题卡逐题推进', () => {
  it('单题第一次推进即提交，空回答保持原位', () => {
    assert.equal(advanceQuestionProgress([''], 0, '   '), null)
    assert.deepEqual(advanceQuestionProgress([''], 0, ' 自由输入 '), {
      answers: ['自由输入'],
      nextIndex: 0,
      complete: true,
    })
  })

  it('六题只在最后一次推进时完成，并保留选项与自由输入', () => {
    let answers = Array<string>(6).fill('')
    for (let index = 0; index < 6; index++) {
      const advanced = advanceQuestionProgress(
        answers,
        index,
        index % 2 === 0 ? `选项 ${index + 1}` : `输入 ${index + 1}`,
      )
      assert.ok(advanced)
      assert.equal(advanced.complete, index === 5)
      assert.equal(advanced.nextIndex, Math.min(index + 1, 5))
      answers = advanced.answers
    }
    assert.deepEqual(answers, [
      '选项 1', '输入 2', '选项 3', '输入 4', '选项 5', '输入 6',
    ])
  })

  it('上一题不会越过第一题', () => {
    assert.equal(previousQuestionIndex(4), 3)
    assert.equal(previousQuestionIndex(0), 0)
  })
})
