import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SessionSidebarStateStore } from './session-sidebar-state.ts'

describe('SessionSidebarStateStore', () => {
  it('按置顶动作顺序原子保存，取消后再置顶移到末尾', async () => {
    const fixture = await createFixture()
    try {
      const store = new SessionSidebarStateStore(fixture.path)
      await store.initialize(new Set(['a', 'b']))
      await store.setPinned('a', true)
      await store.setPinned('b', true)
      await store.setPinned('a', false)
      await store.setPinned('a', true)

      assert.deepEqual(store.orderedPinnedSessionIds(), ['b', 'a'])
      const restored = new SessionSidebarStateStore(fixture.path)
      await restored.initialize(new Set(['a', 'b']))
      assert.deepEqual(restored.orderedPinnedSessionIds(), ['b', 'a'])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('加载时丢弃不存在的会话和损坏的偏好文件', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(fixture.path, JSON.stringify({
        version: 1,
        pinnedSessionIds: ['kept', 'deleted', 'kept'],
      }))
      const store = new SessionSidebarStateStore(fixture.path)
      await store.initialize(new Set(['kept']))
      assert.deepEqual(store.orderedPinnedSessionIds(), ['kept'])

      await writeFile(fixture.path, '{')
      const corrupted = new SessionSidebarStateStore(fixture.path)
      await corrupted.initialize(new Set(['kept']))
      assert.deepEqual(corrupted.orderedPinnedSessionIds(), [])
      assert.equal((await readFile(fixture.path, 'utf8')), '{')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

async function createFixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-session-sidebar-'))
  return { root, path: join(root, 'session-sidebar.json') }
}
