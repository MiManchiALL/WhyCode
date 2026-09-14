import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RuntimeSnapshot } from '../shared/session.ts'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { SessionNavigation } from './session-navigation.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const runtimes = new Map<string, DesktopSessionRuntime>()
  const loads = new Map<string, ReturnType<typeof deferred<void>>>()
  const commits: string[] = []
  const prepared: string[] = []
  const settled: (string | null)[] = []
  let readSnapshot = async (runtime: DesktopSessionRuntime, _historyStart?: string) => ({
    runtimeId: runtime.runtimeId, sessionId: runtime.sessionId,
  }) as RuntimeSnapshot
  const add = (id: string) => {
    const runtime = { runtimeId: id, sessionId: id } as DesktopSessionRuntime
    runtimes.set(id, runtime)
    return runtime
  }
  add('a')
  const navigation = new SessionNavigation({
    find: (id) => runtimes.get(id) ?? null,
    prepare: async (id) => {
      prepared.push(id)
      const load = deferred<void>()
      loads.set(id, load)
      await load.promise
      add(id)
    },
    snapshot: (runtime, historyStart) => readSnapshot(runtime, historyStart),
    commit: (runtime) => { commits.push(runtime.runtimeId) },
    settled: (runtime) => { settled.push(runtime?.runtimeId ?? null) },
  })
  return {
    navigation, loads, commits, prepared, settled, add,
    snapshot: (read: typeof readSnapshot) => { readSnapshot = read },
  }
}

// Promise continuations complete the hand-off without relying on wall-clock delays.
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve() }

describe('SessionNavigation', () => {
  it('恢复会话传递已加载历史起点，与旧请求保持隔离', async () => {
    const f = fixture()
    const starts: (string | undefined)[] = []
    f.snapshot(async (runtime, historyStart) => {
      starts.push(historyStart)
      return { runtimeId: runtime.runtimeId, sessionId: runtime.sessionId } as RuntimeSnapshot
    })
    assert.equal((await f.navigation.resume('a', 'b80')).ok, true)
    assert.equal((await f.navigation.resume('a')).ok, true)
    assert.deepEqual(starts, ['b80', undefined])
  })

  it('冷加载不阻塞已打开会话，旧加载完成也不能抢回选择', async () => {
    const f = fixture()
    const slow = f.navigation.resume('b')
    const ready = await f.navigation.resume('a')
    assert.equal(ready.ok, true)
    assert.deepEqual(f.commits, ['a'])
    assert.equal(f.navigation.sessionId, null)
    f.loads.get('b')!.resolve()
    assert.equal((await slow).ok, false)
    assert.deepEqual(f.commits, ['a'])
    assert.equal((await f.navigation.resume('b')).ok, true)
    assert.deepEqual(f.prepared, ['b'])
  })

  it('多次点击只加载当前冷目标和最后一个等待目标', async () => {
    const f = fixture()
    const b = f.navigation.resume('b')
    const c = f.navigation.resume('c')
    const d = f.navigation.resume('d')
    assert.equal(f.navigation.sessionId, 'd')
    f.loads.get('b')!.resolve()
    await drain()
    assert.deepEqual(f.prepared, ['b', 'd'])
    f.loads.get('d')!.resolve()
    assert.deepEqual((await Promise.all([b, c, d])).map((r) => r.ok), [false, false, true])
    assert.deepEqual(f.commits, ['d'])
    assert.deepEqual(f.settled, ['d'])
  })

  it('A→B→A 的重复目标共用冷加载，只有最新请求提交', async () => {
    const f = fixture()
    const first = f.navigation.resume('b')
    const middle = f.navigation.resume('c')
    const last = f.navigation.resume('b')
    f.loads.get('b')!.resolve()
    const results = await Promise.all([first, middle, last])
    assert.deepEqual(results.map((r) => r.ok), [false, false, true])
    assert.deepEqual(f.prepared, ['b'])
    assert.deepEqual(f.commits, ['b'])
  })

  it('过时的快照成功或失败都不能改变新选择', async () => {
    for (const fail of [false, true]) {
      const f = fixture()
      f.add('b')
      const delayed = deferred<RuntimeSnapshot>()
      f.snapshot((runtime) => runtime.runtimeId === 'b'
        ? delayed.promise
        : Promise.resolve({ runtimeId: 'a' } as RuntimeSnapshot))
      const stale = f.navigation.resume('b')
      await f.navigation.resume('a')
      if (fail) delayed.reject(new Error('读取失败'))
      else delayed.resolve({ runtimeId: 'b' } as RuntimeSnapshot)
      assert.equal((await stale).ok, false)
      assert.deepEqual(f.commits, ['a'])
      assert.deepEqual(f.settled, ['a'])
    }
  })

  it('旧冷加载失败不阻止最新目标继续恢复', async () => {
    const f = fixture()
    const b = f.navigation.resume('b')
    const c = f.navigation.resume('c')
    f.loads.get('b')!.reject(new Error('损坏的历史'))
    await drain()
    f.loads.get('c')!.resolve()
    assert.equal((await b).ok, false)
    const result = await c
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.snapshot.resumingSessionId, null)
    assert.deepEqual(f.commits, ['c'])
  })

  it('当前加载失败保留原选择并释放等待状态，后续可重试', async () => {
    const f = fixture()
    const failed = f.navigation.resume('b')
    f.loads.get('b')!.reject(new Error('读取失败'))
    assert.equal((await failed).ok, false)
    assert.equal(f.navigation.sessionId, null)
    assert.deepEqual(f.commits, [])
    const retry = f.navigation.resume('b')
    f.loads.get('b')!.resolve()
    assert.equal((await retry).ok, true)
    assert.deepEqual(f.commits, ['b'])
  })
})
