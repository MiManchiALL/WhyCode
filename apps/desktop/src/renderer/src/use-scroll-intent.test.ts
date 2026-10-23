import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { act, createElement, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { useScrollIntent } from './use-scroll-intent.ts'

describe('贴底滚动的用户意图', () => {
  it('上翻在 scroll 之前释放跟随，150ms 内不重新吸附；向下和缩放不干扰', async t => {
    const page = await fixture(t)
    page.dispatch('wheel', { deltaY: -8 })
    assert.equal(page.releases, 1)
    assert.equal(page.recent(), true)
    page.advance(149)
    assert.equal(page.recent(), true)
    page.advance(1)
    assert.equal(page.recent(), false)
    page.dispatch('wheel', { deltaY: 10 })
    page.dispatch('wheel', { deltaY: -10, ctrlKey: true })
    page.dispatch('wheel', { deltaY: -10 }, page.scroller, true)
    assert.equal(page.releases, 1)
  })

  it('嵌套区域消费的上翻不打断外层，允许原生滚动传递时才释放外层', async t => {
    const page = await fixture(t)
    page.nested.style.overflowY = 'auto'
    page.nested.scrollTop = 20
    page.dispatch('wheel', { deltaY: -12 }, page.nested)
    assert.equal(page.releases, 0)
    page.nested.scrollTop = 0
    page.nested.style.overscrollBehaviorY = 'contain'
    page.dispatch('wheel', { deltaY: -12 }, page.nested)
    assert.equal(page.releases, 0)
    page.nested.style.overscrollBehaviorY = 'auto'
    page.dispatch('wheel', { deltaY: -12 }, page.nested)
    assert.equal(page.releases, 1)
    page.scroller.scrollTop = 0
    page.dispatch('wheel', { deltaY: -12 })
    assert.equal(page.releases, 1)
  })

  it('键盘和触摸支持上翻，编辑控件、输入法和已消费的按键不解除跟随', async t => {
    const page = await fixture(t)
    page.dispatch('keydown', { key: 'PageUp' })
    page.dispatch('keydown', { key: ' ', shiftKey: true })
    assert.equal(page.releases, 2)
    for (const selector of ['input', 'button', '[contenteditable]', '[role="slider"]']) {
      page.dispatch('keydown', { key: 'Home' }, page.scroller.querySelector(selector)!)
    }
    page.dispatch('keydown', { key: 'ArrowUp', isComposing: true })
    page.dispatch('keydown', { key: 'Home', ctrlKey: true })
    page.dispatch('keydown', { key: 'Home' }, page.scroller, true)
    assert.equal(page.releases, 2)
    page.dispatch('touchstart', { touches: [{ clientY: 80 }] })
    page.dispatch('touchmove', { touches: [{ clientY: 60 }] })
    assert.equal(page.releases, 2)
    page.dispatch('touchmove', { touches: [{ clientY: 90 }] })
    assert.equal(page.releases, 3)
    page.dispatch('touchmove', { touches: [{ clientY: 120 }, { clientY: 160 }] })
    assert.equal(page.releases, 3)
  })

  it('停用、重新启用及卸载释放监听和短暂保护状态', async t => {
    const page = await fixture(t)
    page.dispatch('wheel', { deltaY: -8 })
    await page.render(false)
    assert.equal(page.recent(), false)
    page.dispatch('wheel', { deltaY: -8 })
    assert.equal(page.releases, 1)
    await page.render(true)
    page.dispatch('wheel', { deltaY: -8 })
    assert.equal(page.releases, 2)
    await page.unmount()
    page.dispatch('wheel', { deltaY: -8 })
    assert.equal(page.releases, 2)
  })
})

async function fixture(t: TestContext) {
  const { window, document } = parseHTML('<html><body></body></html>')
  const globals = {
    window, document, Element: window.Element, HTMLElement: window.HTMLElement,
    getComputedStyle: (node: HTMLElement) => node.style,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  let releases = 0
  let recent!: () => boolean
  let unmounted = false
  const root = createRoot(document.body)
  const unmount = async () => { if (!unmounted) { await act(async () => root.unmount()); unmounted = true } }
  t.after(async () => {
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  function Example({ enabled }: { enabled: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    recent = useScrollIntent(ref, () => { releases++ }, enabled)
    return createElement('div', { ref }, createElement('div', { id: 'nested' }),
      createElement('input'), createElement('button'), createElement('div', { id: 'editable', contentEditable: true }),
      createElement('div', { role: 'slider' }))
  }
  const render = (enabled: boolean) => act(async () => root.render(createElement(Example, { enabled })))
  await render(true)
  const scroller = document.body.firstElementChild as HTMLElement
  const nested = document.querySelector('#nested') as HTMLElement
  document.querySelector('#editable')!.setAttribute('contenteditable', 'true')
  for (const element of [scroller, nested]) {
    Object.defineProperties(element, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } })
    element.scrollTop = 100
  }
  return {
    scroller, nested, render, unmount,
    get releases() { return releases }, recent: () => recent(), advance: (ms: number) => { now += ms },
    dispatch(type: string, values: Record<string, unknown>, target: Element = scroller, prevented = false) {
      const event = new window.Event(type, { bubbles: true, cancelable: true })
      Object.assign(event, values)
      if (prevented) event.preventDefault()
      target.dispatchEvent(event)
    },
  }
}
