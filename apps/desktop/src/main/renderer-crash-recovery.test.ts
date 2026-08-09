import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRendererCrashRecoveryController } from './renderer-crash-recovery.ts'

describe('Renderer 崩溃恢复闸门', () => {
  it('同一轮崩溃只安排一次重载，页面恢复后才重新开放', () => {
    const scheduled: (() => void)[] = []
    let reloads = 0
    const controller = createRendererCrashRecoveryController({
      isShuttingDown: () => false,
      isUnavailable: () => false,
      reload: () => { reloads++ },
      schedule: (callback, delayMs) => {
        assert.equal(delayMs, 500)
        scheduled.push(callback)
      },
    })

    assert.equal(controller.rendererGone({ reason: 'oom', exitCode: 5 }), true)
    assert.equal(controller.rendererGone({ reason: 'crashed', exitCode: 6 }), false)
    assert.equal(scheduled.length, 1)
    scheduled[0]!()
    assert.equal(reloads, 1)

    controller.rendererLoaded()
    assert.equal(controller.rendererGone({ reason: 'crashed', exitCode: 7 }), true)
    assert.equal(scheduled.length, 2)
  })

  it('忽略正常退出，并在延迟窗口关闭后取消重载', () => {
    const scheduled: (() => void)[] = []
    let unavailable = false
    let reloads = 0
    const controller = createRendererCrashRecoveryController({
      isShuttingDown: () => false,
      isUnavailable: () => unavailable,
      reload: () => { reloads++ },
      schedule: (callback) => { scheduled.push(callback) },
    })

    assert.equal(controller.rendererGone({ reason: 'clean-exit', exitCode: 0 }), false)
    assert.equal(controller.rendererGone({ reason: 'oom', exitCode: 5 }), true)
    unavailable = true
    scheduled[0]!()
    assert.equal(reloads, 0)
  })

  it('退出流程与已销毁窗口都不启动恢复', () => {
    let shuttingDown = true
    let unavailable = false
    const controller = createRendererCrashRecoveryController({
      isShuttingDown: () => shuttingDown,
      isUnavailable: () => unavailable,
      reload: () => assert.fail('不应重载'),
      schedule: () => assert.fail('不应调度'),
    })

    assert.equal(controller.rendererGone({ reason: 'crashed', exitCode: 1 }), false)
    shuttingDown = false
    unavailable = true
    assert.equal(controller.rendererGone({ reason: 'crashed', exitCode: 1 }), false)
  })
})
