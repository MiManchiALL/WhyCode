import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionDeletionLock } from './session-deletion-lock.ts'

describe('SessionDeletionLock', () => {
  it('历史会话删除保持单飞，但不阻塞当前运行时', () => {
    const lock = new SessionDeletionLock()
    const release = lock.acquire('historical-session', false)

    assert.equal(lock.sessionId, 'historical-session')
    assert.equal(lock.blocksRuntime, false)
    assert.equal(lock.acquire('another-session', false), null)

    release?.()
    assert.equal(lock.sessionId, null)
  })

  it('当前会话删除阻塞运行时，旧 lease 不能释放后续删除', () => {
    const lock = new SessionDeletionLock()
    const releaseCurrent = lock.acquire('current-session', true)!

    assert.equal(lock.blocksRuntime, true)
    releaseCurrent()
    const releaseNext = lock.acquire('current-session', false)!
    releaseCurrent()

    assert.equal(lock.sessionId, 'current-session')
    assert.equal(lock.blocksRuntime, false)
    releaseNext()
    assert.equal(lock.sessionId, null)
  })
})
