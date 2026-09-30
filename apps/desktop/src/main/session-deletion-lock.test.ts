import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionDeletionLock } from './session-deletion-lock.ts'

describe('SessionDeletionLock', () => {
  it('历史会话删除保持单飞，但不阻塞当前运行时', () => {
    const lock = new SessionDeletionLock()
    const release = lock.acquire('historical-session')

    assert.equal(lock.sessionId, 'historical-session')
    assert.equal(lock.blocksSession(), false)
    assert.equal(lock.blocksSession('other-session'), false)
    assert.equal(lock.blocksSession('historical-session'), true)
    assert.equal(lock.acquire('another-session'), null)

    release?.release()
    assert.equal(lock.sessionId, null)
  })

  it('当前会话删除只锁定该会话，旧 lease 不能释放后续删除', () => {
    const lock = new SessionDeletionLock()
    const current = lock.acquire('current-session')!

    assert.equal(lock.blocksSession(), false)
    assert.equal(lock.blocksSession('other-session'), false)
    assert.equal(lock.blocksSession('current-session'), true)
    assert.equal(lock.acquire('another-session'), null)

    current.release()
    const next = lock.acquire('current-session')!
    current.release()

    assert.equal(lock.sessionId, 'current-session')
    next.release()
    assert.equal(lock.sessionId, null)
  })
})
