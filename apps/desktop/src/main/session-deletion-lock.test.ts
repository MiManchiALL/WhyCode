import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionDeletionLock } from './session-deletion-lock.ts'

describe('SessionDeletionLock', () => {
  it('历史会话删除保持单飞，但不阻塞当前运行时', () => {
    const lock = new SessionDeletionLock()
    const release = lock.acquire('historical-session', false)

    assert.equal(lock.sessionId, 'historical-session')
    assert.equal(lock.blocksRuntime, false)
    assert.equal(lock.blocksSession(), false)
    assert.equal(lock.blocksSession('other-session'), false)
    assert.equal(lock.blocksSession('historical-session'), true)
    assert.equal(lock.acquire('another-session', false), null)

    release?.release()
    assert.equal(lock.sessionId, null)
  })

  it('当前会话删除阻塞运行时，旧 lease 不能释放后续删除', () => {
    const lock = new SessionDeletionLock()
    const current = lock.acquire('current-session', true)!

    assert.equal(lock.blocksRuntime, true)
    assert.equal(lock.blocksSession(), true)
    assert.equal(lock.blocksSession('other-session'), true)
    current.allowRuntimeChanges()

    assert.equal(lock.blocksRuntime, false)
    assert.equal(lock.blocksSession(), false)
    assert.equal(lock.blocksSession('other-session'), false)
    assert.equal(lock.blocksSession('current-session'), true)
    assert.equal(lock.acquire('another-session', false), null)

    current.release()
    const next = lock.acquire('current-session', false)!
    current.release()

    assert.equal(lock.sessionId, 'current-session')
    assert.equal(lock.blocksRuntime, false)
    next.release()
    assert.equal(lock.sessionId, null)
  })
})
