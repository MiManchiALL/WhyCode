import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHTML } from 'linkedom'
import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { createServer } from 'vite'

test('项目会话按组展示三条，独立展开，重启恢复预览', async t => {
  const vite = await createServer({
    root: import.meta.dirname, configFile: false, esbuild: { jsx: 'automatic' },
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => vite.close())
  const { AppSidebar } = await vite.ssrLoadModule('/app-sidebar.tsx')
  const { window, document } = parseHTML('<html><body></body></html>')
  const values = new Map()
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  for (const [key, value] of Object.entries({ window, document, localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous)
      else Reflect.deleteProperty(globalThis, key)
    })
  }

  const items = (group, count) => Array.from({ length: count }, (_, i) => ({
    sessionId: group + i, title: group + i, updatedAt: '2026-01-01', resumable: true, pinned: group === '置顶',
  }))
  const local = items('本地', 6)
  const ssh = items('远端', 4)
  const three = items('三条', 3)
  const pinned = items('置顶', 5)
  const project = (name, sessions) => ({ id: name, name, directory: '/' + name, sessionIds: sessions.map(s => s.sessionId) })
  const props = {
    projects: [
      project('本地', local), { ...project('远端', ssh), remote: { target: 'ssh', label: '服务器' } },
      project('三条', [...three, ...pinned]), project('空项目', []),
    ],
    sessions: [...pinned, ...local, ...ssh, ...three, ...items('最近', 5)],
    layout: { refs: { left: createRef() }, widths: { left: 260 } }, deletingSessionIds: new Set(),
    onResume: id => { props.selectedSessionId = id },
  }
  let root = createRoot(document.body)
  const render = () => act(() => root.render(createElement(AppSidebar, props)))
  const click = button => {
    assert.ok(button)
    return act(() => button.click())
  }
  const more = group => [...document.querySelectorAll('button[aria-expanded]')].find(b => b.textContent.endsWith(group + ' 的更多会话'))
  const rows = group => [...document.querySelectorAll(`button[aria-label^="打开会话 ${group}"]`)]
  const folder = title => document.querySelector(`button[title="${title}"][aria-expanded]`)
  try {
    await render()
    assert.deepEqual(rows('本地').map(b => b.getAttribute('aria-label')), ['打开会话 本地0', '打开会话 本地1', '打开会话 本地2'])
    assert.equal(rows('远端').length, 3)
    assert.equal(rows('三条').length, 3)
    assert.equal(more('三条'), undefined)
    assert.ok(document.body.textContent.includes('暂无会话'))
    assert.equal(rows('置顶').length, 5)
    assert.equal(rows('最近').length, 5)

    await click(more('本地'))
    assert.equal(rows('本地').length, 6)
    assert.equal(more('本地').getAttribute('aria-expanded'), 'true')
    assert.equal(rows('远端').length, 3)
    await click(rows('本地').at(-1))
    await render()
    assert.equal(document.querySelector('[aria-current="page"]').getAttribute('aria-label'), '当前会话 本地5')
    await click(more('本地'))
    assert.equal(rows('本地').length, 3)
    await click(more('远端'))
    await click(folder('服务器 · /远端'))
    assert.equal(rows('远端').length, 0)
    await click(folder('服务器 · /远端'))
    await click(document.querySelector('[aria-label="收起项目"]'))
    await click(document.querySelector('[aria-label="展开项目"]'))
    assert.equal(rows('远端').length, 4)

    await click(folder('/三条'))
    // 用同一份偏好存储重新挂载，区分文件夹折叠和项目内的条数限制。
    await act(() => root.unmount())
    root = createRoot(document.body)
    await render()
    assert.equal(rows('远端').length, 3)
    assert.equal(more('远端').getAttribute('aria-expanded'), 'false')
    assert.equal(folder('/三条').getAttribute('aria-expanded'), 'false')
  } finally {
    await act(() => root.unmount())
  }
})
