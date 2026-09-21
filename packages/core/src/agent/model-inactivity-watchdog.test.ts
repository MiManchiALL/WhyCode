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

  it('流活动会续期，停止输出后重新达到超时才取消', async () => {
    const controller = new AbortController()
    const watchdog = new ModelInactivityWatchdog(controller, 30)

    watchdog.start()
    await wait(20)
    watchdog.noteStreamActivity()
    await wait(20)
    assert.equal(controller.signal.aborted, false)

    await wait(20)
    assert.equal(controller.signal.reason, MODEL_INACTIVITY_ABORT_REASON)
  })

  it('模型响应完成后停止计时，不把后续工具等待误判为模型超时', async () => {
    const controller = new AbortController()
    const watchdog = new ModelInactivityWatchdog(controller, 20)

    watchdog.start()
    watchdog.stop()
    watchdog.noteStreamActivity()
    await wait(30)
    assert.equal(controller.signal.aborted, false)
  })
})

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
