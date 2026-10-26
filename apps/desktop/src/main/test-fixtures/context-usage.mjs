import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

const directory = process.env.WHYCODE_CONTEXT_TEST_DIR
app.setPath('userData', path.join(directory, 'profile'))
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
const timeout = setTimeout(() => app.exit(1), 45_000)

async function checkCards(win) {
  const execute = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + args.map(arg => JSON.stringify(arg)).join(',') + ')')
  const waitFor = predicate => win.webContents.executeJavaScript('new Promise((resolve, reject) => {'
    + 'const deadline = performance.now() + 5000; const check = () => {'
    + 'if ((' + predicate.toString() + ')()) return resolve();'
    + 'if (performance.now() > deadline) return reject(new Error("页面状态等待超时"));'
    + 'requestAnimationFrame(check); }; check(); })')
  win.webContents.debugger.attach('1.3')
  const command = (method, params) => win.webContents.debugger.sendCommand(method, params)
  await command('Emulation.setFocusEmulationEnabled', { enabled: true })
  const click = async selector => {
    const point = await execute(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }, selector)
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  }
  const escape = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await command('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
  }
  const settled = () => waitFor(() => document.getAnimations().every(animation => animation.playState !== 'running'))
  const panels = () => execute(() => [...document.querySelectorAll('.wc-context-meter-panel')].map(panel => ({
    label: panel.getAttribute('aria-label'), rect: panel.getBoundingClientRect().toJSON(),
    rows: [...panel.querySelectorAll('dt')].map(row => row.textContent),
  })))

  for (const width of [1200, 800]) {
    win.setContentSize(width, 600)
    await command('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false })
    await execute(() => ContextUsageFixture.mount())
    await waitFor(() => document.querySelector('.wc-context-meter-trigger'))
    await click('.wc-context-meter-trigger')
    await waitFor(() => document.querySelector('.wc-context-meter-panel'))
    await settled()
    const original = (await panels())[0].rect
    for (const [label, rows] of [
      ['系统提示词', ['内置系统提示词', '自定义系统提示词']],
      ['工具', ['内置工具', '已加载 MCP 工具']],
      ['消息与上下文', ['AGENTS.md', '子代理目录', 'Skill 目录', '上下文']],
    ]) {
      await click('button[aria-label="' + label + '明细"]')
      await waitFor(() => document.querySelector('.wc-context-meter-detail'))
      await settled()
      const current = await panels()
      assert.equal(current.length, 2, JSON.stringify({ width, label, current }))
      assert.deepEqual(current[0].rect, original, '切换分类时原卡片保持位置和大小')
      const detail = current[1]
      assert.equal(detail.label, label + '明细')
      assert.deepEqual(detail.rows, rows)
      assert.ok(detail.rect.right <= original.left - 7, '明细在概览旁留出间距')
      assert.ok(detail.rect.left >= 11 && detail.rect.right <= width - 11, '明细不超出窗口左右边界')
      assert.ok(detail.rect.top >= 11 && detail.rect.bottom <= 589, '明细不超出窗口上下边界')
    }
    if (process.env.WHYCODE_CONTEXT_SCREENSHOTS) {
      await writeFile(path.join(process.env.WHYCODE_CONTEXT_SCREENSHOTS, width + '.png'), (await win.webContents.capturePage()).toPNG())
    }
    await click('.wc-context-meter-detail')
    assert.equal((await panels()).length, 2, '点击明细内容不关闭原卡片')
    await escape()
    await waitFor(() => document.querySelectorAll('.wc-context-meter-panel').length === 1)
    assert.equal(await execute(() => document.activeElement.getAttribute('aria-label')), '消息与上下文明细')
    await escape()
    await waitFor(() => !document.querySelector('.wc-context-meter-panel'))
    await waitFor(() => document.activeElement.classList.contains('wc-context-meter-trigger'))

    await click('.wc-context-meter-trigger')
    await waitFor(() => document.querySelector('.wc-context-meter-panel'))
    assert.equal((await panels()).length, 1, '重新打开不保留已关闭的明细')
    await click('button[aria-label="工具明细"]')
    await waitFor(() => document.querySelector('.wc-context-meter-detail'))
    await click('#outside')
    await waitFor(() => !document.querySelector('.wc-context-meter-panel'))
  }

  await execute(() => ContextUsageFixture.mount('replace'))
  await click('.wc-context-meter-trigger')
  await waitFor(() => document.querySelector('.wc-context-meter-panel'))
  await click('button[aria-label="系统提示词明细"]')
  await waitFor(() => document.querySelector('.wc-context-meter-detail'))
  assert.deepEqual((await panels())[1].rows, ['自定义系统提示词'], '覆盖后不显示内置提示词')
  await click('button[aria-label="工具明细"]')
  await settled()
  assert.deepEqual((await panels())[1].rows, ['内置工具'], '未加载 MCP schema 时没有 MCP 行')
  await execute(() => ContextUsageFixture.mount(null))
  await waitFor(() => !document.querySelector('.wc-context-meter-panel'))
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.setOpacity(0.01); win.setSkipTaskbar(true); win.setIgnoreMouseEvents(true); win.showInactive()
  try {
    await win.loadFile(path.join(directory, 'index.html'))
    await checkCards(win)
  } finally { win.destroy() }
  clearTimeout(timeout)
  console.log('context usage passed')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
