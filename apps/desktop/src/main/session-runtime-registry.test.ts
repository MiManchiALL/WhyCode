import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import {
  SESSION_RUNTIME_IDLE_UNLOAD_MS,
  SessionRuntimeRegistry,
} from './session-runtime-registry.ts'

describe('SessionRuntimeRegistry', () => {
  it('默认保留非选中空闲运行时三十分钟', () => {
    assert.equal(SESSION_RUNTIME_IDLE_UNLOAD_MS, 30 * 60 * 1000)
  })

  it('切换只改变选中项，忙碌对话继续保留', async () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: -1 })
    const first = runtime('first')
    const second = runtime('second')
    first.sessionInitialization = new Promise(() => {})

    registry.select(first)
    registry.select(second)

    assert.equal(registry.selected, second)
    assert.equal(registry.get(first.runtimeId), first)
    assert.equal(first.busy, true)
  })

  it('非选中空闲运行时延迟卸载，重新选中会取消卸载', async () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: 20 })
    const first = runtime('first')
    const second = runtime('second')
    registry.select(first)
    registry.select(second)
    registry.select(first)
    await delay(35)
    assert.equal(registry.get(first.runtimeId), first)
    assert.equal(registry.get(second.runtimeId), null)
  })

  it('后台运行的会话在结束后才开始计算空闲卸载时间', async () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: 20 })
    const background = runtime('background')
    const selected = runtime('selected')
    background.sessionInitialization = new Promise(() => {})
    registry.select(background)
    registry.select(selected)

    await delay(30)
    assert.equal(registry.get(background.runtimeId), background)

    background.sessionInitialization = null
    background.notifyStateChanged()
    registry.runtimeBecameIdle(background)
    await delay(30)

    assert.equal(registry.get(background.runtimeId), null)
  })

  it('限制同时启动的对话数，但不阻止已忙对话继续接收 steering', () => {
    const registry = new SessionRuntimeRegistry({
      maxConcurrentRuns: 2,
      idleUnloadMs: -1,
    })
    const first = runtime('first')
    const second = runtime('second')
    const third = runtime('third')
    first.sessionInitialization = new Promise(() => {})
    second.sessionInitialization = new Promise(() => {})
    registry.add(first)
    registry.add(second)
    registry.add(third)

    const existing = registry.reserveWorkStart(first)
    assert.notEqual(existing, null)
    assert.equal(registry.reserveWorkStart(third), null)
    existing?.release()
  })

  it('并发启动容量检查会同步占位，不允许多个 idle IPC 一起越过上限', () => {
    const registry = new SessionRuntimeRegistry({
      maxConcurrentRuns: 1,
      idleUnloadMs: -1,
    })
    const first = runtime('first')
    const second = runtime('second')
    registry.add(first)
    registry.add(second)

    const reservation = registry.reserveWorkStart(first)
    assert.notEqual(reservation, null)
    assert.equal(first.busy, true)
    assert.equal(registry.reserveWorkStart(second), null)

    reservation!.release()
    assert.equal(first.busy, false)
    registry.reserveWorkStart(second)?.release()
  })

  it('退出会先取消并等待仍在准备的附件事务', async () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: -1 })
    const target = runtime('attachment')
    registry.add(target)
    const signal = target.beginAttachmentPreparation()
    const closing = registry.closeAll()

    assert.equal(signal.aborted, true)
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    assert.equal(closed, false)

    target.endAttachmentPreparation()
    await closing
    assert.equal(registry.get(target.runtimeId), null)
  })
})

function runtime(runtimeId: string): DesktopSessionRuntime {
  return new DesktopSessionRuntime({
    runtimeId,
    projectDir: process.cwd(),
    modelId: null,
    emit: () => {},
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
