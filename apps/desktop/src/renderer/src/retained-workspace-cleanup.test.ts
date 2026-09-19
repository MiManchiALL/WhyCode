import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RetainedWorkspace } from '../../shared/workspace-lifecycle.ts'
import { RetainedWorkspaceCleanup, retainedWorkspaceKey } from './retained-workspace-cleanup.ts'

describe('保留工作区后台清理', () => {
  it('重复确认只删除一次，不同工作区可以并行完成且不会相互解除状态', async () => {
    const first = workspace('managed')
    const second = workspace('worktree')
    const operations = [deferred(), deferred()]
    const requests: RetainedWorkspace[] = []
    const cleanup = new RetainedWorkspaceCleanup(target => {
      requests.push(target)
      return operations[requests.length - 1]!.promise
    }, assert.fail)
    const removingFirst = cleanup.remove(first)
    const removingSecond = cleanup.remove(second)
    await cleanup.remove({ ...first })
    assert.deepEqual(requests, [first, second])
    assert.equal(cleanup.getSnapshot().size, 2)

    operations[1]!.resolve()
    await removingSecond
    assert.deepEqual([...cleanup.getSnapshot()], [retainedWorkspaceKey(first)])
    operations[0]!.resolve()
    await removingFirst
    assert.equal(cleanup.getSnapshot().size, 0)
  })

  it('设置卸载后清理继续，重新订阅仍能显示状态，后台失败仍提醒并可重试', async () => {
    const target = workspace('managed')
    const first = deferred()
    const errors: string[] = []
    let calls = 0
    const cleanup = new RetainedWorkspaceCleanup(() => ++calls === 1 ? first.promise : Promise.resolve(), message => errors.push(message))
    let notifications = 0
    const unsubscribe = cleanup.subscribe(() => { notifications++ })
    const removing = cleanup.remove(target)
    const pending = cleanup.getSnapshot()
    unsubscribe()
    assert.equal(notifications, 1)
    assert.equal(cleanup.getSnapshot(), pending)
    first.reject(new Error('文件被占用'))
    await removing
    assert.equal(notifications, 1)
    assert.equal(cleanup.getSnapshot().size, 0)
    assert.deepEqual(errors, ['清理工作区「示例项目」失败：文件被占用'])

    const resubscribe = cleanup.subscribe(() => { notifications++ })
    await cleanup.remove(target)
    assert.equal(calls, 2)
    assert.equal(notifications, 3)
    assert.equal(cleanup.getSnapshot().size, 0)
    resubscribe()
  })
})

function workspace(mode: RetainedWorkspace['mode']): RetainedWorkspace {
  return { id: 'same-id', mode, name: '示例项目', directory: `E:/fixtures/${mode}`, retainedAt: '2026-09-19T00:00:00Z' }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
