import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { BrowserAutomation } from './browser-automation.ts'
import { browserHasVisibleContent } from './browser-visibility.ts'

function automation() {
  return new BrowserAutomation({ getZoomFactor: () => 1, on() {}, debugger: { on() {} } } as unknown as WebContents)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('观察等待空文档的异步内容，已有内容立即进入绘制边界', async t => {
  for (const initiallyVisible of [false, true]) await t.test(String(initiallyVisible), async t => {
    const page = automation(), checked = deferred(), painted = deferred()
    let visible = initiallyVisible, complete = false
    t.mock.method(page, 'evaluate', async ({ expression }: { expression: string }) => {
      if (expression === browserHasVisibleContent) { checked.resolve(); return visible }
      await painted.promise
    })
    const pending = page.observe(new AbortController().signal).then(() => { complete = true })
    await checked.promise
    assert.equal(complete, false, '不能把空文档或尚未绘制的 DOM 当作最终观察')
    visible = true
    painted.resolve()
    await pending
    assert.equal(complete, true)
  })
})

test('合法空白页有等待上限，仍然允许捕获真实空白', async t => {
  t.mock.timers.enable({ apis: ['Date'] })
  const page = automation()
  let contentChecks = 0
  t.mock.method(page, 'evaluate', async ({ expression }: { expression: string }) => {
    if (expression === browserHasVisibleContent) { contentChecks++; t.mock.timers.tick(3000); return false }
    return null
  })
  await page.observe(new AbortController().signal)
  assert.equal(contentChecks, 1, '等待预算耗尽后不反复尝试或伪造失败')
})

test('空白页等待可取消，取消后不继续读取或截图', async t => {
  const page = automation(), checked = deferred(), controller = new AbortController()
  let reads = 0
  t.mock.method(page, 'evaluate', async () => { reads++; checked.resolve(); return false })
  const pending = page.observe(controller.signal)
  await checked.promise
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(reads, 1)
})

test('观察过程的页面错误向调用方传播', async t => {
  const page = automation(), failure = new Error('网页已关闭')
  t.mock.method(page, 'evaluate', async () => { throw failure })
  await assert.rejects(page.observe(new AbortController().signal), error => error === failure)
})
