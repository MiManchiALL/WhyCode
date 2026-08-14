import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionPreparationLock } from './session-preparation-lock.ts'

describe('SessionPreparationLock', () => {
  it('同一时间只发放一个会话物化 lease', () => {
    const lock = new SessionPreparationLock()
    const release = lock.acquire('session-a')

    assert.equal(lock.sessionId, 'session-a')
    assert.equal(lock.kind, 'resume')
    assert.equal(lock.acquire('session-b'), null)

    release?.()
    assert.equal(lock.sessionId, null)
    assert.equal(lock.kind, null)
    assert.equal(typeof lock.acquire('session-b'), 'function')
  })

  it('重复释放旧 lease 不会解除后续操作', () => {
    const lock = new SessionPreparationLock()
    const releaseFirst = lock.acquire('session-a')!
    releaseFirst()
    const releaseSecond = lock.acquire('session-a')!

    releaseFirst()
    assert.equal(lock.sessionId, 'session-a')

    releaseSecond()
    assert.equal(lock.sessionId, null)
  })

  it('Fork 复用生命周期互斥但不冒充 Renderer 的恢复状态', () => {
    const lock = new SessionPreparationLock()
    const release = lock.acquire('source-session', 'fork')

    assert.equal(lock.sessionId, 'source-session')
    assert.equal(lock.kind, 'fork')
    assert.equal(lock.visibleResumeSessionId, null)

    release?.()
    const releaseResume = lock.acquire('target-session')
    assert.equal(lock.visibleResumeSessionId, 'target-session')
    releaseResume?.()
  })
})
