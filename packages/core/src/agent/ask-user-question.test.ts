import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, type SessionJournal } from '../session/store.ts'
import { localWorkspace } from '../workspace/types.ts'
import { formatQuestionSubmission } from '../user-questions.ts'
import { userTurn } from '../context/user-turn.ts'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
} from '../tools/ask-user-question/index.ts'
import { buildTool, validateToolInput, type ToolDefinition } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('Main 主动提问', () => {
  it('指引说明自由输入、异步送达和独立工作', () => {
    const tool = createAskUserQuestionTool(() => {})
    assert.match(tool.description, /一个或多个简短问题/)
    assert.match(tool.prompt, /自动提供自由输入，无需添加“其它”/)
    assert.match(tool.prompt, /不依赖回答/)
    assert.equal(tool.endsTurnOnSuccess, false)
  })

  it('工具参数接受 1~6 问并拒绝空批次或第 7 问', async () => {
    const tool = createAskUserQuestionTool(() => {})
    const item = {
      header: '范围',
      question: '需要确认什么？',
      options: [
        { label: '甲', description: '选择甲' },
        { label: '乙', description: '选择乙' },
      ],
    }

    assert.equal((await validateToolInput(tool, { questions: [item] })).success, true)
    assert.equal((await validateToolInput(tool, { questions: Array(6).fill(item) })).success, true)
    assert.equal((await validateToolInput(tool, item)).success, false)
    assert.equal((await validateToolInput(tool, { ...item, questions: [item] })).success, false)
    assert.equal((await validateToolInput(tool, { questions: [] })).success, false)
    assert.equal((await validateToolInput(tool, { questions: Array(7).fill(item) })).success, false)
    assert.equal(z.toJSONSchema(tool.inputSchema).type, 'object')
  })

  it('同一步的两次提问立即返回，空闲回答开启独立回合并只消费选中题目', async () => {
    const model = new MockLanguageModelV4({ doStream: [questionStep(), finalStep('等你确认。'), finalStep('收到。')] })
    const events: CoreEvent[] = []
    const session = createSession(model, events)
    assert.equal(await session.handleUserMessage('帮我选一个实现方向'), 'waiting-user')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(session.pendingQuestions.length, 3)
    const [first, second, third] = session.pendingQuestions
    await session.skipUserQuestions([second!.id])
    await session.handleUserMessage('回答「你更看重哪一点？」：简单可靠', false, [], undefined, [], [], 'native',
      [{ id: first!.id, answer: '简单可靠' }])
    assert.deepEqual(session.pendingQuestions.map(item => item.id), [third!.id])
    assert.equal(events.filter(event => event.type === 'turn-start').length, 2)
    assert.equal(model.doStreamCalls.length, 3)
  })

  it('耗时工具执行期间的回答不打断工具，下一次模型请求在原回合收到答案', { timeout: 10_000 }, async () => {
    let entered!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>(resolve => { entered = resolve })
    let release!: () => void
    const reading = new Promise<void>(resolve => { release = resolve })
    const gate = buildTool({
      name: 'ReadFixture', description: '读取资料', prompt: '读取资料', inputSchema: z.strictObject({}), isReadOnly: true, kind: 'read',
      async execute(_, context) { entered(context.abortSignal); await reading; return { data: '资料已就绪', isError: false } },
    })
    const model = new MockLanguageModelV4({ doStream: [questionStep(true), finalStep('收到插话答案。')] })
    const events: CoreEvent[] = []
    const session = createSession(model, events, [gate])
    const work = session.handleUserMessage('开始任务')
    const signal = await Promise.race([started, Promise.resolve(work).then(() => { throw new Error('读取工具没有启动') })])
    try {
      const [question, ...skipped] = session.pendingQuestions
      assert.ok(question)
      const roles = session.captureMessageSnapshot().map(message => message.role)
      await session.skipUserQuestions(skipped.map(item => item.id))
      assert.deepEqual(session.captureMessageSnapshot().map(message => message.role), roles)
      assert.equal(question.toolUseId, 'ask-1')
      session.handleUserMessage('回答「你更看重哪一点？」：可靠', false, [], undefined, [], [], 'native',
        [{ id: question.id, answer: '可靠' }])
      assert.equal(signal.aborted, false)
      assert.equal(model.doStreamCalls.length, 1)
    } finally { release() }
    await work
    assert.equal(events.filter(event => event.type === 'turn-start').length, 1)
    assert.equal(model.doStreamCalls.length, 2)
    const prompt = model.doStreamCalls[1]!.prompt
    assert.ok(prompt.some(msg => msg.role === 'user' && JSON.stringify(msg.content).includes('：可靠')))
    assert.ok(prompt.some(msg => msg.role === 'tool' && JSON.stringify(msg.content).includes('资料已就绪')))
    const turns = session.captureMessageSnapshot().map(userTurn).filter(Boolean)
    assert.deepEqual(turns.map(turn => turn!.startsTurn), [true, false])
    assert.equal(turns[0]!.id, turns[1]!.id)
    assert.equal(events.filter(event => event.type === 'tool-end' && !event.isError).length, 3)
    assert.ok(model.doStreamCalls[0]!.tools?.some(tool => tool.type === 'function'
      && tool.name === ASK_USER_QUESTION_TOOL_NAME && tool.description?.includes('一个或多个简短问题')))
  })

  for (const outcome of ['aborted', 'error'] as const) {
    it(`已排队的一组答案在 ${outcome} 时记入原回合，重启可见且编辑根会同时撤回插话`, { timeout: 15_000 }, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'whycode-question-delivery-'))
      t.after(() => rm(dir, { recursive: true, force: true }))
      const store = new SessionStore(dir)
      const journal = await store.create({ modelId: 'test:ask-user', workspace: localWorkspace(null) })
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      let requests = 0
      const model = new MockLanguageModelV4({ doStream: async () => {
        requests++
        if (requests === 1) return questionStep()
        if (requests > 2) return finalStep('重新处理。')
        entered()
        await gate
        if (outcome === 'error') throw new Error('invalid synthetic model request')
        return finalStep('原回合')
      } })
      const events: CoreEvent[] = []
      const session = createSession(model, events, undefined, journal)
      const rootId = crypto.randomUUID()
      await journal.recordUserInputWithId(rootId, '旧根请求', true)
      const work = session.handleUserMessage('旧根请求', false, [], rootId)
      await Promise.race([ready, Promise.resolve(work).then(() => { throw new Error('没有进入下一次模型请求') })])
      const turn = events.find(event => event.type === 'turn-start')!
      assert.ok(turn.type === 'turn-start')
      await journal.recordViewEvents([{ type: 'core-event', event: turn }])
      const pending = session.pendingQuestions
      assert.equal(journal.metadataSnapshot.hasPendingQuestions, true)
      const replies = pending.map((item, i) => ({ id: item.id, answer: i === 1 ? null : '选项' + i }))
      const text = formatQuestionSubmission(pending, replies)
      assert.ok(text)
      const inputId = crypto.randomUUID()
      try {
        await journal.recordUserInputWithId(inputId, text, false, [], [], [], [], undefined, replies, session.questionAnswerTurnId)
        session.handleUserMessage(text, false, [], inputId, [], [], 'native', replies)
        assert.ok(events.some(event => event.type === 'message-queued' && event.id === inputId && event.answerTurnId === turn.turnId))
        assert.equal(journal.pendingUserInputs.find(item => item.id === inputId)?.answerTurnId, turn.turnId)
        assert.equal(journal.metadataSnapshot.hasPendingQuestions, false)
        if (outcome === 'aborted') session.abort()
      } finally { release() }
      assert.equal(await work, outcome)
      assert.equal(model.doStreamCalls.length, 2)
      assert.equal(journal.pendingUserInputs.length, 0)
      assert.equal(session.availableQuestions.length, 0)
      assert.deepEqual(session.captureMessageSnapshot().map(userTurn).filter(Boolean).map(turn => turn!.startsTurn), [true, false])
      assert.ok(events.some(event => event.type === 'message-injected' && event.id === inputId))
      const reopened = await store.open(journal.sessionId)
      assert.ok(reopened.initialViewEvents.some(event => event.type === 'user-message' && !event.startsTurn && event.text === text))
      const edit = await session.prepareLatestTurnEdit(turn.turnId, '改写根请求')
      edit.accept()
      await edit.startMain()
      const edited = await store.open(journal.sessionId)
      assert.ok(!JSON.stringify(edited.initialMessages).includes('选项0'))
      assert.ok(!JSON.stringify(edited.initialMessages).includes('旧根请求'))
      assert.deepEqual(edited.initialMessages.map(userTurn).filter(Boolean).map(turn => turn!.startsTurn), [true])
    })
  }

  for (const skippedLater of [false, true]) {
    it('整组答复自由改写后可连续编辑，重启保留用户已处理的问题（随后全部跳过：' + skippedLater + '）', async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'whycode-question-edit-'))
      t.after(() => rm(dir, { recursive: true, force: true }))
      const store = new SessionStore(dir)
      let journal = await store.create({ modelId: 'test:ask-user', workspace: localWorkspace(null) })
      const model = new MockLanguageModelV4({ doStream: [questionStep(), finalStep(), finalStep(), finalStep(), finalStep()] })
      const events: CoreEvent[] = []
      let session = createSession(model, events, undefined, journal)
      const sendRoot = async (text: string, replies?: Parameters<typeof session.handleUserMessage>[7]) => {
        const id = crypto.randomUUID()
        await journal.recordUserInputWithId(id, text, true, [], [], [], [], undefined, replies)
        return session.handleUserMessage(text, false, [], id, [], [], 'native', replies)
      }
      const recordStart = async () => {
        const start = events.findLast(event => event.type === 'turn-start')!
        await journal.recordViewEvents([{ type: 'core-event', event: start }])
        return start.turnId
      }
      assert.equal(await sendRoot('请提问'), 'waiting-user')
      await recordStart()
      const questions = session.pendingQuestions
      const ids = questions.map(item => item.id)
      const answers = ids.map((id, index) => ({ id, answer: index === 1 ? null : '选项' + index }))
      const text = formatQuestionSubmission(questions, answers)!
      if (skippedLater) {
        assert.equal(await sendRoot('稍后再答'), 'waiting-user')
      } else {
        assert.equal(await sendRoot(text, answers), 'completed')
      }
      let latest = await recordStart()
      if (skippedLater) await session.skipUserQuestions(ids)
      for (const userText of ['好的，我等一下再回答你', '我刚刚都说了什么呢']) {
        journal = await store.open(journal.sessionId)
        assert.ok(journal.messagesBeforeTurn(latest))
        session = createSession(model, events, undefined, journal)
        const edit = await session.prepareLatestTurnEdit(latest, userText)
        edit.accept()
        assert.equal(await edit.startMain(), 'completed')
        latest = await recordStart()
        assert.deepEqual(session.pendingQuestions, [])
        assert.equal(journal.metadataSnapshot.hasPendingQuestions, false)
        const prompt = model.doStreamCalls.at(-1)!.prompt
        assert.equal(prompt.filter(msg => msg.role === 'user' && JSON.stringify(msg.content).includes(userText)).length, 1)
        assert.ok(!JSON.stringify(prompt).includes('选项0'))
      }
      const reopened = await store.open(journal.sessionId)
      assert.deepEqual(createSession(model, [], undefined, reopened).pendingQuestions, [])
      assert.ok(reopened.messagesBeforeTurn(latest))
    })
  }

  it('讨论 Agent 不获得主动提问工具', async () => {
    const model = new MockLanguageModelV4({ doStream: [finalStep()] })
    const session = createSession(model, [])
    session.setDiscussion({ agentId: 'B', scratchDir: 'C:\\whycode-scratch' })

    await session.handleUserMessage('独立评审')

    const names = (model.doStreamCalls[0]?.tools ?? []).map((tool) =>
      tool.type === 'function' ? tool.name : '',
    )
    assert.equal(names.includes(ASK_USER_QUESTION_TOOL_NAME), false)
  })

  it('任务已完成后的普通文本追问不会产生问题卡或等待状态', async () => {
    const model = new MockLanguageModelV4({
      doStream: [finalStep('修改和验证已经完成；如果之后想继续优化缓存，可以再告诉我。')],
    })
    const events: CoreEvent[] = []
    const session = createSession(model, events)

    const stopReason = await session.handleUserMessage('完成当前修改')

    assert.equal(stopReason, 'completed')
    assert.equal(events.some((event) => event.type === 'user-question'), false)
    assert.equal(
      events.some(
        (event) => event.type === 'text-delta' && event.text.includes('之后想继续优化'),
      ),
      true,
    )
  })
})

function createSession(model: MockLanguageModelV4, events: CoreEvent[], baseTools?: ToolDefinition[], sessionRecorder?: SessionJournal): AgentSession {
  return new AgentSession({
    model: modelEntry(model), baseTools, sessionRecorder,
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    emit: (event) => events.push(event),
    requestApproval: async () => ({ approved: false }),
  })
}

function questionStep(read = false) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'ask-1',
          toolName: ASK_USER_QUESTION_TOOL_NAME,
          input: JSON.stringify({
            questions: [
              {
                header: '实现偏好',
                question: '你更看重哪一点？',
                options: [
                  { label: '简单可靠', description: '优先减少复杂度' },
                  { label: '功能完整', description: '接受更高实现成本' },
                ],
              },
              {
                header: '交付方式',
                question: '你希望怎样交付？',
                options: [
                  { label: '一次完成', description: '完成后统一交付' },
                  { label: '逐步确认', description: '分阶段查看结果' },
                ],
              },
            ],
          }),
        },
        {
          type: 'tool-call' as const,
          toolCallId: 'ask-2',
          toolName: ASK_USER_QUESTION_TOOL_NAME,
          input: JSON.stringify({
            questions: [{
              header: '验证范围',
              question: '在哪个环境验证？',
              options: [
                { label: '本地', description: '使用开发环境' },
                { label: '预发布', description: '使用预发布环境' },
              ],
            }],
          }),
        },
        ...(read ? [{ type: 'tool-call' as const, toolCallId: 'read', toolName: 'ReadFixture', input: '{}' }] : []),
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function finalStep(text = '评审完成') {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: text },
        { type: 'text-end' as const, id: 'final' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:ask-user',
    displayName: 'Ask User Mock',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
  }
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
