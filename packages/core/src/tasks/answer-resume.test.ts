import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatUserQuestionAnswer, type UserQuestion } from '../events.ts'
import { isUserQuestionAnswer, type UserQuestionBinding } from './answer-resume.ts'

describe('问题批次答案绑定', () => {
  it('规范化多行问题标题，并要求批次中每题都有回答', () => {
    const question: UserQuestion = {
      id: 'question-batch',
      header: '范围',
      question: '第一题',
      options: options(),
      questions: [
        {
          header: '范围',
          question: '第一题\n包含补充说明',
          options: options(),
        },
        {
          header: '交付',
          question: '第二题',
          options: options(),
        },
      ],
    }
    const binding: UserQuestionBinding = {
      question,
      resumesTaskPlan: true,
    }
    const answer = formatUserQuestionAnswer(question, ['回答一\n补充', '回答二'])

    assert.match(answer, /^1\. 回答「第一题 包含补充说明」：回答一 补充$/m)
    assert.equal(isUserQuestionAnswer(binding, answer), true)
    assert.equal(isUserQuestionAnswer(binding, answer.split('\n')[0]!), false)
    assert.equal(isUserQuestionAnswer(binding, `${answer}\n额外请求`), false)
  })
})

function options() {
  return [
    { label: '甲', description: '选择甲' },
    { label: '乙', description: '选择乙' },
  ]
}
