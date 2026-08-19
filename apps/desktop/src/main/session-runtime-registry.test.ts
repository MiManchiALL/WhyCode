import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { localWorkspace, type SessionJournal } from '@whycode/core'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import {
  MAX_CONCURRENT_AGENT_RUNS,
  SESSION_RUNTIME_IDLE_UNLOAD_MS,
  SessionRuntimeRegistry,
} from './session-runtime-registry.ts'

describe('SessionRuntimeRegistry', () => {
  it('默认保留非选中空闲运行时三十分钟', () => {
    assert.equal(SESSION_RUNTIME_IDLE_UNLOAD_MS, 30 * 60 * 1000)
  })

  it('默认允许八个 Agent 同时运行，第九个根任务等待容量', () => {
    assert.equal(MAX_CONCURRENT_AGENT_RUNS, 8)
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: -1 })
    const runtimes = Array.from(
      { length: MAX_CONCURRENT_AGENT_RUNS + 1 },
      (_, index) => runtime(`capacity-${index}`),
    )
    runtimes.forEach((candidate) => registry.add(candidate))
    const reservations = runtimes.slice(0, MAX_CONCURRENT_AGENT_RUNS).map((candidate) => {
      const reservation = registry.reserveWorkStart(candidate)
      assert.notEqual(reservation, null)
      return reservation!
    })

    assert.equal(registry.reserveWorkStart(runtimes[MAX_CONCURRENT_AGENT_RUNS]!), null)
    reservations.forEach((reservation) => reservation.release())
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

  it('只标记非当前对话的工作结果，打开后立即确认', () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: -1 })
    const background = persistedRuntime('background-result')
    const selected = persistedRuntime('selected-result')
    registry.select(background)
    registry.select(selected)

    registry.markWorkFinished(background)
    registry.markWorkFinished(selected)

    assert.equal(registry.hasUnreadCompletion(background.journal!.sessionId), true)
    assert.equal(registry.hasUnreadCompletion(selected.journal!.sessionId), false)
    registry.select(background)
    assert.equal(registry.hasUnreadCompletion(background.journal!.sessionId), false)
  })

  it('卸载运行时不会丢失未查看结果，删除会话时才清理', async () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: -1 })
    const background = persistedRuntime('retained-result')
    const selected = persistedRuntime('retained-selected')
    registry.select(background)
    registry.select(selected)
    registry.markWorkFinished(background)
    const sessionId = background.journal!.sessionId

    await registry.remove(background)
    assert.equal(registry.hasUnreadCompletion(sessionId), true)
    registry.forgetSession(sessionId)
    assert.equal(registry.hasUnreadCompletion(sessionId), false)
  })

  it('非选中空闲运行时延迟卸载，重新选中会取消卸载', async () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: 20 })
    const first = persistedRuntime('first')
    const second = persistedRuntime('second')
    registry.select(first)
    registry.select(second)
    registry.select(first)
    await delay(35)
    assert.equal(registry.get(first.runtimeId), first)
    assert.equal(registry.get(second.runtimeId), null)
  })

  it('后台运行的会话在结束后才开始计算空闲卸载时间', async () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: 20 })
    const background = persistedRuntime('background')
    const selected = persistedRuntime('selected')
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

  it('已提交新选择后立即释放没有历史入口的空白草稿', async () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: 60_000 })
    const draft = runtime('draft')
    const selected = persistedRuntime('selected')
    registry.select(draft)
    registry.select(selected)

    assert.equal(await registry.removeUnselectedDraft(draft), true)
    assert.equal(registry.get(draft.runtimeId), null)
    assert.equal(await registry.removeUnselectedDraft(selected), false)
  })

  it('后台空白草稿结束后不进入三十分钟会话缓存', async () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: 60_000 })
    const draft = runtime('draft')
    draft.sessionInitialization = new Promise(() => {})
    registry.select(draft)
    registry.select(persistedRuntime('selected'))

    draft.sessionInitialization = null
    draft.notifyStateChanged()
    registry.runtimeBecameIdle(draft)
    await delay(0)

    assert.equal(registry.get(draft.runtimeId), null)
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

  it('把全局权限档位同步到全部已加载会话', () => {
    const registry = new SessionRuntimeRegistry({ idleUnloadMs: -1 })
    const first = runtime('permission-first')
    const second = runtime('permission-second')
    registry.add(first)
    registry.add(second)

    registry.setPermissionModeForAll('auto')

    assert.equal(first.permissionMode, 'auto')
    assert.equal(second.permissionMode, 'auto')
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

  it('移除运行时会等待异步资源释放完成', async () => {
    let finishCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve })
    let removed = false
    const registry = new SessionRuntimeRegistry({
      idleUnloadMs: -1,
      onRemoved: async () => {
        await cleanup
        removed = true
      },
    })
    const target = runtime('async-cleanup')
    registry.add(target)

    const removing = registry.remove(target)
    await Promise.resolve()
    assert.equal(removed, false)

    finishCleanup()
    await removing
    assert.equal(removed, true)
  })
})

function runtime(runtimeId: string): DesktopSessionRuntime {
  return new DesktopSessionRuntime({
    runtimeId,
    workspace: localWorkspace(process.cwd()),
    modelId: null,
    emit: () => {},
  })
}

function persistedRuntime(runtimeId: string): DesktopSessionRuntime {
  const value = runtime(runtimeId)
  value.journal = { sessionId: `session-${runtimeId}` } as SessionJournal
  return value
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
