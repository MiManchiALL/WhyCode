import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { useRefreshFeedback } from './use-refresh-feedback.ts'

describe('刷新操作反馈', () => {
  it('立即完成的请求也展示一圈动画，连续点击不会重复执行', async t => {
    const page = await fixture(t)
    let calls = 0
    await act(async () => {
      void page.current.run(() => { calls++ })
      void page.current.run(() => { calls++ })
    })
    assert.equal(calls, 1)
    assert.equal(page.current.busy, true)
    await page.tick(999)
    assert.equal(page.current.busy, true)
    await page.tick(1)
    assert.equal(page.current.busy, false)
    await act(async () => { void page.current.run(() => { calls++ }) })
    assert.equal(calls, 2)
  })

  it('动画时长到达后仍等待请求完成，失败可重新刷新', async t => {
    const page = await fixture(t)
    const request = deferred()
    const failure = new Error('读取失败')
    let rejected: unknown
    await act(async () => { void page.current.run(() => request.promise).catch(error => { rejected = error }) })
    await page.tick(1000)
    assert.equal(page.current.busy, true)
    await act(async () => request.reject(failure))
    assert.equal(page.current.busy, false)
    assert.equal(rejected, failure, '错误保留给操作拥有者处理')
    let retried = false
    await act(async () => { void page.current.run(() => { retried = true }) })
    assert.equal(retried, true)
  })

  it('资源已有读取或稍后才进入 loading 时，禁用状态都由真实请求保持', async t => {
    const page = await fixture(t)
    let calls = 0
    await page.render({ loading: true })
    await act(async () => { void page.current.run(() => { calls++ }) })
    assert.equal(calls, 0)
    await page.render({ loading: false })
    await act(async () => { void page.current.run(() => { calls++ }) })
    await page.render({ loading: true })
    await page.tick(1000)
    assert.equal(page.current.busy, true)
    await act(async () => { void page.current.run(() => { calls++ }) })
    assert.equal(calls, 1)
    await page.render({ loading: false })
    assert.equal(page.current.busy, false)
  })

  it('减少动态效果不增加一秒等待，但仍等待真正的刷新完成', async t => {
    const page = await fixture(t)
    await page.render({ reducedMotion: true })
    const request = deferred()
    await act(async () => { void page.current.run(() => request.promise) })
    await page.tick(1)
    assert.equal(page.current.busy, true)
    await act(async () => request.resolve())
    assert.equal(page.current.busy, false)
  })

  it('卸载释放反馈等待，迟到的旧请求不会结束新面板的刷新', async t => {
    const page = await fixture(t)
    const old = deferred()
    const latest = deferred()
    let oldFinished = false
    await act(async () => { void page.current.run(() => old.promise).then(() => { oldFinished = true }) })
    await page.render({ key: 'new' })
    assert.equal(page.current.busy, false)
    await act(async () => { void page.current.run(() => latest.promise) })
    await act(async () => old.resolve())
    assert.equal(oldFinished, true, '卸载已经解除动画等待，不必再推进旧计时器')
    assert.equal(page.current.busy, true)
    await page.tick(1000)
    assert.equal(page.current.busy, true)
    await act(async () => latest.resolve())
    assert.equal(page.current.busy, false)
  })
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { window, document } = parseHTML('<html><body></body></html>')
  const options = { key: 'initial', loading: false, reducedMotion: false }
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: options.reducedMotion }) })
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
  let current!: ReturnType<typeof useRefreshFeedback>
  function View() { current = useRefreshFeedback(options.loading); return null }
  const render = (patch: Partial<typeof options>) => act(async () => {
    Object.assign(options, patch)
    root.render(createElement(View, { key: options.key }))
  })
  await render({})
  return { get current() { return current }, render, tick: (ms: number) => act(async () => t.mock.timers.tick(ms)) }
}
