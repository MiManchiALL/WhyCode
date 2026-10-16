import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { pruneSidebarProjectCollapse, useSidebarGroupCollapsed } from './sidebar-collapse.ts'

describe('侧栏分组开合偏好', () => {
  it('置顶、项目总分组、本地与 SSH 项目独立保存，重新挂载后恢复', async t => {
    const page = await fixture(t)
    for (const key of ['pinned', 'projects', 'project:local', 'project:ssh'] as const) {
      assert.equal(page.groups.get(key)![0], false)
      await page.set(key, true)
    }
    await page.restart()
    assert.ok([...page.groups.values()].every(([collapsed]) => collapsed))
    await page.set('project:local', false)
    await page.restart()
    assert.equal(page.groups.get('project:local')![0], false)
    assert.equal(page.groups.get('project:ssh')![0], true)
    assert.equal(page.groups.get('projects')![0], true)
    assert.equal(page.groups.get('pinned')![0], true)
  })

  it('完整项目快照只清理已移除项目，不影响其它分组和界面偏好', async t => {
    const page = await fixture(t)
    await page.set('pinned', true)
    await page.set('projects', true)
    await page.set('project:local', true)
    await page.set('project:ssh', true)
    page.storage.setItem('whycode:conversation-font-size', '16')
    pruneSidebarProjectCollapse([{ id: 'ssh', name: '远端', directory: '/project', sessionIds: [] }])
    await page.restart()
    assert.equal(page.groups.get('project:local')![0], false)
    assert.equal(page.groups.get('project:ssh')![0], true)
    pruneSidebarProjectCollapse([])
    await page.restart()
    assert.equal(page.groups.get('project:ssh')![0], false)
    assert.equal(page.groups.get('pinned')![0], true)
    assert.equal(page.groups.get('projects')![0], true)
    assert.equal(page.storage.getItem('whycode:conversation-font-size'), '16')
  })

  it('存储不可用时仍可操作，无法识别的偏好不视为折叠', async t => {
    const page = await fixture(t)
    page.storage.setItem('whycode:sidebar-collapsed:projects', 'invalid')
    await page.restart()
    assert.equal(page.groups.get('projects')![0], false)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('unavailable') } })
    await page.restart()
    await page.set('project:ssh', true)
    assert.equal(page.groups.get('project:ssh')![0], true)
    await page.set('project:ssh', false)
    assert.equal(page.groups.get('project:ssh')![0], false)
    assert.doesNotThrow(() => pruneSidebarProjectCollapse([]))
  })
})

async function fixture(t: TestContext) {
  const { window, document } = parseHTML('<html><body></body></html>')
  const values = new Map<string, string>()
  const storage = {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const globals = { window, document, localStorage: storage, IS_REACT_ACT_ENVIRONMENT: true }
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const groups = new Map<string, ReturnType<typeof useSidebarGroupCollapsed>>()
  function Groups() {
    groups.set('pinned', useSidebarGroupCollapsed('pinned'))
    groups.set('projects', useSidebarGroupCollapsed('projects'))
    groups.set('project:local', useSidebarGroupCollapsed('project:local'))
    groups.set('project:ssh', useSidebarGroupCollapsed('project:ssh'))
    return null
  }
  let root = createRoot(document.body)
  const render = () => act(async () => root.render(createElement(StrictMode, null, createElement(Groups))))
  t.after(async () => {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  await render()
  return {
    groups, storage,
    set: (key: string, value: boolean) => act(async () => groups.get(key)![1](value)),
    restart: async () => {
      await act(async () => root.unmount())
      root = createRoot(document.body)
      await render()
    },
  }
}
