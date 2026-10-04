import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { BrowserDataState } from '../../shared/browser.ts'
import { watchBrowserData } from './browser-data-state.ts'

it('设置重开读取当前进度，迟到快照不能覆盖通知，卸载取消监听与未完成读取', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let notify!: (state: BrowserDataState) => void
  let resolve!: (state: BrowserDataState) => void
  let disposed = 0
  const values: BrowserDataState[] = []
  const fail = (error: unknown) => assert.fail(String(error))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { whycode: {
    onBrowserDataChanged(callback: typeof notify) { notify = callback; return () => { disposed++ } },
    getBrowserDataState() { return new Promise<BrowserDataState>(done => { resolve = done }) },
  } } })
  try {
    let stop = watchBrowserData(value => values.push(value), fail)
    resolve({ clearing: 'cache' })
    await Promise.resolve()
    assert.deepEqual(values, [{ clearing: 'cache' }])
    stop()
    stop = watchBrowserData(value => values.push(value), fail)
    notify({ clearing: 'all' })
    resolve({ clearing: null })
    await Promise.resolve()
    assert.equal(values.at(-1)?.clearing, 'all')
    stop()
    stop = watchBrowserData(value => values.push(value), fail)
    stop()
    resolve({ clearing: 'cache' })
    await Promise.resolve()
    assert.equal(values.length, 2)
    assert.equal(disposed, 3)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
