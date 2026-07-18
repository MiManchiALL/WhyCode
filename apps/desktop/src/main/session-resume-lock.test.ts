import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionResumeLock } from './session-resume-lock.ts'

describe('SessionResumeLock', () => {
  it('同一时间只发放一个恢复 lease', () => {
    const lock = new SessionResumeLock()
    const release = lock.acquire('session-a')

    assert.equal(lock.sessionId, 'session-a')
    assert.equal(lock.acquire('session-b'), null)

    release?.()
    assert.equal(lock.sessionId, null)
    assert.equal(typeof lock.acquire('session-b'), 'function')
  })

  it('重复释放旧 lease 不会解除后续恢复', () => {
    const lock = new SessionResumeLock()
    const releaseFirst = lock.acquire('session-a')!
    releaseFirst()
    const releaseSecond = lock.acquire('session-a')!

    releaseFirst()
    assert.equal(lock.sessionId, 'session-a')

    releaseSecond()
    assert.equal(lock.sessionId, null)
  })
})
