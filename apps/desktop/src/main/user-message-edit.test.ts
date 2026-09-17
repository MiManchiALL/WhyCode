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
      'turn-1', '新问题', () => assert.fail('不应启动模型'), () => assert.fail('不应当作交付异常'), true,
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
      'turn-1',
      '修改后的消息',
      (prepared) => prepared.startMain(),
      (error) => errors.push(error),
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
})
