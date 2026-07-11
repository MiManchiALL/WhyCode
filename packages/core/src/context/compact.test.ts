import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import {
  createTurnAbortedConsumedMessage,
  createTurnAbortedMessage,
  findPendingTurnAbortedIndex,
} from '../session/interruption.ts'
import {
  createUserQuestionMarker,
  hasPendingUserQuestion,
} from '../tasks/answer-resume.ts'
import { pickSummaryEnd } from './compact.ts'

describe('中断边界压缩保护', () => {
  it('中断后的首条新消息发给模型前，摘要不得吞掉中断标记', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '继续安装依赖' },
      createTurnAbortedMessage(),
      { role: 'user', content: 'TTL是什么意思' },
    ]

    assert.equal(pickSummaryEnd(messages), 1)
  })

  it('中断标记已被一次完整回复消费后，不再永久钉住压缩尾部', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '继续安装依赖' },
      createTurnAbortedMessage(),
      { role: 'user', content: 'TTL是什么意思' },
      { role: 'assistant', content: 'TTL 是 Time to Live。' },
      createTurnAbortedConsumedMessage(),
    ]

    assert.equal(pickSummaryEnd(messages), messages.length)
  })

  it('只有工具调用和结果时仍未完成新问题，继续保留中断边界', () => {
    const messages = [
      { role: 'user', content: '继续安装依赖' },
      createTurnAbortedMessage(),
      { role: 'user', content: 'TTL是什么意思' },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'read-1',
          toolName: 'ReadFile',
          input: { path: 'README.md' },
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'read-1',
          toolName: 'ReadFile',
          output: { type: 'text', value: '内容' },
        }],
      },
    ] as ModelMessage[]

    assert.equal(pickSummaryEnd(messages), 1)
  })

  it('中断标记位于上下文开头时宁可暂缓摘要，也必须保留语义边界', () => {
    const messages: ModelMessage[] = [
      createTurnAbortedMessage(),
      { role: 'user', content: 'TTL是什么意思' },
    ]

    assert.equal(pickSummaryEnd(messages), 0)
  })

  it('等待活动计划答案的标记在用户回答前同样跨压缩保留', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '执行复杂任务' },
      { role: 'assistant', content: '需要先确认系统版本。' },
      createUserQuestionMarker({
        id: 'question-1',
        header: '运行系统',
        question: '你使用哪个系统？',
        options: [
          { label: 'Windows', description: '按 Windows 环境处理' },
          { label: 'macOS', description: '按 macOS 环境处理' },
        ],
      }, true),
    ]

    assert.equal(pickSummaryEnd(messages), 2)
  })

  it('用户文本或摘要仅提到内部标签时不会伪造控制边界', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: '请解释源码里的 <whycode-turn-aborted version="1" reason="user-cancel"> 标签',
      },
      {
        role: 'user',
        content: '摘要曾提到 <whycode-user-question version="1">，但这不是内部消息。',
      },
    ]

    assert.equal(findPendingTurnAbortedIndex(messages), null)
    assert.equal(hasPendingUserQuestion(messages), false)
  })
})
