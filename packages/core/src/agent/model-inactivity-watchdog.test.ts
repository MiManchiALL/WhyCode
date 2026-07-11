import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MODEL_INACTIVITY_ABORT_REASON,
  ModelInactivityWatchdog,
} from './model-inactivity-watchdog.ts'

describe('模型流无活动看门狗', () => {
  it('模型持续无输出时中止当前步骤', async () => {
    const controller = new AbortController()
    const watchdog = new ModelInactivityWatchdog(controller, 20)

    watchdog.start()
    await wait(35)

    assert.equal(controller.signal.aborted, true)
    assert.equal(controller.signal.reason, MODEL_INACTIVITY_ABORT_REASON)
  })

  it('流活动会续期，但工具执行期间完全暂停计时', async () => {
    const controller = new AbortController()
    const watchdog = new ModelInactivityWatchdog(controller, 30)

    watchdog.start()
    await wait(20)
    watchdog.noteStreamActivity()
    await wait(20)
    assert.equal(controller.signal.aborted, false)

    watchdog.toolStarted()
    await wait(45)
    assert.equal(controller.signal.aborted, false)

    watchdog.toolEnded()
    await wait(40)
    assert.equal(controller.signal.reason, MODEL_INACTIVITY_ABORT_REASON)
  })

  it('并行工具全部结束后才恢复计时', async () => {
    const controller = new AbortController()
    const watchdog = new ModelInactivityWatchdog(controller, 20)

    watchdog.start()
    watchdog.toolStarted()
    watchdog.toolStarted()
    watchdog.toolEnded()
    await wait(30)
    assert.equal(controller.signal.aborted, false)

    watchdog.toolEnded()
    await wait(30)
    assert.equal(controller.signal.reason, MODEL_INACTIVITY_ABORT_REASON)
  })
})

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
