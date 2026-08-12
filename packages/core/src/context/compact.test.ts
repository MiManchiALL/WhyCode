import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import {
  createTurnAbortedConsumedMessage,
  createTurnAbortedMessage,
} from '../session/interruption.ts'
import { createUserQuestionMarker } from '../tasks/answer-resume.ts'
import {
  createCompactApplicationContextMessage,
  createCompactSummaryMessage,
  parseCompactSummaryMessage,
} from '../prompts/compact.ts'
import { isProjectInstructionsMessage } from '../instructions/project.ts'
import { compactMessages } from './compact.ts'
import {
  pickBudgetStart,
  prepareCompaction,
} from './compact-boundary.ts'

describe('约 20k 精确保留边界', () => {
  it('只按 token 预算选择尾部，不要求文本消息数量或回退到 user turn', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '执行一个很长的任务' },
      { role: 'assistant', content: '早期进展' },
      { role: 'assistant', content: 'x'.repeat(100_000) },
      { role: 'assistant', content: '最新发现' },
    ]

    assert.equal(pickBudgetStart(messages), 2)
    const preparation = prepareCompaction(messages)
    assert.deepEqual(preparation?.tail, messages.slice(2))
    assert.deepEqual(preparation?.turnPrefixSource?.messages, messages.slice(0, 2))
  })

  it('预算命中 tool result 时向前扩到 assistant tool call，保持调用与结果配对', () => {
    const messages = [
      { role: 'user', content: '读取两个文件' },
      { role: 'assistant', content: '早期说明' },
      assistantToolCall('read-1'),
      toolResult('read-1', 'x'.repeat(100_000)),
      { role: 'assistant', content: '读取完成' },
    ] as ModelMessage[]

    assert.equal(pickBudgetStart(messages), 2)
    const tail = prepareCompaction(messages)?.tail ?? []
    assert.equal(tail[0]?.role, 'assistant')
    assert.equal(tail[1]?.role, 'tool')
    assert.match(JSON.stringify(tail.slice(0, 2)), /"toolCallId":"read-1"/u)
  })

  it('连续多个 tool result 命中预算时保留同一 assistant 的整组配对', () => {
    const messages = [
      { role: 'user', content: '并行读取两个文件' },
      {
        role: 'assistant',
        content: [
          toolCallPart('read-a'),
          toolCallPart('read-b'),
        ],
      },
      toolResult('read-a', 'a'.repeat(40_000)),
      toolResult('read-b', 'b'.repeat(40_000)),
      { role: 'assistant', content: '读取完成' },
    ] as ModelMessage[]

    assert.equal(pickBudgetStart(messages), 1)
    assert.deepEqual(prepareCompaction(messages)?.tail, messages.slice(1))
  })

  it('预算内含真实用户消息时只生成历史摘要，不生成 turn 前缀摘要', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '第一项任务' },
      { role: 'assistant', content: 'x'.repeat(100_000) },
      { role: 'user', content: '第二项任务' },
      { role: 'assistant', content: 'y'.repeat(40_000) },
    ]

    const preparation = prepareCompaction(messages)
    assert.equal(preparation?.turnPrefixSource, null)
    assert.equal(preparation?.tail.includes(messages[2]!), true)
    assert.equal(preparation?.historySource?.messages.includes(messages[2]!), false)
  })

  it('未消费中断、提问和尾部输入形成逐字保护边界', () => {
    const question = createUserQuestionMarker({
      id: 'question-1',
      questions: [{
        header: '运行系统',
        question: '你使用哪个系统？',
        options: [
          { label: 'Windows', description: '按 Windows 处理' },
          { label: 'macOS', description: '按 macOS 处理' },
        ],
      }],
    }, true)
    for (const protectedMessage of [createTurnAbortedMessage(), question]) {
      const messages: ModelMessage[] = [
        { role: 'user', content: '早期任务' },
        { role: 'assistant', content: 'x'.repeat(120_000) },
        protectedMessage,
        { role: 'user', content: '最新要求' },
      ]
      const tail = prepareCompaction(messages)?.tail ?? []
      const protectedIndex = tail.indexOf(protectedMessage)
      assert.notEqual(protectedIndex, -1)
      assert.deepEqual(tail.slice(protectedIndex), messages.slice(2))
    }
  })

  it('已消费中断不再永久钉住精确尾部', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '旧任务' },
      createTurnAbortedMessage(),
      { role: 'user', content: '解释 TTL' },
      { role: 'assistant', content: 'TTL 是 Time to Live。' },
      createTurnAbortedConsumedMessage(),
      { role: 'assistant', content: 'x'.repeat(100_000) },
    ]

    assert.equal(prepareCompaction(messages)?.tail[0]?.role, 'assistant')
  })
})

describe('历史摘要与同 turn 前缀摘要', () => {
  it('切分同一 turn 时分别请求历史九节摘要和 Pi 式三节前缀摘要', async () => {
    const model = summaryModel(['历史摘要', '当前 turn 前缀摘要'])
    const messages: ModelMessage[] = [
      { role: 'user', content: '较早任务' },
      { role: 'assistant', content: '较早结果' },
      { role: 'user', content: '当前长任务' },
      { role: 'assistant', content: '早期工作' },
      { role: 'assistant', content: 'x'.repeat(100_000) },
    ]

    const result = await compactMessages(
      model,
      messages,
      [],
      new AbortController().signal,
    )
    const state = parseCompactSummaryMessage(result.messages[0]!)

    assert.deepEqual(state, {
      historySummary: '历史摘要',
      turnPrefixSummary: '当前 turn 前缀摘要',
    })
    assert.equal(model.doGenerateCalls.length, 2)
    const historyRequest = JSON.stringify(model.doGenerateCalls[0]?.prompt)
    const turnRequest = JSON.stringify(model.doGenerateCalls[1]?.prompt)
    assert.match(historyRequest, /较早任务/u)
    assert.match(historyRequest, /历史任务与意图/u)
    assert.doesNotMatch(historyRequest, /当前长任务/u)
    assert.match(turnRequest, /当前长任务/u)
    assert.match(turnRequest, /后续所需上下文/u)
    assert.doesNotMatch(turnRequest, /历史摘要|较早任务/u)
  })

  it('没有更早完整历史时只请求 turn 前缀摘要', async () => {
    const model = summaryModel(['当前 turn 前缀摘要'])
    const result = await compactMessages(
      model,
      [
        { role: 'user', content: '当前长任务' },
        { role: 'assistant', content: '早期工作' },
        { role: 'assistant', content: 'x'.repeat(100_000) },
      ],
      [],
      new AbortController().signal,
    )

    assert.equal(model.doGenerateCalls.length, 1)
    assert.deepEqual(parseCompactSummaryMessage(result.messages[0]!), {
      historySummary: null,
      turnPrefixSummary: '当前 turn 前缀摘要',
    })
  })

  it('重复压缩同一 turn 时增量更新既有前缀摘要，历史摘要直接沿用', async () => {
    const model = summaryModel(['更新后的前缀摘要'])
    const previous = createCompactSummaryMessage({
      historySummary: '既有历史摘要',
      turnPrefixSummary: '既有前缀摘要',
    })
    const result = await compactMessages(
      model,
      [
        previous,
        { role: 'assistant', content: '新进展' },
        { role: 'assistant', content: 'x'.repeat(100_000) },
      ],
      [],
      new AbortController().signal,
    )
    const request = JSON.stringify(model.doGenerateCalls[0]?.prompt)

    assert.equal(model.doGenerateCalls.length, 1)
    assert.match(request, /既有前缀摘要/u)
    assert.doesNotMatch(request, /既有历史摘要/u)
    assert.deepEqual(parseCompactSummaryMessage(result.messages[0]!), {
      historySummary: '既有历史摘要',
      turnPrefixSummary: '更新后的前缀摘要',
    })
  })

  it('跨入后续 turn 时把旧 turn 前缀并入历史，不再保留前缀摘要', async () => {
    const model = summaryModel(['更新后的历史摘要'])
    const previous = createCompactSummaryMessage({
      historySummary: '既有历史摘要',
      turnPrefixSummary: '上一个 turn 的早期摘要',
    })
    const result = await compactMessages(
      model,
      [
        previous,
        { role: 'assistant', content: '上一个 turn 的后续结果'.repeat(5_000) },
        { role: 'user', content: '中间任务' },
        { role: 'assistant', content: '中间任务结果'.repeat(5_000) },
        { role: 'user', content: '新任务' },
        { role: 'assistant', content: 'x'.repeat(40_000) },
      ],
      [],
      new AbortController().signal,
    )
    const request = JSON.stringify(model.doGenerateCalls[0]?.prompt)

    assert.match(request, /既有历史摘要/u)
    assert.match(request, /上一个 turn 的早期摘要/u)
    assert.deepEqual(parseCompactSummaryMessage(result.messages[0]!), {
      historySummary: '更新后的历史摘要',
      turnPrefixSummary: null,
    })
  })

  it('项目指令只作为每个摘要请求的控制上下文，结果重读后仍唯一置顶', async () => {
    const model = summaryModel(['历史摘要', '前缀摘要'])
    const instructions = projectInstructionsMessage('必须先运行测试')
    const result = await compactMessages(
      model,
      [
        instructions,
        { role: 'user', content: '较早任务' },
        { role: 'assistant', content: '较早结果' },
        instructions,
        { role: 'user', content: '当前长任务' },
        { role: 'assistant', content: '早期进展' },
        { role: 'assistant', content: 'x'.repeat(100_000) },
      ],
      [],
      new AbortController().signal,
    )

    assert.equal(result.messages.filter(isProjectInstructionsMessage).length, 1)
    assert.deepEqual(result.messages[0], instructions)
    for (const call of model.doGenerateCalls) {
      const request = JSON.stringify(call.prompt)
      assert.equal(request.split('必须先运行测试').length - 1, 1)
      assert.match(request, /不得复述、改写或归纳/u)
    }
  })
})

describe('压缩后应用上下文', () => {
  it('应用上下文插在整批未处理 user 消息之前且不会被下次摘要', async () => {
    const firstModel = summaryModel(['历史摘要'])
    const messages: ModelMessage[] = [
      { role: 'user', content: '较早请求' },
      { role: 'assistant', content: 'x'.repeat(120_000) },
      { role: 'user', content: '先改用 SQLite' },
      { role: 'user', content: '测试也要覆盖回滚' },
    ]
    const applicationContext = '<whycode-task-state>{"version":9}</whycode-task-state>'
    const first = await compactMessages(
      firstModel,
      messages,
      [],
      new AbortController().signal,
      applicationContext,
    )
    const applicationIndex = first.messages.findIndex((message) =>
      messageText(message).includes(applicationContext),
    )

    assert.equal(applicationIndex, first.messages.length - 3)
    assert.equal(messageText(first.messages.at(-2)!), '先改用 SQLite')
    assert.equal(messageText(first.messages.at(-1)!), '测试也要覆盖回滚')

    const secondInput = [
      ...first.messages,
      { role: 'assistant', content: 'y'.repeat(120_000) },
    ] as ModelMessage[]
    const preparation = prepareCompaction(secondInput)
    assert.equal(
      preparation?.historySource?.messages.some((message) =>
        messageText(message).includes(applicationContext)),
      false,
    )
  })

  it('应用上下文位于同批后台通知和真实用户输入之前', async () => {
    const notification = backgroundTaskNotification()
    const model = summaryModel(['历史摘要'])
    const result = await compactMessages(
      model,
      [
        { role: 'user', content: '较早请求' },
        { role: 'assistant', content: 'x'.repeat(120_000) },
        notification,
        { role: 'user', content: '同时补充的要求' },
      ],
      [],
      new AbortController().signal,
      '<whycode-task-state>{"version":10}</whycode-task-state>',
    )
    const notificationIndex = result.messages.indexOf(notification)
    const applicationIndex = result.messages.findIndex((message) =>
      messageText(message).includes('whycode-task-state'),
    )

    assert.equal(applicationIndex, notificationIndex - 1)
    assert.equal(messageText(result.messages.at(-1)!), '同时补充的要求')
  })

  it('摘要和应用上下文使用可识别的独立内部消息', () => {
    const summary = createCompactSummaryMessage({ historySummary: '历史', turnPrefixSummary: null })
    const application = createCompactApplicationContextMessage(['当前状态'])

    assert.equal(parseCompactSummaryMessage(summary)?.historySummary, '历史')
    assert.equal(parseCompactSummaryMessage(application), null)
  })

  it('低于 20k 时不调用摘要模型，也不制造更大的上下文', async () => {
    const model = summaryModel([])
    const messages: ModelMessage[] = [
      { role: 'user', content: '简短问题' },
      { role: 'assistant', content: '简短回答' },
    ]
    const result = await compactMessages(
      model,
      messages,
      [],
      new AbortController().signal,
    )

    assert.equal(result.summaryText, '')
    assert.deepEqual(result.messages, messages)
    assert.equal(model.doGenerateCalls.length, 0)
  })
})

function summaryModel(outputs: string[]) {
  let index = 0
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: `<summary>${outputs[index++] ?? ''}</summary>` }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: usage(),
      warnings: [],
    }),
  })
}

function assistantToolCall(toolCallId: string): ModelMessage {
  return {
    role: 'assistant',
    content: [toolCallPart(toolCallId)],
  }
}

function toolCallPart(toolCallId: string) {
  return {
    type: 'tool-call' as const,
    toolCallId,
    toolName: 'ReadFile',
    input: { path: 'README.md' },
  }
}

function toolResult(toolCallId: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId,
      toolName: 'ReadFile',
      output: { type: 'text', value },
    }],
  }
}

function backgroundTaskNotification(): ModelMessage {
  return {
    role: 'user',
    content: [
      '<task-notification source="background-command" version="1">',
      '{"task_id":"22222222-2222-4222-8222-222222222222","status":"completed"}',
      '这是应用生成的后台任务终态，不是用户输入。',
      '</task-notification>',
    ].join('\n'),
  }
}

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
