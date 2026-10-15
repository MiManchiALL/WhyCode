import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeBrowserScript } from './browser-execution.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII='

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
    { name: 'screenshot', run: async () => { order.push('captured'); return { type: 'image', mimeType: 'image/png', data: png } } },
  ], new AbortController().signal)
  assert.deepEqual(order, ['clicked', 'captured', 'captured'])
  assert.equal(result.isError, false, result.text)
  assert.equal(result.images.length, 1, '相同画面复用一个附件，不使整批导入失败')
})

test('已处理的子操作异常保留失败记录，但不覆盖正常结束的脚本状态', async t => {
  for (const [operation, code] of [
    ['wait', 'try { await browser.wait(); } catch {}'],
    ['click', 'await browser.click().catch(() => {});'],
    ['navigate', 'await Promise.allSettled([browser.navigate()]);'],
  ] as const) await t.test(operation, async () => {
    const result = await executeBrowserScript(`${code} text(await browser.snapshot()); image(await browser.screenshot());`, [
      { name: operation, run: async () => { throw new Error('子操作失败') } },
      { name: 'snapshot', run: async () => ({ text: '操作结果已确认' }) },
      { name: 'screenshot', run: async () => ({ type: 'image', mimeType: 'image/png', data: png }) },
    ], new AbortController().signal)
    assert.equal(result.isError, false, result.text)
    assert.match(result.text, /操作结果已确认/)
    assert.ok(result.text.includes(`"operation":"${operation}","status":"failed","error":"子操作失败"`))
    assert.match(result.text, /"operation":"screenshot","status":"completed"/)
    assert.doesNotMatch(result.text, /停止原因|uncertain 表示/)
    assert.equal(result.images.length, 1)
  })
})

test('未捕获的操作或脚本异常仍使整次调用失败', async t => {
  for (const code of ['await browser.fail();', 'throw new Error("脚本异常");']) await t.test(code, async () => {
    const result = await executeBrowserScript(`await browser.done(); ${code} await browser.late();`, [
      { name: 'done', run: async () => true },
      { name: 'fail', run: async () => { throw new Error('操作异常') } },
      { name: 'late', run: async () => assert.fail('异常后的操作不应执行') },
    ], new AbortController().signal)
    assert.equal(result.isError, true)
    assert.match(result.text, /停止原因：.*异常/)
    assert.match(result.text, /"operation":"done","status":"completed"/)
    assert.doesNotMatch(result.text, /"operation":"late"/)
  })
})

test('脚本正常返回但遗漏等待的操作尚未完成时仍不能报成功', async () => {
  const result = await executeBrowserScript('browser.slow(); browser.late(); text("提前返回");', [
    { name: 'slow', run: async (_args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }) },
    { name: 'late', run: async () => assert.fail('未等待的队列不能继续执行') },
  ], new AbortController().signal)
  assert.equal(result.isError, true)
  assert.match(result.text, /提前返回/)
  assert.match(result.text, /"operation":"slow","status":"uncertain"/)
  assert.match(result.text, /"operation":"late","status":"not_started"/)
  assert.match(result.text, /uncertain 表示/)
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
