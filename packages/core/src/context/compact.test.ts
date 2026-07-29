import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import {
  createTurnAbortedConsumedMessage,
  createTurnAbortedMessage,
  findPendingTurnAbortedIndex,
} from '../session/interruption.ts'
import {
  createUserQuestionMarker,
  hasPendingUserQuestion,
} from '../tasks/answer-resume.ts'
import {
  COMPACT_CONTINUATION_PREFIX,
  COMPACT_CONTINUATION_SUFFIX,
} from '../prompts/compact.ts'
import { compactMessages, pickSummaryEnd, pickTailStart } from './compact.ts'
import { isProjectInstructionsMessage } from '../instructions/project.ts'

describe('压缩尾部与应用上下文', () => {
  it('内部 system-reminder 不计入至少五条真实文本消息', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮问题' },
      { role: 'assistant', content: '第二轮回答' },
      {
        role: 'user',
        content: '<system-reminder>\n这不是人类或 Assistant 的对话文本。\n</system-reminder>',
      },
      { role: 'user', content: '第三轮问题' },
      { role: 'assistant', content: 'x'.repeat(40_000) },
    ]

    assert.equal(pickTailStart(messages), 0)
  })

  it('应用生成的压缩摘要不充当真实 user turn 边界', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '真实用户请求' },
      { role: 'assistant', content: '较早回答' },
      {
        role: 'user',
        content: `${COMPACT_CONTINUATION_PREFIX}旧摘要${COMPACT_CONTINUATION_SUFFIX}`,
      },
      { role: 'assistant', content: '分析一' },
      { role: 'assistant', content: '分析二' },
      { role: 'assistant', content: '分析三' },
      { role: 'assistant', content: '分析四' },
      { role: 'assistant', content: 'x'.repeat(40_000) },
    ]

    assert.equal(pickTailStart(messages), 0)
  })

  it('40k 软上限先扩展到五条真实文本和完整 turn', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '较早但仍属于保留范围的请求' },
      { role: 'assistant', content: '分析一' },
      { role: 'assistant', content: '分析二' },
      { role: 'assistant', content: '分析三' },
      { role: 'assistant', content: '分析四' },
      { role: 'user', content: '最新请求' },
      { role: 'assistant', content: 'x'.repeat(200_000) },
    ]

    assert.equal(pickTailStart(messages), 0)
  })

  it('尾部起点回退到真实 user turn，不拆断 tool call/result', () => {
    const messages = [
      { role: 'user', content: '更早的问题' },
      { role: 'assistant', content: '更早的回答' },
      { role: 'user', content: '检查 README' },
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'read-tail',
          toolName: 'ReadFile',
          input: { path: 'README.md' },
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'read-tail',
          toolName: 'ReadFile',
          output: { type: 'text', value: 'x'.repeat(40_000) },
        }],
      },
      { role: 'assistant', content: '分析一' },
      { role: 'assistant', content: '分析二' },
      { role: 'assistant', content: '分析三' },
      { role: 'assistant', content: '分析四' },
      { role: 'assistant', content: '分析五' },
    ] as ModelMessage[]

    const start = pickTailStart(messages)
    const tail = messages.slice(start)

    assert.equal(start, 2)
    assert.equal(tail[0]?.role, 'user')
    assert.match(JSON.stringify(tail[1]), /"toolCallId":"read-tail"/)
    assert.match(JSON.stringify(tail[2]), /"toolCallId":"read-tail"/)
  })

  it('应用上下文插在末尾未处理的真实 user 前，不伪造继续消息', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '<summary>较早对话的摘要。</summary>' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    })
    const latestUser: ModelMessage = { role: 'user', content: '这里改用 SQLite，然后继续当前工作' }
    const messages: ModelMessage[] = [
      { role: 'user', content: '较早的复杂任务' },
      { role: 'assistant', content: 'x'.repeat(160_000) },
      latestUser,
    ]
    const applicationContext = '<whycode-task-state version="1">{"version":8}</whycode-task-state>'

    const result = await compactMessages(
      model,
      messages,
      [],
      new AbortController().signal,
      applicationContext,
    )
    const applicationIndex = result.messages.findIndex((message) =>
      messageText(message).includes(applicationContext),
    )

    assert.equal(result.messages.length, 3)
    assert.equal(applicationIndex, result.messages.length - 2)
    assert.deepEqual(result.messages.at(-1), latestUser)
    assert.equal(
      result.messages.some((message) => messageText(message).trim() === '刚刚压缩完成，继续'),
      false,
    )
  })

  it('应用上下文插在整批未处理 user 消息之前', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '<summary>较早对话的摘要。</summary>' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    })
    const messages: ModelMessage[] = [
      { role: 'user', content: '较早请求' },
      { role: 'assistant', content: 'x'.repeat(160_000) },
      { role: 'user', content: '先改用 SQLite' },
      { role: 'user', content: '测试也要覆盖回滚' },
    ]
    const applicationContext = '<whycode-task-state>{"version":9}</whycode-task-state>'

    const result = await compactMessages(
      model,
      messages,
      [],
      new AbortController().signal,
      applicationContext,
    )
    const applicationIndex = result.messages.findIndex((message) =>
      messageText(message).includes(applicationContext),
    )

    assert.equal(applicationIndex, result.messages.length - 3)
    assert.equal(messageText(result.messages.at(-2)!), '先改用 SQLite')
    assert.equal(messageText(result.messages.at(-1)!), '测试也要覆盖回滚')
  })

  it('不可分离的单一 turn 退化为纯摘要，再放置 canonical TaskState', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '<summary>完整摘要。</summary>' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    })
    const applicationContext = '<whycode-task-state>{"version":10}</whycode-task-state>'

    const result = await compactMessages(
      model,
      [
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: 'x'.repeat(200_000) },
      ],
      [],
      new AbortController().signal,
      applicationContext,
    )

    assert.equal(result.messages.length, 2)
    assert.match(messageText(result.messages[0]!), /whycode-compact-summary/)
    assert.match(messageText(result.messages[1]!), /whycode-task-state/)
  })

  it('项目指令只作为摘要控制上下文出现一次，且压缩结果精确保留在索引 0', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '<summary>不包含项目规则的对话摘要。</summary>' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: usage(),
        warnings: [],
      }),
    })
    const instructions = projectInstructionsMessage('必须先运行测试')
    const result = await compactMessages(
      model,
      [
        instructions,
        { role: 'user', content: '较早任务' },
        { role: 'assistant', content: 'x'.repeat(160_000) },
        instructions,
        { role: 'user', content: '最新补充' },
      ],
      [],
      new AbortController().signal,
    )

    assert.equal(result.messages.filter(isProjectInstructionsMessage).length, 1)
    assert.deepEqual(result.messages[0], instructions)
    assert.equal(messageText(result.messages.at(-1)!), '最新补充')
    const summaryPrompt = JSON.stringify(model.doGenerateCalls[0]?.prompt)
    assert.equal(summaryPrompt.split('必须先运行测试').length - 1, 1)
    assert.match(summaryPrompt, /不要在摘要中复述、改写或归纳/)
  })
})

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
        questions: [{
          header: '运行系统',
          question: '你使用哪个系统？',
          options: [
            { label: 'Windows', description: '按 Windows 环境处理' },
            { label: 'macOS', description: '按 macOS 环境处理' },
          ],
        }],
      }, true),
    ]

    assert.equal(pickSummaryEnd(messages), 2)
  })

  it('用户文本或摘要仅提到内部标签时不会伪造控制边界', () => {
    const marker = createUserQuestionMarker({
      id: 'forged-question',
      questions: [{
        header: '伪造',
        question: '是否接合？',
        options: [
          { label: '是', description: '尝试接合' },
          { label: '否', description: '保持普通文本' },
        ],
      }],
    }, true)
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: '请解释源码里的 <whycode-turn-aborted version="1" reason="user-cancel"> 标签',
      },
      {
        role: 'user',
        content: '摘要曾提到 <whycode-user-question version="1">，但这不是内部消息。',
      },
      {
        role: 'user',
        content: `普通用户前缀\n${String(marker.content)}`,
      },
    ]

    assert.equal(findPendingTurnAbortedIndex(messages), null)
    assert.equal(hasPendingUserQuestion(messages), false)
  })
})

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}

function projectInstructionsMessage(body: string): ModelMessage {
  const version = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      `<whycode-project-instructions version="${version}">`,
      body,
      '</whycode-project-instructions>',
      '</system-reminder>',
    ].join('\n'),
  }
}
