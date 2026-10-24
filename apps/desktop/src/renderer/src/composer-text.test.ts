import assert from 'node:assert/strict'
import { it } from 'node:test'
import { act, createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { ComposerText } from './composer-text.ts'

it('连续输入和删除只更新全文订阅者，发送状态仅在空值边界更新', async t => {
  const { window, document } = parseHTML('<html><body></body></html>')
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true }
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const root = createRoot(document.body)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const text = new ComposerText()
  let shellRenders = 0
  let editorRenders = 0
  let displayed = ''
  function Editor() {
    displayed = useSyncExternalStore(text.subscribe, text.getSnapshot)
    editorRenders++
    return null
  }
  function Shell() {
    const empty = useSyncExternalStore(text.subscribe, text.isEmpty)
    shellRenders++
    return createElement('div', { 'data-empty': empty }, createElement(Editor))
  }
  await act(async () => root.render(createElement(Shell)))
  await act(async () => text.set('你'))
  const shellBefore = shellRenders
  const editorBefore = editorRenders
  for (const next of ['你好', '你好，世界', '你好，世', '你好，', '你好', '你']) {
    await act(async () => {
      text.set(next)
      assert.equal(text.getSnapshot(), next, '发送可同步取得最新内容，不等待 React 或保存计时器')
    })
    assert.equal(displayed, next)
  }
  assert.equal(shellRenders, shellBefore)
  assert.equal(editorRenders, editorBefore + 6)
  await act(async () => text.set(' \n'))
  assert.equal(shellRenders, shellBefore + 1)
  assert.equal(document.querySelector('div')?.getAttribute('data-empty'), 'true')
  await act(async () => text.set(current => `恢复内容\n${current}`))
  assert.equal(displayed, '恢复内容\n \n')
  assert.equal(document.querySelector('div')?.getAttribute('data-empty'), 'false')
})
