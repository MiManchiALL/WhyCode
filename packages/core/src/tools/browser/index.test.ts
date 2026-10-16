import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { BrowserTurnContext } from './index.ts'

test('Browser 首次调用只加载指引，投影在当前请求尾部且不改写历史或工具描述', async () => {
  const context = new BrowserTurnContext()
  let executions = 0
  const tool = context.tool({ attachmentDirectory: '', sessionId: 'test', supportsImages: false,
    driver: { execute: async () => { executions++; return { text: 'done', isError: false, images: [] } }, finishTurn: async () => {} } })
  const ctx = { projectDir: '', additionalDirs: [], abortSignal: new AbortController().signal, turnId: 'turn' }
  const history: ModelMessage[] = [{ role: 'user', content: '检查网页' }]
  const stablePrompt = tool.prompt
  assert.equal(context.project(history).length, 1)
  const first = await tool.execute({ code: 'await browser.open()' }, ctx)
  assert.match(first.data, /本次未执行/)
  assert.equal(executions, 0)
  assert.equal(context.project(history).length, 2)
  assert.equal(context.project(history).at(-1)?.role, 'user')
  assert.equal(context.project(history, false).length, 1)
  assert.ok(context.tokenEstimate() > 0)
  await tool.execute({ code: 'text(await browser.tabs())' }, ctx)
  assert.equal(executions, 1)
  assert.equal(tool.prompt, stablePrompt)
  assert.deepEqual(history, [{ role: 'user', content: '检查网页' }])
  context.finish()
  assert.equal(context.project(history).length, 1)
  assert.equal(context.tokenEstimate(), 0)
})

test('截图附件失败仍保留已经完成的浏览器操作记录', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-browser-image-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const context = new BrowserTurnContext()
  const tool = context.tool({ attachmentDirectory: root, sessionId: 'test', supportsImages: true,
    driver: { execute: async () => ({ text: 'click: completed', isError: false,
      images: [{ name: 'broken.png', bytes: new Uint8Array([1, 2, 3]) }] }), finishTurn: async () => {} } })
  const ctx = { projectDir: root, additionalDirs: [], abortSignal: new AbortController().signal, turnId: 'turn' }
  await tool.execute({}, ctx)
  const result = await tool.execute({ code: 'await browser.click(); image(await browser.screenshot())' }, ctx)
  assert.equal(result.isError, true)
  assert.match(result.data, /click: completed/)
  assert.match(result.data, /截图附件未保存/)
})
