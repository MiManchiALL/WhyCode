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
import { LIST_DIR_TOOL_NAME } from '../tools/list-glob/index.ts'
import {
  createUserQuestionMarker,
  findPendingUserQuestion,
  hasPendingUserQuestion,
} from '../tasks/answer-resume.ts'
import {
  CLOSE_TASK_PLAN_TOOL_NAME,
  CREATE_TASK_PLAN_TOOL_NAME,
  REPLACE_TASK_PLAN_TOOL_NAME,
  RESUME_TASK_PLAN_TOOL_NAME,
  UPDATE_TASK_ITEM_TOOL_NAME,
} from '../tasks/tools.ts'
import {
  activeTaskPlanSchema,
  type ActiveTaskPlan,
  type TaskPlanState,
} from '../tasks/types.ts'
import { AgentSession } from './session.ts'
import { localWorkspace } from '../workspace/types.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('用户中断后的新回合', () => {
  it('用户停止流式正文时先发保留事件，再丢弃其余未提交步骤', async () => {
    const events: CoreEvent[] = []
    const model = new MockLanguageModelV4({
      doStream: async (options) => abortableTextStep(options.abortSignal, '已经展示的部分'),
    })
    const session = createMemorySession(model, undefined, (event) => events.push(event))

    const running = session.handleUserMessage('开始回答')
    await waitFor(() => events.some((event) => event.type === 'text-delta'))
    session.abort()

    assert.equal(await running, 'aborted')
    const retained = events.findIndex((event) => event.type === 'step-output-retained')
    const discarded = events.findIndex((event) => event.type === 'step-discarded')
    assert.ok(retained >= 0 && retained < discarded)
  })

  it('首个模型输出前停止后可原位编辑，活动模型历史回滚并只执行新文本', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
    const events: CoreEvent[] = []
    let firstRequest = true
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRequest) {
          firstRequest = false
          return abortableStep(options.abortSignal)
        }
        return finalStep('按编辑后的问题回答。')
      },
    })
    const session = createSession(model, journal, (event) => events.push(event))
    const inputId = crypto.randomUUID()
    await journal.recordUserInputWithId(inputId, '旧问题', true)

    const interrupted = session.handleUserMessage('旧问题', false, [], inputId)
    await waitFor(() => model.doStreamCalls.length === 1)
    session.abort()
    assert.equal(await interrupted, 'aborted')
    const oldTurnId = events.find((event) => event.type === 'turn-start')?.turnId
    assert.ok(oldTurnId)
    await journal.recordViewEvents([
      { type: 'core-event', event: { type: 'turn-start', turnId: oldTurnId } },
    ])

    const prepared = await session.prepareLatestTurnEdit(oldTurnId, '编辑后的问题')
    assert.equal(await prepared.startMain(), 'completed')
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(secondPrompt, /编辑后的问题/)
    assert.doesNotMatch(secondPrompt, /旧问题/)
    const editEventIndex = events.findIndex((event) => event.type === 'user-message-edited')
    const newTurnIndex = events.findIndex((event, index) =>
      index > editEventIndex && event.type === 'turn-start')
    assert.ok(editEventIndex >= 0 && newTurnIndex > editEventIndex)

    const reopened = await store.open(journal.sessionId)
    assert.match(JSON.stringify(reopened.initialMessages), /编辑后的问题/)
    assert.doesNotMatch(JSON.stringify(reopened.initialMessages), /旧问题/)
  })

  it('完整回答后编辑最新消息会换根重跑，旧回答不再进入活动模型历史', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
    const events: CoreEvent[] = []
    const model = new MockLanguageModelV4({
      doStream: [
        finalStep('这是旧回答。'),
        finalStep('这是编辑后的新回答。'),
      ],
    })
    const session = createSession(model, journal, (event) => events.push(event))
    const inputId = crypto.randomUUID()
    await journal.recordUserInputWithId(inputId, '旧问题', true)

    assert.equal(await session.handleUserMessage('旧问题', false, [], inputId), 'completed')
    const oldTurnId = events.find((event) => event.type === 'turn-start')?.turnId
    assert.ok(oldTurnId)
    await journal.recordViewEvents([
      { type: 'core-event', event: { type: 'turn-start', turnId: oldTurnId } },
      { type: 'core-event', event: { type: 'text-delta', text: '这是旧回答。' } },
      { type: 'core-event', event: { type: 'work-finished', durationMs: 500, outcome: 'completed' } },
    ])

    const prepared = await session.prepareLatestTurnEdit(oldTurnId, '编辑后的问题')
    assert.equal(await prepared.startMain(), 'completed')
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(secondPrompt, /编辑后的问题/)
    assert.doesNotMatch(secondPrompt, /旧问题|这是旧回答/)

    const reopened = await store.open(journal.sessionId)
    const activeHistory = JSON.stringify(reopened.initialMessages)
    assert.match(activeHistory, /编辑后的问题|这是编辑后的新回答/)
    assert.doesNotMatch(activeHistory, /旧问题|这是旧回答。/)
  })

  it('持久化模型可见中断边界，普通问题不能继续或改写旧计划', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
    await seedActivePlan(journal)

    let firstRequest = true
    const remainingSteps = [
      finalStep('TTL 是 Time to Live。'),
      toolStep(RESUME_TASK_PLAN_TOOL_NAME, {
        plan_id: activePlan().id,
      }),
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
    assert.equal(resumedSession.captureTaskStateSnapshot()?.activePlan?.revision, 3)
    const secondRequest = model.doStreamCalls[1]
    const serialized = JSON.stringify(secondRequest?.prompt)
    const requestMarkerIndex = serialized.indexOf('whycode-turn-aborted')
    const requestTtlIndex = serialized.indexOf('TTL是什么意思')
    assert.ok(requestMarkerIndex >= 0 && requestMarkerIndex < requestTtlIndex)
    assert.equal(toolNames(secondRequest).includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
    assert.equal(toolNames(secondRequest).includes(CLOSE_TASK_PLAN_TOOL_NAME), true)

    const reopened = await store.open(journal.sessionId)
    const markerIndex = reopened.initialMessages.findIndex(isTurnAbortedMessage)
    const ttlIndex = reopened.initialMessages.findIndex((message) =>
      message.role === 'user' && JSON.stringify(message.content).includes('TTL是什么意思'))
    assert.ok(markerIndex >= 0 && markerIndex < ttlIndex)
    const restoredPlan = reopened.initialViewEvents.find((entry) =>
      entry.type === 'core-event' && entry.event.type === 'task-plan-restored')
    assert.equal(
      restoredPlan?.type === 'core-event'
      && restoredPlan.event.type === 'task-plan-restored'
      && restoredPlan.event.plan?.id,
      activePlan().id,
    )

    const resumed = await resumedSession.handleUserMessage('继续刚才的任务')

    assert.equal(resumed, 'completed')
    const resumeRequestTools = toolNames(model.doStreamCalls[2])
    assert.equal(resumeRequestTools.includes(RESUME_TASK_PLAN_TOOL_NAME), true)
    assert.equal(resumeRequestTools.includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
    assert.equal(toolNames(model.doStreamCalls[3]).includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
    assert.match(JSON.stringify(model.doStreamCalls[3]), /实现功能|验证功能/)
  })

  it('UI 停止 engaged run 后持久化恢复闸门，临时问题不会清除', async () => {
    let requestCount = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        requestCount++
        if (requestCount === 1) {
          return toolStep(RESUME_TASK_PLAN_TOOL_NAME, { plan_id: activePlan().id })
        }
        if (requestCount === 2) return abortableStep(options.abortSignal)
        return finalStep('TTL 是 Time to Live。')
      },
    })
    const session = createMemorySession(model)
    session.restoreTaskStateSnapshot(activeState())

    const running = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 2)
    session.abort()

    assert.equal(await running, 'aborted')
    assert.equal(session.captureTaskStateSnapshot()?.resumeRequired, true)
    assert.equal(session.captureTaskStateSnapshot()?.interruptionReason, 'user-cancel')
    assert.equal(await session.handleUserMessage('TTL 是什么'), 'completed')
    assert.equal(session.captureTaskStateSnapshot()?.resumeRequired, true)
  })

  it('中止开发后询问游戏热度时保留完整历史和稳定工具', async () => {
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
    session.restoreTaskStateSnapshot(activeState())

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
    assert.match(request, /继续刚才的任务/)
    const names = toolNames(model.doStreamCalls[1])
    assert.equal(names.includes('ReadFile'), true)
    assert.equal(names.includes('WriteFile'), true)
    assert.equal(names.includes('RunCommand'), true)
    assert.equal(names.includes(RESUME_TASK_PLAN_TOOL_NAME), true)
    assert.equal(names.includes(REPLACE_TASK_PLAN_TOOL_NAME), true)
    assert.equal(names.includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
    assert.equal(names.includes(CLOSE_TASK_PLAN_TOOL_NAME), true)
    assert.deepEqual(session.captureTaskStateSnapshot()?.activePlan, activePlan())
  })

  it('重启后主动提问的回答仍能重新接合活动计划', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
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

  it('计划问题卡在进程中断后仍服从 blocked 闸门', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
    await journal.recordTurnStart('crashed-question', [{ role: 'user', content: '继续任务' }])
    await journal.recordStep(
      'crashed-question',
      [
        { role: 'assistant', content: '需要确认运行系统。' },
        createUserQuestionMarker({
          id: 'question-after-crash',
          questions: [
            {
              header: '运行系统',
              question: '你使用哪个系统？',
              options: [
                { label: 'Windows', description: '按 Windows 环境处理' },
                { label: 'macOS', description: '按 macOS 环境处理' },
              ],
            },
          ],
        }, true),
      ],
      activeState(),
      activePlan().id,
    )

    const interrupted = await store.open(journal.sessionId)
    await interrupted.recoverInterruptedWork()
    const recovered = await store.open(journal.sessionId)
    assert.equal(recovered.initialTaskState.resumeRequired, true)
    const model = new MockLanguageModelV4({ doStream: [finalStep('收到，使用 Windows。')] })
    const session = createSession(model, recovered)

    assert.equal(
      await session.handleUserMessage('回答「你使用哪个系统？」：Windows'),
      'completed',
    )
    assert.equal(session.captureTaskStateSnapshot()?.resumeRequired, true)
    const request = JSON.stringify(model.doStreamCalls[0]?.prompt)
    assert.match(request, /whycode-task-execution-boundary/)
    assert.match(request, /blocked/)
  })

  it('活动计划问题卡未回答时，普通输入不会被误当成答案并强制续跑', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
    await seedActivePlan(journal, 'waiting-user')
    const reopened = await store.open(journal.sessionId)
    const model = new MockLanguageModelV4({
      doStream: [finalStep('TTL 是 Time to Live。')],
    })
    const session = createSession(model, reopened)

    const result = await session.handleUserMessage('TTL是什么意思')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assert.deepEqual(session.captureTaskStateSnapshot()?.activePlan, activePlan())
  })

  it('问题卡与计划回答绑定在同一稳定 step 落盘，提交窗口停止不拆散状态', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
    await seedActivePlan(journal)
    const stepPersisted = createDeferred<void>()
    const releaseStep = createDeferred<void>()
    const originalRecordStep = journal.recordStep.bind(journal)
    let recordedSteps = 0
    journal.recordStep = async (...args) => {
      await originalRecordStep(...args)
      recordedSteps++
      if (recordedSteps === 2) {
        stepPersisted.resolve()
        await releaseStep.promise
      }
    }
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep(RESUME_TASK_PLAN_TOOL_NAME, { plan_id: activePlan().id }),
        questionStep(),
      ],
    })
    const session = createSession(model, journal)

    const running = session.handleUserMessage('继续刚才的任务')
    await stepPersisted.promise
    const crashView = await store.open(journal.sessionId)
    assert.equal(hasPendingUserQuestion([...crashView.initialMessages]), true)
    assert.equal(
      findPendingUserQuestion([...crashView.initialMessages])?.resumesTaskPlan,
      true,
    )
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
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
    const events: CoreEvent[] = []
    const model = new MockLanguageModelV4({ doStream: [questionStep()] })
    const session = createSession(model, journal, (event) => events.push(event))

    assert.equal(await session.handleUserMessage('帮我选择一份礼物'), 'waiting-user')

    const binding = findPendingUserQuestion(session.captureMessageSnapshot())
    assert.equal(binding?.resumesTaskPlan, false)
    assert.equal(binding?.question.questions[0]?.question, '预算大约是多少？')
    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.metadataSnapshot.status, 'waiting-user')
    assert.equal(findPendingUserQuestion([...reopened.initialMessages])?.resumesTaskPlan, false)
    const restoredQuestions = reopened.initialViewEvents.filter((entry) =>
      entry.type === 'core-event' && entry.event.type === 'user-question')
    assert.equal(restoredQuestions.length, 1)
    assert.equal(
      restoredQuestions[0]?.type === 'core-event'
      && restoredQuestions[0].event.type === 'user-question'
        ? restoredQuestions[0].event.question.questions[0]?.question
        : '',
      '预算大约是多少？',
    )
    assert.equal(events.filter((event) => event.type === 'user-question').length, 1)
  })

  it('问题工具执行后若 step 尚未稳定提交就被停止，不显示或恢复幽灵问题卡', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
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

  it('Resume 工具执行后若 step 未稳定提交，不产生幽灵接合', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep(RESUME_TASK_PLAN_TOOL_NAME, { plan_id: activePlan().id }),
        finalStep('TTL 是 Time to Live。'),
      ],
    })
    const events: CoreEvent[] = []
    let abortOnToolEnd = true
    let session!: AgentSession
    session = createMemorySession(model, undefined, (event) => {
      events.push(event)
      if (event.type === 'tool-end' && abortOnToolEnd) {
        abortOnToolEnd = false
        session.abort()
      }
    })
    session.restoreTaskStateSnapshot(activeState())

    assert.equal(await session.handleUserMessage('继续刚才的任务'), 'aborted')
    assert.equal(events.some((event) => event.type === 'step-discarded'), true)
    assert.deepEqual(session.captureTaskStateSnapshot()?.activePlan, activePlan())

    assert.equal(await session.handleUserMessage('TTL是什么意思'), 'completed')
    const request = model.doStreamCalls[1]
    const names = toolNames(request)
    assert.equal(names.includes(RESUME_TASK_PLAN_TOOL_NAME), true)
    assert.equal(names.includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
    assert.equal(names.includes(CLOSE_TASK_PLAN_TOOL_NAME), true)
    assert.doesNotMatch(JSON.stringify(request), /实现功能|验证功能/)
  })

  it('完整文本 step 的持久化窗口停止不会把已交付回答改判为中断', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
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
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
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

  it('被中止任务尚未创建计划时不靠隐藏 Create 阻止误续跑', async () => {
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
    assert.equal(toolNames(model.doStreamCalls[1]).includes(CREATE_TASK_PLAN_TOOL_NAME), true)
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(session.captureTaskStateSnapshot()?.activePlan, null)
  })

  it('协商执行包同样由模型判断当前请求，不用代码层隐藏 Create', async () => {
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
    )

    assert.equal(result, 'completed')
    assert.equal(toolNames(model.doStreamCalls[1]).includes(CREATE_TASK_PLAN_TOOL_NAME), true)
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(session.captureTaskStateSnapshot()?.activePlan, null)
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
      toolStep(RESUME_TASK_PLAN_TOOL_NAME, {
        plan_id: activePlan().id,
      }),
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
    session.restoreTaskStateSnapshot(activeState())

    const interrupted = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 1)
    session.abort()
    assert.equal(await interrupted, 'aborted')

    const result = await session.handleUserMessage('可以，开始做吧')

    assert.equal(result, 'paused')
    assert.equal(model.doStreamCalls.length, 5)
    assert.equal(toolNames(model.doStreamCalls[1]).includes(RESUME_TASK_PLAN_TOOL_NAME), true)
    assert.equal(toolNames(model.doStreamCalls[1]).includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
    assert.equal(toolNames(model.doStreamCalls[2]).includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
  })

  it('运行中 urgent steering 仍属于当前回合，不生成停止边界或休眠计划', async () => {
    let requestCount = 0
    const remainingSteps = [
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'in_progress',
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: 'urgent steering 测试结束',
      }),
      finalStep('已按纠正后的技术方向继续。'),
    ]
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        requestCount++
        if (requestCount === 1) {
          return toolStep(RESUME_TASK_PLAN_TOOL_NAME, {
            plan_id: activePlan().id,
          })
        }
        if (requestCount === 2) {
          return abortableStep(options.abortSignal)
        }
        const step = remainingSteps.shift()
        if (!step) throw new Error('没有配置更多模型步骤')
        return step
      },
    })
    const session = createMemorySession(model)
    session.restoreTaskStateSnapshot(activeState())

    const running = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 2)
    session.handleUserMessage('技术方向纠正：不要引入新依赖，继续做', true)
    const result = await running

    assert.equal(result, 'completed')
    const steeredRequest = JSON.stringify(model.doStreamCalls[2]?.prompt)
    assert.match(steeredRequest, /不要引入新依赖/)
    assert.doesNotMatch(steeredRequest, /whycode-turn-aborted/)
    assert.equal(toolNames(model.doStreamCalls[2]).includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
    assert.equal(session.captureMessageSnapshot().some(isTurnAbortedMessage), false)
  })

  it('被 urgent 丢弃的未提交 step 不计入十步进度提醒', async () => {
    let requestCount = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        requestCount++
        if (requestCount === 1) {
          return toolStep(RESUME_TASK_PLAN_TOOL_NAME, { plan_id: activePlan().id })
        }
        if (requestCount <= 11) return abortableStep(options.abortSignal)
        return finalStep('已收到全部技术纠正。')
      },
    })
    const session = createMemorySession(model)
    session.restoreTaskStateSnapshot(activeState())

    const running = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 2)
    for (let index = 0; index < 10; index++) {
      session.handleUserMessage(`技术纠正 ${index + 1}：继续当前任务`, true)
      await waitFor(() => model.doStreamCalls.length === index + 3)
    }

    assert.equal(await running, 'completed')
    assert.equal(model.doStreamCalls.length, 12)
    assert.doesNotMatch(
      JSON.stringify(model.doStreamCalls[11]?.prompt),
      /已有 10 个模型步骤没有更新/,
    )
  })

  it('运行中明确自然语言暂停时允许模型结束，不触发未完成保护', async () => {
    let requestCount = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        requestCount++
        if (requestCount === 1) {
          return toolStep(RESUME_TASK_PLAN_TOOL_NAME, { plan_id: activePlan().id })
        }
        if (requestCount === 2) return abortableStep(options.abortSignal)
        return finalStep('好的，当前任务先暂停，计划仍会保留。')
      },
    })
    const session = createMemorySession(model)
    session.restoreTaskStateSnapshot(activeState())

    const running = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 2)
    session.handleUserMessage('先停一下，暂时不要继续', true)

    assert.equal(await running, 'completed')
    assert.equal(model.doStreamCalls.length, 3)
    assert.deepEqual(session.captureTaskStateSnapshot()?.activePlan, activePlan())
    assert.equal(session.captureMessageSnapshot().some(isTurnAbortedMessage), false)
  })

  it('运行中暂停回应可先记账计划进度，再由最终文本结束', async () => {
    let requestCount = 0
    let releaseCurrentStep!: () => void
    const currentStepMayFinish = new Promise<void>((resolve) => {
      releaseCurrentStep = resolve
    })
    const model = new MockLanguageModelV4({
      doStream: async () => {
        requestCount++
        if (requestCount === 1) {
          return toolStep(RESUME_TASK_PLAN_TOOL_NAME, { plan_id: activePlan().id })
        }
        if (requestCount === 2) {
          await currentStepMayFinish
          return finalStep('正在处理当前任务。')
        }
        if (requestCount === 3) {
          return textAndToolStep('好的，我先停下来并保存进度。', UPDATE_TASK_ITEM_TOOL_NAME, {
            item_id: 'T1',
            status: 'completed',
            evidence: ['暂停前的实现已经完成'],
          })
        }
        if (requestCount === 4) return finalStep('进度已保存，随时说“继续”。')
        throw new Error('暂停最终回复后不应再发起模型请求')
      },
    })
    const session = createMemorySession(model)
    session.restoreTaskStateSnapshot(activeState())

    const running = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 2)
    session.handleUserMessage('先停一下，暂时不要继续')
    releaseCurrentStep()

    assert.equal(await running, 'completed')
    assert.equal(model.doStreamCalls.length, 4)
    assert.equal(
      model.doStreamCalls.some((call) =>
        JSON.stringify(call.prompt).includes('任务计划仍有未完成项')),
      false,
    )
    assert.equal(session.captureTaskStateSnapshot()?.activePlan?.items[0]?.status, 'completed')
    assert.equal(session.captureTaskStateSnapshot()?.activePlan?.items[1]?.status, 'in_progress')
  })

  it('steering 后调用实际工具仍保留未完成计划保护', async () => {
    const projectDir = await temporaryDirectory()
    let requestCount = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        requestCount++
        if (requestCount === 1) {
          return toolStep(RESUME_TASK_PLAN_TOOL_NAME, { plan_id: activePlan().id })
        }
        if (requestCount === 2) return abortableStep(options.abortSignal)
        if (requestCount === 3) {
          return toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
            item_id: 'T1',
            status: 'completed',
            evidence: ['实现完成'],
          })
        }
        if (requestCount === 4) {
          return toolStep(LIST_DIR_TOOL_NAME, { path: projectDir })
        }
        if (requestCount === 5) return finalStep('检查结束。')
        if (requestCount === 6) {
          return toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
            item_id: 'T2',
            status: 'completed',
            evidence: ['验证完成'],
          })
        }
        if (requestCount === 7) {
          return toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
            outcome: 'completed',
            summary: '检查和验证完成',
          })
        }
        return finalStep('任务完成。')
      },
    })
    const session = createMemorySession(model, projectDir)
    session.restoreTaskStateSnapshot(activeState())

    const running = session.handleUserMessage('继续刚才的任务')
    await waitFor(() => model.doStreamCalls.length === 2)
    session.handleUserMessage('记录进度后继续检查项目文件', true)

    assert.equal(await running, 'completed')
    assert.match(JSON.stringify(model.doStreamCalls[5]?.prompt), /任务计划仍有未完成项/)
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
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
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
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:interruption' })
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
    assert.equal(resumed.captureTaskStateSnapshot()?.activePlan?.revision, 3)
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
    activeState(),
  )
  if (stopReason === 'waiting-user') {
    await journal.recordStep('seed-plan', [createUserQuestionMarker({
      id: 'question-plan-system',
      questions: [
        {
          header: '运行系统',
          question: '你使用哪个系统？',
          options: [
            { label: 'Windows', description: '按 Windows 环境处理' },
            { label: 'macOS', description: '按 macOS 环境处理' },
          ],
        },
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

function activeState(): TaskPlanState {
  return {
    version: activePlan().revision,
    activePlan: activePlan(),
    historicalPlans: [],
    resumeRequired: false,
    interruptionReason: null,
  }
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

function abortableTextStep(signal: AbortSignal | undefined, text: string) {
  const id = crypto.randomUUID()
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start' as const, id })
        controller.enqueue({ type: 'text-delta' as const, id, delta: text })
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

function textAndToolStep(text: string, toolName: string, input: unknown) {
  const textId = crypto.randomUUID()
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: textId },
        { type: 'text-delta' as const, id: textId, delta: text },
        { type: 'text-end' as const, id: textId },
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
    questions: [{
      header: '礼物预算',
      question: '预算大约是多少？',
      options: [
        { label: '100 元内', description: '选择实用小礼物' },
        { label: '300 元内', description: '选择更有纪念性的礼物' },
      ],
    }],
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
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    sessionRecorder: recorder,
    emit,
    requestApproval: async () => ({ approved: false }),
  })
}

function createMemorySession(
  model: MockLanguageModelV4,
  projectDir: string = process.cwd(),
  emit: (event: CoreEvent) => void = () => {},
): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir, osPlatform: 'win32' },
    emit,
    requestApproval: async () => ({ approved: false }),
  })
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:interruption',
    displayName: 'Interruption Mock',
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
