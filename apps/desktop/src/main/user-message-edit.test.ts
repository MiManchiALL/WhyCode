import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentSession, CoreEvent } from '@whycode/core'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { startEditedUserMessage } from './user-message-edit.ts'

describe('编辑消息交付边界', () => {
  it('编辑事实写稳后的同步启动异常只上报交付错误，不伪报编辑失败', async () => {
    const events: CoreEvent[] = []
    const errors: unknown[] = []
    let releases = 0
    const runtime = new DesktopSessionRuntime({
      projectDir: 'C:\\WhyCode',
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })
    runtime.session = {
      isBusy: false,
      prepareAbortedTurnEdit: async () => () => {
        throw new Error('启动失败')
      },
    } as unknown as AgentSession

    const result = await startEditedUserMessage(
      runtime,
      { ready: Promise.resolve(), release: () => { releases++ } },
      'turn-1',
      '修改后的消息',
      (error) => errors.push(error),
    )

    assert.deepEqual(result, { ok: true })
    assert.equal(releases, 1)
    assert.equal(errors.length, 1)
    assert.equal(runtime.workStartedAt, null)
    assert.equal(events.filter((event) => event.type === 'work-finished').length, 1)
  })
})
