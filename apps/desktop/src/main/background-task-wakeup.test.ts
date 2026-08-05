import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { localWorkspace, type CommandTaskTerminalNotification } from '@whycode/core'
import { BackgroundTaskWakeQueue } from './background-task-wakeup.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const TASK_ID = '22222222-2222-4222-8222-222222222222'

describe('后台任务唤醒宿主队列', () => {
  it('按任务去重，并在运行体、全局名额和路由闸门均可用后只交付一次', async () => {
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace(null),
      modelId: null,
      emit: () => undefined,
    })
    let resolution: 'defer' | 'ready' = 'defer'
    let capacityAvailable = false
    let blocked = false
    let deliveries = 0
    let releases = 0
    const queue = new BackgroundTaskWakeQueue({
      resolveRuntime: async () => resolution === 'ready'
        ? { kind: 'ready', runtime }
        : { kind: 'defer' },
      reserveWorkStart: () => capacityAvailable
        ? {
            ready: Promise.resolve(),
            release: () => { releases++ },
          }
        : null,
      deliveryBlocked: () => blocked,
      deliver: (_runtime, delivered) => {
        assert.equal(delivered.task.id, TASK_ID)
        deliveries++
      },
    })

    queue.enqueue(notification())
    queue.enqueue(notification())
    await queue.nudge()
    assert.equal(deliveries, 0)

    resolution = 'ready'
    await queue.nudge()
    assert.equal(deliveries, 0)

    capacityAvailable = true
    blocked = true
    await queue.nudge()
    assert.equal(deliveries, 0)
    assert.equal(releases, 0)

    blocked = false
    await queue.nudge()
    assert.equal(deliveries, 1)
    assert.equal(releases, 1)

    await queue.nudge()
    assert.equal(deliveries, 1)
    assert.equal(releases, 1)
  })

  it('删除会话时丢弃尚未交付的通知', async () => {
    let resolutions = 0
    const queue = new BackgroundTaskWakeQueue({
      resolveRuntime: async () => {
        resolutions++
        return { kind: 'defer' }
      },
      reserveWorkStart: () => null,
      deliveryBlocked: () => false,
      deliver: () => assert.fail('已删除会话不应收到后台任务通知'),
    })

    queue.enqueue(notification())
    await queue.nudge()
    queue.discardSession(SESSION_ID)
    const beforeFinalNudge = resolutions
    await queue.nudge()
    assert.equal(resolutions, beforeFinalNudge)
  })

  it('应用退出会等待在途恢复离开临界区，且不再接收或交付通知', async () => {
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace(null),
      modelId: null,
      emit: () => undefined,
    })
    const resolving = deferred<void>()
    const releaseResolution = deferred<void>()
    let resolutions = 0
    let deliveries = 0
    const queue = new BackgroundTaskWakeQueue({
      resolveRuntime: async () => {
        resolutions++
        resolving.resolve()
        await releaseResolution.promise
        return { kind: 'ready', runtime }
      },
      reserveWorkStart: () => ({ ready: Promise.resolve(), release: () => undefined }),
      deliveryBlocked: () => false,
      deliver: () => { deliveries++ },
    })

    queue.enqueue(notification())
    await resolving.promise
    const closing = queue.close()
    releaseResolution.resolve()
    await closing
    assert.equal(deliveries, 0)

    queue.enqueue(notification())
    await queue.nudge()
    assert.equal(resolutions, 1)
    assert.equal(deliveries, 0)
  })

  it('应用退出不会被仍在等待的前序输入路由反向卡住', { timeout: 1_000 }, async () => {
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace(null),
      modelId: null,
      emit: () => undefined,
    })
    const reserved = deferred<void>()
    let releases = 0
    const queue = new BackgroundTaskWakeQueue({
      resolveRuntime: async () => ({ kind: 'ready', runtime }),
      reserveWorkStart: () => {
        reserved.resolve()
        return {
          ready: new Promise<void>(() => {}),
          release: () => { releases++ },
        }
      },
      deliveryBlocked: () => false,
      deliver: () => assert.fail('退出中的通知不应继续交付'),
    })

    queue.enqueue(notification())
    await reserved.promise
    await queue.close()
    assert.equal(releases, 1)
  })
})

function notification(): CommandTaskTerminalNotification {
  return {
    task: {
      schemaVersion: 1,
      id: TASK_ID,
      sessionId: SESSION_ID,
      command: 'node build.mjs',
      cwd: 'C:\\workspace',
      status: 'completed',
      startedAt: '2026-08-05T08:00:00.000Z',
      endedAt: '2026-08-05T08:00:01.000Z',
      exitCode: 0,
      outputBytes: 128,
      outputTruncated: false,
      canWrite: false,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}
