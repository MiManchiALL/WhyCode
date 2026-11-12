import assert from 'node:assert/strict'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', path.join(process.env.WHYCODE_REVIEW_TEST_DIR, 'profile'))
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.whenReady().then(async () => {
  // 离屏绘制让原生拖选与悬停按帧更新，同时保持测试窗口隐藏。
  const win = new BrowserWindow({ show: false, width: 880, height: 620,
    webPreferences: { offscreen: true, backgroundThrottling: false } })
  const page = path.join(process.env.WHYCODE_REVIEW_TEST_DIR, 'index.html')
  const web = win.webContents
  web.debugger.attach('1.3')
  const errors = []
  let stage = 'load window'
  const timeout = setTimeout(() => { console.error('Timed out during', stage, errors); app.exit(1) }, 70000)
  web.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const run = expression => web.executeJavaScript(expression)
  const element = selector => `document.querySelector(${JSON.stringify(selector)})`
  const waitFor = async (expression, label) => {
    stage = label
    const deadline = Date.now() + 25000
    for (;;) {
      const result = await run(expression)
      if (result) return result
      if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify({
        errors, view: await run(`({
          selection: getSelection().toString().slice(0, 160), rows: document.querySelectorAll('[data-code-row]').length,
          tabs: document.getElementById('tab-count')?.textContent, preview: document.querySelector('aside')?.innerText.slice(0, 180),
        })`),
      })}`)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  const until = (expression, label) => waitFor(`Boolean(${expression})`, label)
  const mouse = (type, point, pressed = false) => web.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, ...point, buttons: pressed ? 1 : 0,
    button: type === 'mouseMoved' && !pressed ? 'none' : 'left',
    ...(type === 'mouseMoved' ? {} : { clickCount: 1 }),
  })
  const clicked = async point => {
    await mouse('mouseMoved', point)
    await mouse('mousePressed', point, true)
    await mouse('mouseReleased', point)
  }
  // Radix 先在屏外测量弹层。只向浏览器实际能命中目标的坐标派发鼠标事件。
  const center = selector => waitFor(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!target) return null
    const rect = target.getBoundingClientRect()
    const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    return target.contains(document.elementFromPoint(point.x, point.y)) ? point : null
  })()`, `pointer can reach ${selector}`)
  const pointInCode = (row, column) => run(`(() => {
    const code = document.querySelector('[data-code-row="${row}"] > code')
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
    let offset = ${column}
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset <= node.length) {
        const range = document.createRange(); range.setStart(node, offset); range.collapse(true)
        const rect = range.getBoundingClientRect()
        return { x: Math.round(rect.x), y: Math.round(rect.y + rect.height / 2) }
      }
      offset -= node.length
    }
    throw Error('column outside fixture')
  })()`)
  const drag = async (from, to, expectedText, afterPress) => {
    stage = 'native drag from ' + JSON.stringify(from) + ' to ' + JSON.stringify(to)
    await mouse('mouseMoved', from)
    await mouse('mousePressed', from, true)
    await until(element('[data-line-focus]'), 'pressed code line is marked')
    await afterPress?.()
    await mouse('mouseMoved', { x: from.x + 7, y: from.y }, true)
    await mouse('mouseMoved', to, true)
    await until(`getSelection().toString() === ${JSON.stringify(expectedText)} && !document.querySelector("[data-line-focus]")`, 'drag reaches the requested text')
    await mouse('mouseReleased', to)
    await until('document.querySelector(".wc-code-selection-menu")', 'manual selection offers actions')
  }
  const jump = async () => {
    await clicked(await center('.wc-file-link'))
    await until('document.querySelectorAll("[data-line-focus]").length === 3', 'link marks all three lines')
    assert.ok(await run('getSelection().isCollapsed'))
    assert.equal(await run('document.querySelector("[data-code-selection-menu]")'), null)
  }
  const fileReady = `document.querySelector('[data-code-row="63"] > code')?.textContent === 'const first = 1;'`
  const reopenTab = async () => {
    await clicked(await center('#close'))
    await until('document.getElementById("tab-count").textContent === "0" && !document.querySelector(".wc-code-lines")', 'tab closed')
    await clicked(await center('#reopen'))
    await until(fileReady, 'sample file reopened')
  }
  const reloadSession = async expectedReferences => {
    await clicked(await center('#save'))
    await until(`document.getElementById('save').dataset.saved === '${expectedReferences}'`, 'session saved')
    const previousDocument = await run('performance.timeOrigin')
    await win.loadFile(page)
    assert.notEqual(await run('performance.timeOrigin'), previousDocument)
    await until(fileReady, 'sample file restored from session')
    assert.equal(await run('document.getElementById("tab-count").textContent'), '1')
  }
  try {
    await win.loadFile(page)
    await until('document.querySelector(".wc-file-link")', 'fixture ready')
    const labelStyle = await run(`(() => {
      const style = getComputedStyle(document.querySelector('.wc-file-link [data-streamdown="inline-code"]'))
      return [style.backgroundColor, style.borderTopWidth, style.paddingInlineStart]
    })()`)
    assert.deepEqual(labelStyle, ['rgba(0, 0, 0, 0)', '0px', '0px'])
    await jump()
    await until(element('[data-code-row="63"] code span'), 'worker colours the selected code')
    assert.deepEqual(await run('Array.from(document.querySelectorAll("[data-line-focus]"), row => Number(row.dataset.codeRow))'), [63, 64, 65])
    const greyRows = await run(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-line-focus] > code'))
      return rows.map(code => ({ color: getComputedStyle(code).backgroundColor, width: code.offsetWidth }))
    })()`)
    assert.ok(greyRows.every(row => row.color === 'rgb(240, 240, 238)' && row.width === greyRows[0].width && row.width > 280), JSON.stringify(greyRows))
    const copied = await run(`(() => {
      const data = new DataTransfer()
      document.activeElement.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    })()`)
    assert.equal(copied, 'const first = 1;\n  const second = 42;\n  return second + 1;')
    assert.notEqual(await run('getComputedStyle(document.querySelector(".wc-code-text"), "::selection").backgroundColor'),
      await run('getComputedStyle(document.querySelector("#prose"), "::selection").backgroundColor'))
    await clicked(await center('#outside'))
    await until('!document.querySelector("[data-line-focus]")', 'outside click clears the grey lines')
    await jump()
    await clicked(await pointInCode(63, 6))
    assert.deepEqual(await run('Array.from(document.querySelectorAll("[data-line-focus]"), row => Number(row.dataset.codeRow))'), [63])
    await clicked(await pointInCode(64, 10))
    assert.deepEqual(await run('Array.from(document.querySelectorAll("[data-line-focus]"), row => Number(row.dataset.codeRow))'), [64])
    await clicked(await center('[aria-label="自动换行"]'))
    await until(element('.wc-code-scroll[data-wrap="true"]'), 'wrap enabled')
    await clicked(await pointInCode(62, 68))
    assert.ok(await run(`(() => {
      const row = document.querySelector('[data-line-focus][data-code-row="62"] > code')
      return row && row.offsetHeight > 2 * parseFloat(getComputedStyle(row).lineHeight)
    })()`), 'current logical row covers multiple wrapped lines')
    await clicked(await center('[aria-label="自动换行"]'))
    await until(element('.wc-code-scroll[data-wrap="false"]'), 'wrap disabled')
    await jump()
    assert.equal(await run('document.querySelector("#tab-count").textContent'), '1')
    const from = await pointInCode(63, 6), to = await pointInCode(64, 14)
    const sourceExcerpt = 'first = 1;\n  const second'
    await drag(from, to, sourceExcerpt)
    await clicked(await center('.wc-code-selection-menu button:first-child'))
    await until(element('[aria-label="1 段选中代码"]'), 'selection enters composer')
    await drag(to, from, sourceExcerpt)
    await clicked(await center('.wc-code-selection-menu button:last-child'))
    await until('document.activeElement?.tagName === "TEXTAREA"', 'comment editor focused')
    stage = 'input comment'
    await web.insertText('核对这两行')
    await clicked(await center('[data-code-selection-menu] .wc-reference-submit'))
    await until('document.querySelector(".wc-code-note-marker")', 'gutter annotation saved')
    const gutterGap = await run(`(() => {
      const mark = document.querySelector('.wc-code-note-marker')
      const label = document.createRange()
      label.selectNodeContents(mark.parentNode.firstChild)
      return label.getBoundingClientRect().left - mark.getBoundingClientRect().right
    })()`)
    assert.ok(gutterGap >= 0 && gutterGap < 5, `marker is ${gutterGap}px from the line number`)
    await reopenTab()
    await until('document.querySelector(".wc-code-note-marker")', 'annotation retained when file reopened')
    assert.equal(await run('getSelection().isCollapsed'), true)
    await mouse('mouseMoved', await center('[aria-label="1 条代码批注"]'))
    await until('document.querySelector(".wc-reference-list")?.innerText.includes("核对这两行")', 'hover shows the comment')
    assert.equal(await run('document.querySelector(".wc-code-excerpt").textContent'), sourceExcerpt)
    await clicked(await center('#outside'))
    await reloadSession(2)
    await until('document.querySelector(".wc-code-note-marker")', 'unsent note restored from IndexedDB')
    await run('document.querySelector(".wc-code-note-marker").scrollIntoView({block:"center"})')
    await clicked(await center('.wc-code-note-marker'))
    await until('document.querySelector(".wc-reference-list")?.innerText.includes("核对这两行")', 'marker opens original note')
    await clicked(await center('#outside'))
    await clicked(await center('#submit'))
    const message = await run('sessionStorage.getItem("sent")')
    for (const value of ['文件：/project/sample.ts', '工作区：/project', '行号：64–65', sourceExcerpt, '批注：核对这两行']) assert.ok(message.includes(value), value)
    await until('!document.querySelector(".wc-code-note-marker, #composer .wc-reference-chip")', 'submission releases draft and gutter markers')
    const collapsed = async () => {
      await until(element('#message [aria-label="1 条代码批注"]'), 'sent note is a chip')
      assert.equal(await run('document.querySelector("#message .wc-user-message-bubble, .wc-reference-list")'), null)
      assert.ok(!await run('document.querySelector("#message").innerText.includes("所选原文")'))
      await mouse('mouseMoved', await center('#message [aria-label="1 条代码批注"]'))
      await until('document.querySelector(".wc-reference-list")?.innerText.includes("核对这两行")', 'sent chip previews annotation')
      assert.equal(await run('document.querySelector(".wc-code-excerpt").textContent'), sourceExcerpt)
      assert.equal(await run('document.querySelector("[aria-label=移除代码引用]")'), null)
      await clicked(await center('#outside'))
    }
    await collapsed()
    await clicked(await center('#queue'))
    await collapsed()
    await reopenTab()
    assert.equal(await run(element('.wc-code-note-marker')), null)
    await reloadSession(0)
    assert.equal(await run(element('#composer .wc-reference-chip, .wc-code-note-marker')), null)
    await collapsed()
    await mouse('mouseMoved', await center('#message .wc-user-message-copy'))
    await clicked(await center('#message [aria-label="编辑消息"]'))
    await until('document.activeElement?.getAttribute("aria-label") === "编辑用户消息"', 'edit opens just the user text')
    assert.equal(await run('document.activeElement.textContent.trim()'), '')
    await until(element('#message button[type=submit]:enabled'), 'reference-only edit is ready to send')
    await web.insertText('请核对这段')
    await mouse('mouseMoved', await center('#message [aria-label="1 段选中代码"]'))
    await until(element('[aria-label="移除代码引用"]'), 'editing allows removing a reference')
    await clicked(await center('[aria-label="移除代码引用"]'))
    await clicked(await center('#message button[type=submit]'))
    await until('document.querySelector("#message .wc-user-message-text")?.textContent === "请核对这段"', 'edited prose displays without metadata')
    assert.equal(await run(element('#message [aria-label="1 段选中代码"]')), null)
    assert.ok((await run('sessionStorage.getItem("sent")')).includes('批注：核对这两行'))
    // 让真实的差异着色恰好发生在按下和拖动之间。
    await web.debugger.sendCommand('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'worker' }, { exclude: true }],
    })
    await clicked(await center('#diff'))
    await until(element('[data-tone="removed"]'), 'diff ready')
    await drag(await pointInCode(1, 4), await pointInCode(3, 2), 'value\nta', async () => {
      const coloured = element('[data-tone="removed"] code span')
      assert.equal(await run(coloured), null)
      await web.debugger.sendCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true })
      await until(coloured, 'diff coloured while mouse is down')
      assert.ok(await run(`${element('[data-tone="removed"] code')}.contains(getSelection().anchorNode)`), 'pressed caret stays on the removed line')
    })
    await clicked(await center('.wc-code-selection-menu button:first-child'))
    await until(element('#composer [aria-label="1 段选中代码"]'), 'diff selection enters composer')
    await clicked(await center('#submit'))
    await until(element('#message [aria-label="1 段选中代码"]'), 'diff selection submitted')
    const diffMessage = await run('sessionStorage.getItem("sent")')
    assert.ok(diffMessage.includes('变更前 (L)\n行号：2–3\n所选原文：\n```\nvalue\nta\n```'), diffMessage)
    console.log('code review passed')
  } finally { clearTimeout(timeout); win.destroy() }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
