import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeBrowserScript } from './browser-execution.ts'

test('Browser PTC 隔离脚本变量与宿主能力，输出保留在当前调用', async () => {
  const signal = new AbortController().signal
  const first = await executeBrowserScript('globalThis.previous = 12; text([typeof process, typeof require, typeof fetch]); text(await browser.tabs());',
    [{ name: 'tabs', run: async () => [{ id: 'page' }] }], signal)
  assert.equal(first.isError, false)
  assert.match(first.text, /undefined.*undefined.*undefined/)
  assert.match(first.text, /page/)
  const next = await executeBrowserScript('text(typeof previous)', [], signal)
  assert.equal(next.isError, false)
  assert.match(next.text, /undefined/)
})

test('并行声明的浏览器动作按派发顺序执行；截图可跟在操作后同次返回', async () => {
  const order: string[] = []
  const result = await executeBrowserScript('await Promise.all([browser.click(), browser.screenshot().then(image)]); image(await browser.screenshot());', [
    { name: 'click', run: async () => { await new Promise(resolve => setTimeout(resolve, 30)); order.push('clicked'); return null } },
    { name: 'screenshot', run: async () => { order.push('captured'); return { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=' } } },
  ], new AbortController().signal)
  assert.deepEqual(order, ['clicked', 'captured', 'captured'])
  assert.equal(result.isError, false, result.text)
  assert.equal(result.images.length, 1, '相同画面复用一个附件，不使整批导入失败')
})

test('用户取消区分已完成、在途未确认和队列内未开始，取消后不派发新动作', async () => {
  const controller = new AbortController()
  let late = false
  const result = await executeBrowserScript('await browser.done(); await Promise.all([browser.slow(), browser.late()]);', [
    { name: 'done', run: async () => true },
    { name: 'slow', run: async (_args, signal) => {
      controller.abort(new Error('user_closed: 用户停止了 Agent 网页'))
      signal.throwIfAborted()
    } },
    { name: 'late', run: async () => { late = true; return true } },
  ], controller.signal)
  assert.equal(late, false)
  assert.equal(result.isError, true)
  assert.match(result.text, /user_closed/)
  assert.match(result.text, /"operation":"done","status":"completed"/)
  assert.match(result.text, /"operation":"slow","status":"uncertain"/)
  assert.doesNotMatch(result.text, /"operation":"late","status":"completed"/)
})
