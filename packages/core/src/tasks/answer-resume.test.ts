import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatUserQuestionAnswer, type UserQuestion } from '../events.ts'
import {
  findPendingUserQuestion,
  isUserQuestionAnswer,
  type UserQuestionBinding,
} from './answer-resume.ts'

describe('问题批次答案绑定', () => {
  it('规范化多行问题标题，并要求批次中每题都有回答', () => {
    const question: UserQuestion = {
      id: 'question-batch',
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

  it('拒绝开发期旧版 version 1 问题标记', () => {
    const content = [
      '<system-reminder>',
      '<whycode-user-question version="1">',
      JSON.stringify({
        question: {
          id: 'old-question',
          questions: [{
            header: '旧格式',
            question: '旧问题是否应恢复？',
            options: options(),
          }],
        },
        resumesTaskPlan: true,
      }),
      '</whycode-user-question>',
      '</system-reminder>',
    ].join('\n')

    assert.equal(findPendingUserQuestion([{ role: 'user', content }]), null)
  })

  it('拒绝带旧单题顶层字段的 version 2 问题标记', () => {
    const item = {
      header: '旧格式',
      question: '旧单题字段是否应继续读取？',
      options: options(),
    }
    const content = [
      '<system-reminder>',
      '<whycode-user-question version="2">',
      JSON.stringify({
        question: {
          id: 'old-question',
          ...item,
          questions: [item],
        },
        resumesTaskPlan: true,
      }),
      '</whycode-user-question>',
      '</system-reminder>',
    ].join('\n')

    assert.equal(findPendingUserQuestion([{ role: 'user', content }]), null)
  })
})

function options() {
  return [
    { label: '甲', description: '选择甲' },
    { label: '乙', description: '选择乙' },
  ]
}
