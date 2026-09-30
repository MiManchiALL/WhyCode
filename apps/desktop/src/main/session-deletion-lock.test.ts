import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionDeletionLock } from './session-deletion-lock.ts'

describe('SessionDeletionLock', () => {
  it('不同会话独立删除，逆序完成只解除对应目标', () => {
    const lock = new SessionDeletionLock()
    assert.equal(lock.busy, false)
    const first = lock.acquire('historical-session')!
    const second = lock.acquire('another-session')!

    assert.ok(first)
    assert.ok(second)
    assert.equal(lock.busy, true)
    assert.equal(lock.blocksSession(), false)
    assert.equal(lock.blocksSession('other-session'), false)
    assert.equal(lock.blocksSession('historical-session'), true)
    assert.equal(lock.blocksSession('another-session'), true)
    assert.equal(lock.acquire('historical-session'), null)
    assert.equal(lock.acquire('another-session'), null)

    second.release()
    assert.equal(lock.blocksSession('another-session'), false)
    assert.equal(lock.blocksSession('historical-session'), true)
    assert.equal(lock.busy, true)
    first.release()
    assert.equal(lock.busy, false)
  })

  it('当前会话删除只锁定该会话，旧 lease 不能释放后续删除', () => {
    const lock = new SessionDeletionLock()
    const current = lock.acquire('current-session')!

    assert.equal(lock.blocksSession(), false)
    assert.equal(lock.blocksSession('other-session'), false)
    assert.equal(lock.blocksSession('current-session'), true)
    assert.equal(lock.acquire('current-session'), null)

    current.release()
    const next = lock.acquire('current-session')!
    current.release()

    assert.equal(lock.blocksSession('current-session'), true)
    next.release()
    assert.equal(lock.busy, false)
  })
})
