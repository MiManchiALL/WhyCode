import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { registerAttachmentProtocol, registerFileSchemes } from '../image-protocol.ts'

const directory = process.env.WHYCODE_REFERENCE_TEST_DIR
app.setPath('userData', path.join(directory, 'profile'))
registerFileSchemes()
const sessionId = '12345678-1234-4234-8234-123456789abc'
const storageName = `${sessionId}.jpg`
const attachmentUrl = `whycode-attachment://${sessionId}/${storageName}`
const timeout = setTimeout(() => app.exit(1), 45_000)

async function checkImages(win) {
  const execute = (code) => win.webContents.executeJavaScript(code)
  const original = await execute(`(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 160; canvas.height = 120
    const context = canvas.getContext('2d')
    context.fillStyle = '#e0541f'; context.fillRect(0, 0, 160, 120)
    const blob = await new Promise(resolve => canvas.toBlob(resolve))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const page = { url: 'file:///fixture.html', title: '引用测试' }
    const captures = ['element', 'region'].map((kind, index) => ({
      bytes, page, continuePicking: false,
      crop: { x: 80, y: 200, width: 160, height: 120 },
      target: {
        id: crypto.randomUUID(), kind, label: kind,
        ...(kind === 'element' ? { selector: '#target' } : {}),
        rect: { x: 100 + index * 10, y: 220, width: 60, height: 30 },
        viewport: { width: innerWidth, height: innerHeight, scrollX: 0, scrollY: 180, zoom: 1 },
        capturedAt: new Date().toISOString(),
      },
    }))
    const image = await BrowserReferenceImage.composeBrowserReference(captures, '调整这两个目标')
    window.fixture = {
      source: image.source,
      url: URL.createObjectURL(new Blob([image.bytes], { type: 'image/jpeg' })),
    }
    return { bytes: Array.from(image.bytes), captures }
  })()`)
  await writeFile(path.join(directory, storageName), Buffer.from(original.bytes))
  const restore = (url) => execute(`(async () => {
    const captures = await BrowserReferenceImage.restoreBrowserReference(${JSON.stringify(url)}, fixture.source)
    const image = await createImageBitmap(new Blob([captures[0].bytes]))
    const canvas = document.createElement('canvas')
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0); image.close()
    const pixel = Array.from(context.getImageData(5, 5, 1, 1).data)
    return { captures: captures.map(({ bytes, ...capture }) => capture), pixel }
  })()`)
  const expected = original.captures.map(({ bytes, ...capture }) => capture)
  const blobUrl = await execute('fixture.url')
  for (const url of [blobUrl, attachmentUrl]) {
    const restored = await restore(url)
    assert.deepEqual(restored.captures, expected)
    assert.ok(restored.pixel[0] > 200 && restored.pixel[1] < 100, '裁剪后的画面保留原图片内容')
  }
  win.setContentSize(420, 600)
  assert.deepEqual((await restore(blobUrl)).captures, expected, '调整窗口不能改写捕获时的坐标与视口')
  for (const url of [attachmentUrl.replace(sessionId, 'unowned-session'), attachmentUrl + '.missing']) {
    await assert.rejects(restore(url), /无法读取引用截图，请重新选择/)
  }
  await execute('URL.revokeObjectURL(fixture.url)')
  await assert.rejects(restore(blobUrl), /无法读取引用截图，请重新选择/)
  // 图片通道可用不等于开放主界面的任意网络连接。
  assert.equal(await execute(`new Promise(resolve => {
    const blocked = event => {
      if (event.effectiveDirective !== 'connect-src') return
      document.removeEventListener('securitypolicyviolation', blocked)
      resolve(event.blockedURI)
    }
    document.addEventListener('securitypolicyviolation', blocked)
    fetch('https://example.invalid/').catch(() => {})
  })`), 'https://example.invalid/')
}

app.whenReady().then(async () => {
  registerAttachmentProtocol(async id => id === sessionId ? directory : null)
  assert.equal(session.fromPartition('persist:whycode-browser').protocol.isProtocolHandled('whycode-attachment'), false)
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  await win.loadFile(path.join(directory, 'index.html'))
  await checkImages(win)
  // 开发页面的 HTTP origin 和生产页面的 file origin 都必须能匿名解码附件。
  const server = createServer(async (request, response) => {
    const script = request.url === '/renderer.js'
    response.setHeader('Content-Type', script ? 'text/javascript' : 'text/html')
    response.end(await readFile(path.join(directory, script ? 'renderer.js' : 'index.html')))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
    await checkImages(win)
  } finally { server.close(); win.destroy() }
  clearTimeout(timeout)
  console.log('reference images passed')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
