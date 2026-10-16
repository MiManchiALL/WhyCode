import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { registerAttachmentProtocol, registerFileSchemes } from '../image-protocol.ts'

const directory = process.env.WHYCODE_REFERENCE_TEST_DIR
app.setPath('userData', path.join(directory, 'profile'))
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
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
      source: image.source, captures,
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

async function checkMarkers(win) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const masks = async image => {
      const bitmap = await createImageBitmap(new Blob([image.bytes]))
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
      const result = image.source.targets.map(({ imageRect: r }) => {
        canvas.width = r.width; canvas.height = r.height
        context.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height)
        const { data } = context.getImageData(0, 0, r.width, r.height)
        return Array.from({ length: data.length / 4 }, (_, i) => data[i * 4] > 225 && data[i * 4 + 1] > 225 && data[i * 4 + 2] > 225 ? '1' : '0').join('')
      })
      bitmap.close(); return result
    }
    const captures = Array.from({ length: 6 }, () => ({ ...fixture.captures[0], target: { ...fixture.captures[0].target, id: crypto.randomUUID() } }))
    const grouped = await BrowserReferenceImage.composeBrowserReference(captures, '六个目标')
    const distinct = await masks(grouped)
    const url = URL.createObjectURL(new Blob([grouped.bytes], { type: 'image/jpeg' }))
    try {
      const restored = await BrowserReferenceImage.restoreBrowserReference(url, grouped.source)
      const edited = await masks(await BrowserReferenceImage.composeBrowserReference([restored[5]], '只保留第六个'))
      const fresh = await masks(await BrowserReferenceImage.composeBrowserReference([captures[5]], '新引用'))
      const distance = (a, b) => [...a].reduce((sum, value, index) => sum + Number(value !== b[index]), 0)
      return { distinct: new Set(distinct).size, whitePixels: fresh[0].replaceAll('0', '').length,
        editedDifference: distance(edited[0], fresh[0]), oldDifference: distance(distinct[5], fresh[0]) }
    } finally { URL.revokeObjectURL(url) }
  })()`)
  assert.equal(result.distinct, 6, '相同页面内容上的六个选框有不同的数字标记')
  assert.ok(result.whitePixels > 70, '单目标截图也有白字与描边')
  assert.ok(result.editedDifference < result.oldDifference / 3, '移除其它目标后，原编号 6 被新编号 1 覆盖')
}

async function checkDragging(win) {
  const execute = (code) => win.webContents.executeJavaScript(code)
  win.webContents.debugger.attach('1.3')
  const command = (method, params) => win.webContents.debugger.sendCommand(method, params)
  const waitFor = (condition) => execute(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000
    const check = () => {
      if (${condition}) return resolve()
      if (performance.now() >= deadline) return reject(new Error('等待页面状态超时: ' + ${JSON.stringify(condition)} + '\\n' + JSON.stringify({
        viewport: [innerWidth, innerHeight], focused: document.hasFocus(),
        handle: document.querySelector('[aria-label="移动批注框"]')?.getBoundingClientRect().toJSON(),
        editor: document.querySelector('[aria-label="网页批注"]')?.getBoundingClientRect().toJSON(),
        side: document.querySelector('[aria-label="网页批注"]')?.dataset.side,
        events: window.pointerTrace,
      })))
      requestAnimationFrame(check)
    }
    check()
  })`)
  // 输入回执只确认派发；React 的拖动状态和布局必须分别观察，不能用延时或帧数推测完成。
  const mouse = (type, x, y, buttons = 0) => command('Input.dispatchMouseEvent', { type, x, y, buttons,
    button: type === 'mouseMoved' && buttons === 0 ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
  const rects = () => execute(`(() => ({
    editor: document.querySelector('[aria-label="网页批注"]').getBoundingClientRect().toJSON(),
    boundary: document.getElementById('browser-boundary').getBoundingClientRect().toJSON(),
  }))()`)
  const assertInside = async () => {
    const { editor: e, boundary: b } = await rects()
    assert.ok(e.left >= b.left + 7 && e.right <= b.right - 7, '连续拖动后仍在浏览器左右边界内')
    assert.ok(e.top >= b.top + 7 && e.bottom <= b.bottom - 7, '连续拖动后仍在浏览器上下边界内')
    return e
  }
  const drag = async (x, y) => {
    await waitFor(`(() => {
      const handle = document.querySelector('[aria-label="移动批注框"]')
      if (!handle) return false
      const r = handle.getBoundingClientRect()
      return handle.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })()`)
    const { editor: start, boundary } = await rects()
    const p = await execute(`(() => { const r = document.querySelector('[aria-label="移动批注框"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    await mouse('mouseMoved', p.x, p.y)
    await mouse('mousePressed', p.x, p.y, 1)
    await mouse('mouseMoved', p.x + 6, p.y + 6, 1)
    await waitFor('document.querySelector("[aria-label=移动批注框]").getAttribute("aria-pressed") === "true"')
    for (let index = 1; index <= 20; index++) {
      const next = { x: Math.round(p.x + (x - p.x) * index / 20), y: Math.round(p.y + (y - p.y) * index / 20) }
      const expected = {
        x: Math.max(boundary.left + 8, Math.min(boundary.right - start.width - 8, start.x + next.x - p.x)),
        y: Math.max(boundary.top + 8, Math.min(boundary.bottom - start.height - 8, start.y + next.y - p.y)),
      }
      await mouse('mouseMoved', next.x, next.y, 1)
      await waitFor(`(() => { const r = document.querySelector('[aria-label="网页批注"]').getBoundingClientRect();
        return Math.abs(r.x - ${expected.x}) < 1 && Math.abs(r.y - ${expected.y}) < 1 })()`)
      await assertInside()
    }
    const beforeDrop = await assertInside()
    await mouse('mouseReleased', x, y)
    await waitFor('!document.querySelector("[aria-label=移动批注框]").hasAttribute("aria-pressed")')
    const afterDrop = await assertInside()
    assert.ok(Math.abs(beforeDrop.x - afterDrop.x) < 1 && Math.abs(beforeDrop.y - afterDrop.y) < 1, `松手不改变批注框位置: ${JSON.stringify({ x, y, beforeDrop, afterDrop })}`)
  }
  // 固定 CSS 视口并模拟页面焦点，测试不依赖托管机器的显示器尺寸、DPI 或前台窗口。
  await command('Emulation.setFocusEmulationEnabled', { enabled: true })
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false })
  await waitFor('innerWidth === 1200 && innerHeight === 850')
  await execute(`window.pointerTrace = []; for (const type of ['pointerdown','pointermove','pointerup','pointercancel','resize']) window.addEventListener(type, event => {
    window.pointerTrace.push({type, x:event.clientX, y:event.clientY, buttons:event.buttons, target:event.target.getAttribute?.('aria-label')});
    window.pointerTrace = window.pointerTrace.slice(-8)
  }, true); null`)
  for (let pass = 0; pass < 2; pass++) {
    // 同一套断言覆盖正常渲染和慢渲染，不依赖 CI 机器恰好足够快。
    await command('Emulation.setCPUThrottlingRate', { rate: pass === 0 ? 1 : 6 })
    await execute('BrowserReferenceImage.mountEditor(680, false)')
    await waitFor('document.getElementById("browser-boundary")?.dataset.ready === "true"')
    assert.equal(await execute('Boolean(document.querySelector("[aria-label=网页批注]"))'), false, '边界尚未交付时不显示可拖动的批注框')
    await execute('BrowserReferenceImage.mountEditor()')
    await waitFor('document.querySelector("[aria-label=网页批注]")')
    await drag(1150, 800); await drag(400, 160); await drag(0, 840); await drag(1190, 5)
    if (pass === 1) {
      await execute('BrowserReferenceImage.mountEditor(300)')
      await waitFor(`(() => {
        const boundary = document.getElementById('browser-boundary')
        const b = boundary.getBoundingClientRect()
        const e = document.querySelector('[aria-label="网页批注"]').getBoundingClientRect()
        return boundary.clientWidth === 300 && e.left >= b.left + 7 && e.right <= b.right - 7
          && e.top >= b.top + 7 && e.bottom <= b.bottom - 7
      })()`)
      await assertInside()
      await drag(1150, 800); await drag(0, 5)
    }
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor('!document.querySelector("[aria-label=网页批注]")')
    await execute('BrowserReferenceImage.unmountEditor()')
  }
}

app.whenReady().then(async () => {
  registerAttachmentProtocol(async id => id === sessionId ? directory : null)
  assert.equal(session.fromPartition('persist:whycode-browser').protocol.isProtocolHandled('whycode-attachment'), false)
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.setOpacity(0.01); win.setSkipTaskbar(true); win.setIgnoreMouseEvents(true); win.showInactive()
  await win.loadFile(path.join(directory, 'index.html'))
  await checkImages(win)
  await checkMarkers(win)
  // 开发页面的 HTTP origin 和生产页面的 file origin 都必须能匿名解码附件。
  const server = createServer(async (request, response) => {
    const asset = request.url === '/renderer.js' ? 'renderer.js' : request.url === '/renderer.css' ? 'renderer.css' : 'index.html'
    response.setHeader('Content-Type', asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html')
    response.end(await readFile(path.join(directory, asset)))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
    await checkImages(win)
    await checkDragging(win)
  } finally { server.close(); win.destroy() }
  clearTimeout(timeout)
  console.log('reference images passed')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
