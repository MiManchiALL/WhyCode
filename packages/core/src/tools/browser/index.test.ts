import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import sharp from 'sharp'
import { attachImagesToToolResults } from '../../attachments/tool-results.ts'
import { messagesForModel } from '../../attachments/messages.ts'
import { BrowserTurnContext, type BrowserExecution } from './index.ts'

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

test('每张浏览器截图提供与模型实际图片一致的视口尺寸和点击比例', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-browser-coordinates-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const images: BrowserExecution['images'] = []
  for (const [index, height] of [800, 2560].entries()) {
    images.push({ name: `browser-${index + 1}.png`,
      bytes: await sharp({ create: { width: 1280, height, channels: 3, background: '#2488cc' } }).png().toBuffer() })
  }
  const context = new BrowserTurnContext()
  const tool = context.tool({ attachmentDirectory: root, sessionId: '11111111-1111-4111-8111-111111111111', supportsImages: true,
    driver: { listPages: () => [], execute: async () => ({ text: 'click: completed', isError: false, images }), finishTurn: async () => {} } })
  const ctx = { projectDir: root, additionalDirs: [], abortSignal: new AbortController().signal, turnId: 'turn' }
  await tool.execute({}, ctx)
  const result = await tool.execute({ code: 'image(await browser.screenshot())' }, ctx)
  assert.equal(result.isError, false, result.data)
  assert.match(result.data, /click: completed/)
  assert.match(result.data, /原点为网页内容左上角，x 向右、y 向下/)
  assert.match(result.data, /x=normalizedX\/1000\*viewportWidth，y=normalizedY\/1000\*viewportHeight/)
  assert.match(result.data, /browser-1\.png: viewport 1280×800 CSS px; model image 1280×800 px; click x=imageX\*1, y=imageY\*1/)
  assert.match(result.data, /browser-2\.png: viewport 1280×2560 CSS px; model image 1024×2048 px; click x=imageX\*1\.25, y=imageY\*1\.25/)
  assert.ok(result.attachments)
  assert.ok(result.imageTransform)
  const canonical = attachImagesToToolResults([{
    role: 'tool', content: [{ type: 'tool-result', toolCallId: 'capture', toolName: 'Browser',
      output: { type: 'text', value: result.data } }],
  }], [{ toolCallId: 'capture', attachments: result.attachments, transform: result.imageTransform }])
  const request = await messagesForModel(canonical, true, root, result.attachments)
  const message = request[0]!
  assert.ok(message.role === 'tool')
  const part = message.content[0]!
  assert.ok(part.type === 'tool-result' && part.output.type === 'content')
  assert.deepEqual(part.output.value[0], { type: 'text', text: result.data })
  const files = part.output.value.filter(item => item.type === 'file')
  assert.equal(files.length, 2)
  const dimensions = []
  for (const file of files) {
    assert.ok(file.data.type === 'data' && typeof file.data.data === 'string')
    const metadata = await sharp(Buffer.from(file.data.data, 'base64')).metadata()
    dimensions.push([metadata.width, metadata.height])
  }
  assert.deepEqual(dimensions, [[1280, 800], [1024, 2048]])
  assert.deepEqual(result.attachments.map(attachment => [attachment.width, attachment.height]), [[1280, 800], [1280, 2560]])
  assert.match(JSON.stringify(canonical), /whycode-attachment-ref:/)
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
  assert.match(result.data, /截图处理失败/)
})
