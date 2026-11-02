import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { BrowserTurnContext } from './index.ts'

test('Browser 首次调用返回当前网页并加载指引，不执行传入代码或改写历史', async () => {
  const context = new BrowserTurnContext()
  let executions = 0
  let pages = [{ id: 'existing', title: 'Draft', url: 'https://example.test/draft', agent: false, selected: false, active: true }]
  const tool = context.tool({ attachmentDirectory: '', sessionId: 'test', supportsImages: false,
    driver: { listPages: () => pages, execute: async () => { executions++; return { text: 'done', isError: false, images: [] } }, finishTurn: async () => {} } })
  const ctx = { projectDir: '', additionalDirs: [], abortSignal: new AbortController().signal, turnId: 'turn' }
  const history: ModelMessage[] = [{ role: 'user', content: '检查网页' }]
  const stablePrompt = tool.prompt
  assert.equal(context.project(history).length, 1)
  const first = await tool.execute({ code: 'await browser.open()' }, ctx)
  assert.match(first.data, /本次未执行/)
  assert.deepEqual(JSON.parse(first.data.split('当前会话网页：')[1]!), pages)
  assert.equal(executions, 0)
  assert.equal(context.project(history).length, 2)
  assert.equal(context.project(history).at(-1)?.role, 'user')
  assert.equal(context.project(history, false).length, 1)
  assert.ok(context.tokenEstimate() > 0)
  pages = []
  const refresh = await tool.execute({}, ctx)
  assert.deepEqual(JSON.parse(refresh.data.split('当前会话网页：')[1]!), [])
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
    driver: { listPages: () => [], execute: async () => ({ text: 'click: completed', isError: false,
      images: [{ name: 'broken.png', bytes: new Uint8Array([1, 2, 3]) }] }), finishTurn: async () => {} } })
  const ctx = { projectDir: root, additionalDirs: [], abortSignal: new AbortController().signal, turnId: 'turn' }
  await tool.execute({}, ctx)
  const result = await tool.execute({ code: 'await browser.click(); image(await browser.screenshot())' }, ctx)
  assert.equal(result.isError, true)
  assert.match(result.data, /click: completed/)
  assert.match(result.data, /截图附件未保存/)
})
