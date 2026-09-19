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
        names: { kept: '保留名称', deleted: '已删除名称' },
      }))
      const store = new SessionSidebarStateStore(fixture.path)
      await store.initialize(new Set(['kept']))
      assert.deepEqual(store.orderedPinnedSessionIds(), ['kept'])
      assert.equal(store.name('kept'), '保留名称')
      assert.equal(store.name('deleted'), undefined)

      await writeFile(fixture.path, '{')
      const corrupted = new SessionSidebarStateStore(fixture.path)
      await corrupted.initialize(new Set(['kept']))
      assert.deepEqual(corrupted.orderedPinnedSessionIds(), [])
      assert.equal((await readFile(fixture.path, 'utf8')), '{')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('手动名称与置顶串行保存，重新打开不丢失，删除同时清理两者', async () => {
    const fixture = await createFixture()
    try {
      const store = new SessionSidebarStateStore(fixture.path)
      await writeFile(fixture.path, JSON.stringify({ version: 1, pinnedSessionIds: ['b'] }))
      await store.initialize(new Set(['a', 'b']))
      assert.deepEqual(store.orderedPinnedSessionIds(), ['b'])
      assert.equal(store.name('b'), undefined)
      await Promise.all([store.setName('a', '  页面设计  '), store.setPinned('a', true), store.setName('b', '问题排查')])
      await store.setName('a', '最终名称')
      const restored = new SessionSidebarStateStore(fixture.path)
      await restored.initialize(new Set(['a', 'b']))
      assert.equal(restored.name('a'), '最终名称')
      assert.equal(restored.name('b'), '问题排查')
      assert.deepEqual(restored.orderedPinnedSessionIds(), ['b', 'a'])
      assert.throws(() => restored.setName('a', '  '), /不能为空/u)
      assert.throws(() => restored.setName('a', 'x'.repeat(201)), /不能超过/u)
      assert.throws(() => restored.setName('a', '名称\n换行'), /不能包含换行/u)
      await restored.remove('a')
      const persisted = JSON.parse(await readFile(fixture.path, 'utf8'))
      assert.deepEqual(persisted.names, { b: '问题排查' })
      assert.deepEqual(persisted.pinnedSessionIds, ['b'])
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  })

  it('写入失败不发布未保存名称，后续重试仍可保存', async () => {
    const fixture = await createFixture()
    try {
      const store = new SessionSidebarStateStore(fixture.path)
      await store.setName('a', '原名称')
      await rm(fixture.root, { recursive: true, force: true })
      await writeFile(fixture.root, '阻止创建目录')
      await assert.rejects(store.setName('a', '未保存名称'))
      assert.equal(store.name('a'), '原名称')
      await rm(fixture.root)
      await store.setName('a', '重试成功')
      assert.equal(store.name('a'), '重试成功')
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  })
})

async function createFixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-session-sidebar-'))
  return { root, path: join(root, 'session-sidebar.json') }
}
