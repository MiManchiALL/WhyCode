import assert from 'node:assert/strict'
import { it } from 'node:test'
import { act, createElement, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { useRenderVisibility } from './use-render-visibility.ts'

it('多个代码块共享可见性观察，离屏停用且最后卸载时释放观察器', async t => {
  const { window, document } = parseHTML('<html><body></body></html>')
  const instances: Observer[] = []
  class Observer {
    callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void
    elements = new Set<Element>()
    disconnected = false
    constructor(callback: Observer['callback']) { this.callback = callback; instances.push(this) }
    observe(element: Element) { this.elements.add(element) }
    unobserve(element: Element) { this.elements.delete(element) }
    disconnect() { this.disconnected = true }
  }
  const globals = { window, document, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true }
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const root = createRoot(document.body)
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  function Block({ id }: { id: string }) {
    const ref = useRef<HTMLDivElement>(null)
    const visible = useRenderVisibility(ref)
    return createElement('div', { id, ref, 'data-visible': visible })
  }
  try {
    await act(async () => root.render(createElement('main', null, createElement(Block, { id: 'a' }), createElement(Block, { id: 'b' }))))
    assert.equal(instances.length, 1)
    const observer = instances[0]!
    const a = document.getElementById('a')!, b = document.getElementById('b')!
    await act(async () => observer.callback([{ target: a, isIntersecting: true }]))
    assert.equal(a.getAttribute('data-visible'), 'true')
    assert.equal(b.getAttribute('data-visible'), 'false')
    await act(async () => observer.callback([{ target: a, isIntersecting: false }, { target: b, isIntersecting: true }]))
    assert.equal(a.getAttribute('data-visible'), 'false')
    assert.equal(b.getAttribute('data-visible'), 'true')
    await act(async () => root.render(null))
    assert.equal(observer.elements.size, 0)
    assert.equal(observer.disconnected, true)
  } finally {
    await act(async () => root.unmount())
  }
})
