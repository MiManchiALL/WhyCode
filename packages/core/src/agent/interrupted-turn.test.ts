import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { isTurnAbortedMessage } from '../session/interruption.ts'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/ask-user-question/index.ts'
import {
  createUserQuestionMarker,
  findPendingUserQuestion,
  hasPendingUserQuestion,
} from '../tasks/answer-resume.ts'
import {
  CLOSE_TASK_PLAN_TOOL_NAME,
  CREATE_TASK_PLAN_TOOL_NAME,
  UPDATE_TASK_ITEM_TOOL_NAME,
} from '../tasks/tools.ts'
import { activeTaskPlanSchema, type ActiveTaskPlan } from '../tasks/types.ts'
import { AgentSession } from './session.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('用户中断后的新回合', () => {
  it('持久化模型可见中断边界，普通问题不能继续或改写旧计划', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:interruption' })
    await seedActivePlan(journal)

    let firstRequest = true
    const remainingSteps = [
      finalStep('TTL 是 Time to Live。'),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'completed',
        evidence: ['恢复后完成'],
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: '测试结束',
      }),
      finalStep('已按要求恢复。'),
    ]
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRequest) {
          firstRequest = false
          return abortableStep(options.abortSignal)
        }
        const step = remainingSteps.shift()
        if (!step) throw new Error('没有配置更多模型步骤')
        return step
      },
    })
    const session = createSession(model, journal)

    const interrupted = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 1)
    session.abort()
    assert.equal(await interrupted, 'aborted')

    const reopenedAfterAbort = await store.open(journal.sessionId)
    assert.ok(reopenedAfterAbort.initialMessages.some(isTurnAbortedMessage))
    const resumedSession = createSession(model, reopenedAfterAbort)
    const answered = await resumedSession.handleUserMessage('TTL是什么意思')

    assert.equal(answered, 'completed')
    assert.equal(resumedSession.captureTaskPlanSnapshot()?.revision, 3)
    const secondRequest = model.doStreamCalls[1]
    const serialized = JSON.stringify(secondRequest?.prompt)
    const requestMarkerIndex = serialized.indexOf('whycode-turn-aborted')
    const requestTtlIndex = serialized.indexOf('TTL是什么意思')
    assert.ok(requestMarkerIndex >= 0 && requestMarkerIndex < requestTtlIndex)
    assert.equal(toolNames(secondRequest).includes(UPDATE_TASK_ITEM_TOOL_NAME), false)
    assert.equal(toolNames(secondRequest).includes(CLOSE_TASK_PLAN_TOOL_NAME), false)

    const reopened = await store.open(journal.sessionId)
    const markerIndex = reopened.initialMessages.findIndex(isTurnAbortedMessage)
    const ttlIndex = reopened.initialMessages.findIndex((message) =>
      message.role === 'user' && JSON.stringify(message.content).includes('TTL是什么意思'))
    assert.ok(markerIndex >= 0 && markerIndex < ttlIndex)
    assert.equal(reopened.initialViewEvents.length, 0)

    const resumed = await resumedSession.handleUserMessage('继续刚才的任务')

    assert.equal(resumed, 'completed')
    assert.equal(toolNames(model.doStreamCalls[2]).includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
  })

  it('中止开发后询问游戏热度时，隔离旧执行链并移除本地执行工具', async () => {
    let firstRequest = true
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRequest) {
          firstRequest = false
          return abortableStep(options.abortSignal)
        }
        return finalStep('《蔚蓝》目前仍有稳定的活跃玩家。')
      },
    })
    const session = createMemorySession(model, 'E:\\Test')
    session.restoreTaskPlanSnapshot(activePlan())

    const interrupted = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 1)
    session.abort()
    assert.equal(await interrupted, 'aborted')

    const result = await session.handleUserMessage('这个游戏目前玩的人多吗')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    const request = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(request, /whycode-turn-aborted/)
    assert.match(request, /这个游戏目前玩的人多吗/)
    assert.match(request, /旧任务主题：完成旧任务/)
    assert.doesNotMatch(request, /继续刚才的任务|实现功能|验证功能|实现完成|测试通过/)
    const names = toolNames(model.doStreamCalls[1])
    assert.equal(names.includes('ReadFile'), false)
    assert.equal(names.includes('RunCommand'), false)
    assert.equal(names.includes(UPDATE_TASK_ITEM_TOOL_NAME), false)
    assert.equal(names.includes(CLOSE_TASK_PLAN_TOOL_NAME), false)
    assert.deepEqual(session.captureTaskPlanSnapshot(), activePlan())
  })

  it('重启后主动提问的回答仍能重新接合活动计划', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:interruption' })
    await seedActivePlan(journal, 'waiting-user')
    const reopened = await store.open(journal.sessionId)
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
          outcome: 'abandoned',
          summary: '用户回答已收到，测试结束',
        }),
        finalStep('收到，按 Windows 11 处理。'),
      ],
    })
    const session = createSession(model, reopened)

    const result = await session.handleUserMessage('回答「你使用哪个系统？」：Windows 11')

    assert.equal(result, 'completed')
    assert.equal(toolNames(model.doStreamCalls[0]).includes(CLOSE_TASK_PLAN_TOOL_NAME), true)
  })

  it('活动计划问题卡未回答时，普通输入不会被误当成答案并强制续跑', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:interruption' })
    await seedActivePlan(journal, 'waiting-user')
    const reopened = await store.open(journal.sessionId)
    const model = new MockLanguageModelV4({
      doStream: [finalStep('TTL 是 Time to Live。')],
    })
    const session = createSession(model, reopened)

    const result = await session.handleUserMessage('TTL是什么意思')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assert.deepEqual(session.captureTaskPlanSnapshot(), activePlan())
  })

  it('问题卡与计划回答绑定在同一稳定 step 落盘，提交窗口停止不拆散状态', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:interruption' })
    await seedActivePlan(journal)
    const stepPersisted = createDeferred<void>()
    const releaseStep = createDeferred<void>()
    const originalRecordStep = journal.recordStep.bind(journal)
    journal.recordStep = async (...args) => {
      await originalRecordStep(...args)
      stepPersisted.resolve()
      await releaseStep.promise
    }
    const model = new MockLanguageModelV4({ doStream: [questionStep()] })
    const session = createSession(model, journal)

    const running = session.handleUserMessage('继续刚才的任务')
    await stepPersisted.promise
    const crashView = await store.open(journal.sessionId)
    assert.equal(hasPendingUserQuestion([...crashView.initialMessages]), true)
    assert.equal(
      crashView.initialViewEvents.some((entry) =>
        entry.type === 'core-event' && entry.event.type === 'user-question'),
      true,
    )

    session.abort()
    releaseStep.resolve()
    assert.equal(await running, 'waiting-user')
    const reopened = await store.open(journal.sessionId)
    assert.equal(hasPendingUserQuestion([...reopened.initialMessages]), true)
    assert.equal(reopened.initialMessages.some(isTurnAbortedMessage), false)
  })

  it('没有活动计划的问题卡也会完整落盘，并在重启后恢复等待状态', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:interruption' })
    const events: CoreEvent[] = []
    const model = new MockLanguageModelV4({ doStream: [questionStep()] })
    const session = createSession(model, journal, (event) => events.push(event))

    assert.equal(await session.handleUserMessage('帮我选择一份礼物'), 'waiting-user')

    const binding = findPendingUserQuestion(session.captureMessageSnapshot())
    assert.equal(binding?.resumesTaskPlan, false)
    assert.equal(binding?.question.question, '预算大约是多少？')
    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.metadataSnapshot.status, 'waiting-user')
    assert.equal(findPendingUserQuestion([...reopened.initialMessages])?.resumesTaskPlan, false)
    const restoredQuestions = reopened.initialViewEvents.filter((entry) =>
      entry.type === 'core-event' && entry.event.type === 'user-question')
    assert.equal(restoredQuestions.length, 1)
    assert.equal(
      restoredQuestions[0]?.type === 'core-event'
      && restoredQuestions[0].event.type === 'user-question'
        ? restoredQuestions[0].event.question.question
        : '',
      '预算大约是多少？',
    )
    assert.equal(events.filter((event) => event.type === 'user-question').length, 1)
  })

  it('问题工具执行后若 step 尚未稳定提交就被停止，不显示或恢复幽灵问题卡', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:interruption' })
    const events: CoreEvent[] = []
    const model = new MockLanguageModelV4({ doStream: [questionStep()] })
    let session!: AgentSession
    session = createSession(model, journal, (event) => {
      events.push(event)
      // 工具已经执行、但 provider response 尚未提交时同步停止，覆盖最窄竞态窗口。
      if (event.type === 'tool-end') session.abort()
    })

    assert.equal(await session.handleUserMessage('帮我选择一份礼物'), 'aborted')
    assert.equal(events.some((event) => event.type === 'tool-end'), true)
    assert.equal(hasPendingUserQuestion(session.captureMessageSnapshot()), false)
    assert.equal(events.some((event) => event.type === 'user-question'), false)
    const reopened = await store.open(journal.sessionId)
    assert.equal(hasPendingUserQuestion([...reopened.initialMessages]), false)
    assert.equal(
      reopened.initialViewEvents.some((entry) =>
        entry.type === 'core-event' && entry.event.type === 'user-question'),
      false,
    )
  })

  it('完整文本 step 的持久化窗口停止不会把已交付回答改判为中断', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:interruption' })
    const stepPersisted = createDeferred<void>()
    const releaseStep = createDeferred<void>()
    const originalRecordStep = journal.recordStep.bind(journal)
    journal.recordStep = async (...args) => {
      await originalRecordStep(...args)
      stepPersisted.resolve()
      await releaseStep.promise
    }
    const model = new MockLanguageModelV4({ doStream: [finalStep('TTL 是 Time to Live。')] })
    const events: CoreEvent[] = []
    const session = createSession(model, journal, (event) => events.push(event))

    const running = session.handleUserMessage('TTL是什么意思')
    await stepPersisted.promise
    session.handleUserMessage('下一条消息先不要执行')
    session.abort()
    releaseStep.resolve()

    assert.equal(await running, 'completed')
    assert.equal(session.captureMessageSnapshot().some(isTurnAbortedMessage), false)
    assert.equal(model.doStreamCalls.length, 1)
    assert.equal(
      events.some((event) =>
        event.type === 'queue-restored' && event.text === '下一条消息先不要执行'),
      true,
    )
  })

  it('手动压缩期间收到的首条消息会在压缩后作为新 turn 接续', async () => {
    const generateStarted = createDeferred<void>()
    const releaseGenerate = createDeferred<void>()
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        generateStarted.resolve()
        await releaseGenerate.promise
        return {
          content: [{ type: 'text' as const, text: '<summary>此前完成了一次简短问答。</summary>' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
      doStream: [finalStep('第一轮完成。'), finalStep('压缩后的新问题已回答。')],
    })
    const events: CoreEvent[] = []
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: null, osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: false }),
    })
    assert.equal(await session.handleUserMessage('先完成一次问答'), 'completed')

    const compacting = session.compactNow()
    await generateStarted.promise
    assert.equal(session.isBusy, true)
    assert.equal(session.handleUserMessage('压缩期间的新问题'), undefined)
    let idleResolved = false
    void session.waitUntilIdle().then(() => { idleResolved = true })
    await Promise.resolve()
    assert.equal(idleResolved, false)

    releaseGenerate.resolve()
    await compacting

    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(
      events.some((event) =>
        event.type === 'message-injected'
        && event.text === '压缩期间的新问题'
        && event.startsTurn === true),
      true,
    )
    assert.equal(session.isBusy, false)
    assert.equal(idleResolved, true)
  })

  it('被中止任务尚未创建计划时，下一条普通问题同样不能新建旧任务计划', async () => {
    let firstRequest = true
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRequest) {
          firstRequest = false
          return abortableStep(options.abortSignal)
        }
        return finalStep('TTL 是 Time to Live。')
      },
    })
    const session = createMemorySession(model)

    const interrupted = session.handleUserMessage('制作一个复杂游戏')
    await waitFor(() => model.doStreamCalls.length === 1)
    session.abort()
    assert.equal(await interrupted, 'aborted')

    const result = await session.handleUserMessage('TTL是什么意思')

    assert.equal(result, 'completed')
    assert.equal(toolNames(model.doStreamCalls[1]).includes(CREATE_TASK_PLAN_TOOL_NAME), false)
  })

  it('协商执行包也不能在首次中断后问题中重新创建旧任务计划', async () => {
    let firstRequest = true
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRequest) {
          firstRequest = false
          return abortableStep(options.abortSignal)
        }
        return finalStep('TTL 是 Time to Live。')
      },
    })
    const session = createMemorySession(model)

    const interrupted = session.handleUserMessage('制作一个复杂游戏')
    await waitFor(() => model.doStreamCalls.length === 1)
    session.abort()
    assert.equal(await interrupted, 'aborted')

    const result = await session.handleExecutionMessage(
      '[main_only 执行包] 用户当前只问：TTL 是什么意思。',
      false,
    )

    assert.equal(result, 'completed')
    assert.equal(toolNames(model.doStreamCalls[1]).includes(CREATE_TASK_PLAN_TOOL_NAME), false)
  })

  it('中止后简短确认立即开工时，重新开放计划创建能力', async () => {
    let firstRequest = true
    let resumedRequests = 0
    const remainingSteps = [
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '完成恢复后的任务',
        items: [
          { kind: 'work', title: '执行工作', acceptance: '工作完成' },
          { kind: 'verification', title: '验证结果', acceptance: '验证通过' },
        ],
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: '测试结束',
      }),
      finalStep('已经开始处理。'),
    ]
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRequest) {
          firstRequest = false
          return abortableStep(options.abortSignal)
        }
        resumedRequests++
        if (resumedRequests === 2) {
          assert.match(JSON.stringify(options.prompt), /whycode-turn-aborted-consumed/)
        }
        const step = remainingSteps.shift()
        if (!step) throw new Error('没有配置更多模型步骤')
        return step
      },
    })
    const session = createMemorySession(model)

    const interrupted = session.handleUserMessage('制作一个复杂游戏')
    await waitFor(() => model.doStreamCalls.length === 1)
    session.abort()
    assert.equal(await interrupted, 'aborted')

    const result = await session.handleUserMessage('可以，开始做吧')

    assert.equal(result, 'completed')
    assert.equal(toolNames(model.doStreamCalls[1]).includes(CREATE_TASK_PLAN_TOOL_NAME), true)
  })

  it('已有计划中止后简短确认开工，会重新接合未完成保护', async () => {
    let firstRequest = true
    const remainingSteps = [
      finalStep('过早结束一'),
      finalStep('过早结束二'),
      finalStep('过早结束三'),
    ]
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRequest) {
          firstRequest = false
          return abortableStep(options.abortSignal)
        }
        const step = remainingSteps.shift()
        if (!step) throw new Error('没有配置更多模型步骤')
        return step
      },
    })
    const session = createMemorySession(model)
    session.restoreTaskPlanSnapshot(activePlan())

    const interrupted = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 1)
    session.abort()
    assert.equal(await interrupted, 'aborted')

    const result = await session.handleUserMessage('可以，开始做吧')

    assert.equal(result, 'paused')
    assert.equal(model.doStreamCalls.length, 4)
  })

  it('运行中 urgent steering 仍属于当前回合，不生成停止边界或休眠计划', async () => {
    let firstRequest = true
    const remainingSteps = [
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: 'urgent steering 测试结束',
      }),
      finalStep('先回答 TTL，再按新要求结束。'),
    ]
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRequest) {
          firstRequest = false
          return abortableStep(options.abortSignal)
        }
        const step = remainingSteps.shift()
        if (!step) throw new Error('没有配置更多模型步骤')
        return step
      },
    })
    const session = createMemorySession(model)
    session.restoreTaskPlanSnapshot(activePlan())

    const running = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 1)
    session.handleUserMessage('TTL是什么意思', true)
    const result = await running

    assert.equal(result, 'completed')
    const secondRequest = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(secondRequest, /TTL是什么意思/)
    assert.doesNotMatch(secondRequest, /whycode-turn-aborted/)
    assert.equal(toolNames(model.doStreamCalls[1]).includes(CLOSE_TASK_PLAN_TOOL_NAME), true)
    assert.equal(session.captureMessageSnapshot().some(isTurnAbortedMessage), false)
  })

  it('终止型问题工具完成稳定回合后会消费中断边界', async () => {
    let firstRequest = true
    const remainingSteps = [questionStep(), finalStep('已开始新的任务。')]
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRequest) {
          firstRequest = false
          return abortableStep(options.abortSignal)
        }
        const step = remainingSteps.shift()
        if (!step) throw new Error('没有配置更多模型步骤')
        return step
      },
    })
    const session = createMemorySession(model)

    const interrupted = session.handleUserMessage('制作一个复杂游戏')
    await waitFor(() => model.doStreamCalls.length === 1)
    session.abort()
    assert.equal(await interrupted, 'aborted')
    assert.equal(await session.handleUserMessage('帮我选择一个礼物'), 'waiting-user')

    const result = await session.handleUserMessage('制作另一个复杂游戏')

    assert.equal(result, 'completed')
    assert.equal(toolNames(model.doStreamCalls[2]).includes(CREATE_TASK_PLAN_TOOL_NAME), true)
  })

  it('终止型工具收尾时进入队列的消息会自动交接到新回合', async () => {
    const model = new MockLanguageModelV4({
      doStream: [questionStep(), finalStep('TTL 是 Time to Live。')],
    })
    const events: CoreEvent[] = []
    let session: AgentSession
    session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: null, osPlatform: 'win32' },
      emit: (event) => {
        events.push(event)
        if (event.type === 'user-question') session.handleUserMessage('TTL是什么意思')
      },
      requestApproval: async () => ({ approved: false }),
    })

    const result = await session.handleUserMessage('帮我选择一个礼物')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    assert.match(JSON.stringify(model.doStreamCalls[1]?.prompt), /TTL是什么意思/)
    assert.equal(
      events.some((event) =>
        event.type === 'message-injected'
        && event.text === 'TTL是什么意思'
        && event.startsTurn === true),
      true,
    )
  })

  it('休眠旧计划之外的提问卡回答，不会在当前会话或重启后唤醒旧计划', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:interruption' })
    await seedActivePlan(journal)
    const model = new MockLanguageModelV4({
      doStream: [questionStep(), finalStep('预算收到，我按 100 元推荐礼物。')],
    })
    const session = createSession(model, journal)

    const waiting = await session.handleUserMessage('帮我选择一份礼物')
    assert.equal(waiting, 'waiting-user')

    const reopened = await store.open(journal.sessionId)
    assert.equal(findPendingUserQuestion([...reopened.initialMessages])?.resumesTaskPlan, false)
    const resumed = createSession(model, reopened)
    const result = await resumed.handleUserMessage('100 元')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(resumed.captureTaskPlanSnapshot()?.revision, 3)
  })
})

async function seedActivePlan(
  journal: Awaited<ReturnType<SessionStore['create']>>,
  stopReason: 'paused' | 'waiting-user' = 'paused',
): Promise<void> {
  await journal.recordTurnStart('seed-plan', [{ role: 'user', content: '建立复杂任务' }])
  await journal.recordStep(
    'seed-plan',
    [{ role: 'assistant', content: '已建立计划' }],
    activePlan(),
  )
  if (stopReason === 'waiting-user') {
    await journal.recordStep('seed-plan', [createUserQuestionMarker({
      id: 'question-plan-system',
      header: '运行系统',
      question: '你使用哪个系统？',
      options: [
        { label: 'Windows', description: '按 Windows 环境处理' },
        { label: 'macOS', description: '按 macOS 环境处理' },
      ],
    }, true)])
  }
  await journal.recordTurnEnd('seed-plan', stopReason)
}

function activePlan(): ActiveTaskPlan {
  return activeTaskPlanSchema.parse({
    id: '00000000-0000-4000-8000-000000000101',
    goal: '完成旧任务',
    status: 'active',
    revision: 3,
    items: [
      {
        id: 'T1',
        kind: 'work',
        title: '实现功能',
        acceptance: '实现完成',
        status: 'in_progress',
        evidence: [],
      },
      {
        id: 'T2',
        kind: 'verification',
        title: '验证功能',
        acceptance: '测试通过',
        status: 'pending',
        evidence: [],
      },
    ],
  })
}

function abortableStep(signal?: AbortSignal) {
  return {
    stream: new ReadableStream({
      start(controller) {
        const abort = () => controller.error(new Error('aborted'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      },
    }),
  }
}

function finalStep(text: string) {
  return { stream: simulateReadableStream({ chunks: finalChunks(text) }) }
}

function toolStep(toolName: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: crypto.randomUUID(),
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function questionStep() {
  return toolStep(ASK_USER_QUESTION_TOOL_NAME, {
    header: '礼物预算',
    question: '预算大约是多少？',
    options: [
      { label: '100 元内', description: '选择实用小礼物' },
      { label: '300 元内', description: '选择更有纪念性的礼物' },
    ],
  })
}

function finalChunks(text: string) {
  const id = crypto.randomUUID()
  return [
    { type: 'text-start' as const, id },
    { type: 'text-delta' as const, id, delta: text },
    { type: 'text-end' as const, id },
    {
      type: 'finish' as const,
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: usage(),
    },
  ]
}

function toolNames(call: MockLanguageModelV4['doStreamCalls'][number] | undefined): string[] {
  return (call?.tools ?? []).flatMap((tool) => tool.type === 'function' ? [tool.name] : [])
}

function createSession(
  model: MockLanguageModelV4,
  recorder: Awaited<ReturnType<SessionStore['create']>>,
  emit: (event: CoreEvent) => void = () => {},
): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: null, osPlatform: 'win32' },
    sessionRecorder: recorder,
    emit,
    requestApproval: async () => ({ approved: false }),
  })
}

function createMemorySession(
  model: MockLanguageModelV4,
  projectDir: string | null = null,
): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir, osPlatform: 'win32' },
    emit: () => {},
    requestApproval: async () => ({ approved: false }),
  })
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:interruption',
    displayName: 'Interruption Mock',
    provider: 'openai',
    capabilities: {
      supportsNativeTools: true,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-interruption-'))
  temporaryDirectories.push(path)
  return path
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待模型请求超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
