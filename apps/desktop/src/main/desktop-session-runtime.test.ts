import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CoreEvent } from '@whycode/core'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'

describe('会话工作计时', () => {
  it('根工作只启动一次，并在终态前固定持续时间', () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      projectDir: 'C:\\WhyCode',
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    runtime.beginWork()
    const startedAt = runtime.workStartedAt
    runtime.beginWork()
    runtime.emit({ type: 'agent-status', status: 'working' }, false)
    runtime.emit({ type: 'agent-status', status: 'idle' }, false)

    assert.equal(typeof startedAt, 'number')
    assert.equal(events.filter((event) => event.type === 'work-started').length, 1)
    const finished = events.find((event) => event.type === 'work-finished')
    assert.ok(finished?.type === 'work-finished' && finished.durationMs >= 0)
    assert.ok(
      events.findIndex((event) => event.type === 'work-finished')
      < events.findIndex((event) => event.type === 'agent-status' && event.status === 'idle'),
    )
    assert.equal(runtime.workStartedAt, null)
  })

  it('交付异常可幂等结束工作计时', () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      projectDir: 'C:\\WhyCode',
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    runtime.beginWork()
    runtime.finishWork()
    runtime.finishWork()

    assert.equal(events.filter((event) => event.type === 'work-finished').length, 1)
    assert.equal(runtime.workStartedAt, null)
  })
})
