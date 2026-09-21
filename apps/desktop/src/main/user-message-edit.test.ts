import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  localWorkspace,
  type AgentSession,
  type ConsensusCoordinator,
  type CoreEvent,
  type PreparedLatestTurnEdit,
  type SessionJournal,
} from '@whycode/core'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { deliverEditedUserMessage, startEditedUserMessage } from './user-message-edit.ts'

describe('编辑消息交付边界', () => {
  it('文件恢复选择交给 Core；准备失败保留错误、不启动工作并释放输入闸门', async () => {
    const events: CoreEvent[] = []
    let released = false
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'), modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })
    runtime.session = {
      isBusy: false,
      prepareLatestTurnEdit: async (turnId: string, text: string, restoreFiles: boolean) => {
        assert.deepEqual([turnId, text, restoreFiles], ['turn-1', '新问题', true])
        throw new Error('文件已被其它会话修改')
      },
    } as unknown as AgentSession
    const result = await startEditedUserMessage(runtime,
      { ready: Promise.resolve(), release: () => { released = true } },
      {
        turnId: 'turn-1', text: '新问题', restoreFiles: true,
        prepareSession: async () => {},
        deliver: () => assert.fail('不应启动模型'),
        onDeliveryError: () => assert.fail('不应当作交付异常'),
      },
    )
    assert.deepEqual(result, { ok: false, error: '文件已被其它会话修改' })
    assert.equal(released, true)
    assert.equal(runtime.workStartedAt, null)
    assert.deepEqual(events, [])
  })

  it('编辑事实写稳后的同步启动异常只上报交付错误，不伪报编辑失败', async () => {
    const events: CoreEvent[] = []
    const errors: unknown[] = []
    let releases = 0
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })
    runtime.session = {
      isBusy: false,
      prepareLatestTurnEdit: async () => ({
        inputId: 'edited-input',
        text: '修改后的消息',
        attachments: [],
        imageDelivery: 'native',
        pdfAttachments: [],
        skills: [],
        accept: () => {},
        startMain: () => { throw new Error('启动失败') },
      }),
    } as unknown as AgentSession

    const result = await startEditedUserMessage(
      runtime,
      { ready: Promise.resolve(), release: () => { releases++ } },
      {
        turnId: 'turn-1', text: '修改后的消息', prepareSession: async () => {},
        deliver: (prepared) => prepared.startMain(), onDeliveryError: (error) => errors.push(error),
      },
    )

    assert.deepEqual(result, { ok: true })
    assert.equal(releases, 1)
    assert.equal(errors.length, 1)
    assert.equal(runtime.workStartedAt, null)
    assert.equal(events.filter((event) => event.type === 'work-finished').length, 1)
  })

  it('协商重跑复用编辑后的持久根输入，不创建第二个输入身份', () => {
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: () => {},
    })
    runtime.consensusEnabled = true
    runtime.journal = {
      initialConsensusState: null,
    } as unknown as SessionJournal
    const calls: unknown[][] = []
    let restored = false
    runtime.coordinator = {
      resetPersistedState: (state: unknown) => { restored = state === null },
      handleUserMessage: (...args: unknown[]) => { calls.push(args) },
    } as unknown as ConsensusCoordinator
    let accepted = 0
    let mainStarts = 0
    const prepared: PreparedLatestTurnEdit = {
      inputId: 'edited-input',
      text: '修改后的消息',
      attachments: [],
      imageDelivery: 'native',
      pdfAttachments: [],
      skills: [],
      accept: () => { accepted++ },
      startMain: async () => {
        mainStarts++
        return 'completed'
      },
    }

    deliverEditedUserMessage(runtime, prepared)

    assert.equal(restored, true)
    assert.equal(accepted, 1)
    assert.equal(mainStarts, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.[3], 'edited-input')
  })

  it('编辑发送在排到队首后才准备当前连接；失败时保留原历史并释放闸门', async () => {
    const runtime = new DesktopSessionRuntime({ workspace: localWorkspace(null), modelId: 'test:model', emit: () => {} })
    let preparations = 0
    let released = 0
    let ready!: () => void
    runtime.session = {
      isBusy: false,
      prepareLatestTurnEdit: async () => assert.fail('连接失效时不得改写历史'),
    } as unknown as AgentSession
    const result = startEditedUserMessage(runtime, {
      ready: new Promise<void>(resolve => { ready = resolve }), release: () => { released++ },
    }, {
      turnId: 'turn-1', text: '原消息',
      prepareSession: async () => { preparations++; throw new Error('当前连接未提供原模型') },
      deliver: () => assert.fail('不得使用旧凭据发起请求'),
      onDeliveryError: () => assert.fail('尚未交付'),
    })
    await Promise.resolve()
    assert.equal(preparations, 0)
    ready()
    assert.deepEqual(await result, { ok: false, error: '当前连接未提供原模型' })
    assert.equal(preparations, 1)
    assert.equal(released, 1)
    assert.equal(runtime.workStartedAt, null)
  })

  it('编辑重发使用准备后的会话，支持冷恢复并保留真实 API 错误', async () => {
    const runtime = new DesktopSessionRuntime({ workspace: localWorkspace(null), modelId: 'test:model', emit: () => {} })
    const failures: unknown[] = []
    const result = await startEditedUserMessage(runtime, { ready: Promise.resolve(), release: () => {} }, {
      turnId: 'turn-1', text: '原消息',
      prepareSession: async () => {
        runtime.session = {
          prepareLatestTurnEdit: async () => ({ startMain: () => { throw new Error('Insufficient Balance') } }),
        } as unknown as AgentSession
      },
      deliver: prepared => prepared.startMain(),
      onDeliveryError: error => failures.push(error),
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(runtime.modelId, 'test:model')
    assert.equal((failures[0] as Error).message, 'Insufficient Balance')
    assert.equal(runtime.workStartedAt, null)
  })
})
