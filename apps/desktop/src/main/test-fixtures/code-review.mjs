import assert from 'node:assert/strict'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', path.join(process.env.WHYCODE_REVIEW_TEST_DIR, 'profile'))
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 880, height: 620, webPreferences: { backgroundThrottling: false } })
  const web = win.webContents
  web.debugger.attach('1.3')
  const errors = []
  let stage = 'load window'
  const timeout = setTimeout(() => { console.error('Timed out during', stage, errors); app.exit(1) }, 70000)
  web.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const run = expression => web.executeJavaScript(expression)
  const element = selector => `document.querySelector(${JSON.stringify(selector)})`
  const until = async (expression, label) => {
    stage = label
    const deadline = Date.now() + 25000
    while (!await run(`Boolean(${expression})`)) {
      if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify({
        errors, view: await run('({ selection: getSelection().toString().slice(0, 160), rows: document.querySelectorAll("[data-code-row]").length })'),
      })}`)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
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
  const center = selector => run(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  })()`)
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
  const drag = async (from, to) => {
    stage = 'native drag from ' + JSON.stringify(from) + ' to ' + JSON.stringify(to)
    await mouse('mouseMoved', from)
    await mouse('mousePressed', from, true)
    await mouse('mouseMoved', { x: from.x + 7, y: from.y }, true)
    await mouse('mouseMoved', to, true)
    await mouse('mouseReleased', to)
    await until('document.querySelector(".wc-code-selection-menu")', 'manual selection offers actions')
  }
  const jump = async () => {
    await clicked(await center('.wc-file-link'))
    await until('getSelection().toString().includes("return second + 1;")', 'link selects through the last line')
    assert.equal(await run('document.querySelector("[data-code-selection-menu]")'), null)
  }
  try {
    await win.loadURL(process.env.WHYCODE_REVIEW_TEST_URL)
    await until('document.querySelector(".wc-file-link")', 'fixture ready')
    await jump()
    await until(element('[data-code-row="63"] code span'), 'worker colours the selected code')
    assert.equal(await run('getSelection().anchorNode.parentElement.closest("[data-code-row]").dataset.codeRow'), '63')
    assert.equal(await run('getSelection().focusNode.parentElement.closest("[data-code-row]").dataset.codeRow'), '65')
    const copied = await run(`(() => {
      const data = new DataTransfer()
      document.activeElement.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
      return data.getData('text/plain')
    })()`)
    assert.equal(copied, 'const first = 1;\n  const second = 42;\n  return second + 1;')
    assert.notEqual(await run('getComputedStyle(document.querySelector(".wc-code-text"), "::selection").backgroundColor'),
      await run('getComputedStyle(document.querySelector("#prose"), "::selection").backgroundColor'))
    await clicked(await center('#outside'))
    await until('getSelection().isCollapsed', 'outside click clears the native selection')
    await jump()
    const from = await pointInCode(63, 6), to = await pointInCode(64, 14)
    await clicked(from)
    await until('getSelection().isCollapsed', 'single code click clears the link selection')
    await jump()
    assert.equal(await run('document.querySelector("#tab-count").textContent'), '1')
    await drag(from, to)
    await clicked(await center('.wc-code-selection-menu button:first-child'))
    await until(element('[aria-label="1 段选中代码"]'), 'selection enters composer')
    await drag(to, from)
    await clicked(await center('.wc-code-selection-menu button:last-child'))
    await until('document.activeElement?.tagName === "TEXTAREA"', 'comment editor focused')
    stage = 'input comment'
    await web.insertText('核对这两行')
    await clicked(await center('[data-code-selection-menu] .wc-reference-submit'))
    await until('document.querySelector(".wc-code-note-marker")', 'gutter annotation saved')
    await clicked(await center('#close'))
    await until('!document.querySelector(".wc-code-lines")', 'tab closed')
    await clicked(await center('#reopen'))
    await until('document.querySelector(".wc-code-note-marker")', 'annotation retained when file reopened')
    assert.equal(await run('getSelection().isCollapsed'), true)
    await mouse('mouseMoved', await center('[aria-label="1 条代码批注"]'))
    await until('document.querySelector(".wc-reference-list")?.innerText.includes("核对这两行")', 'hover shows the comment')
    assert.equal(await run('document.querySelector(".wc-code-excerpt").textContent'), 'first = 1;\n  const second')
    await clicked(await center('#outside'))
    await clicked(await center('#submit'))
    const message = await run('document.querySelector("#message").textContent')
    for (const value of ['文件：/project/sample.ts', '工作区：/project', '行号：64–65', 'first = 1;\n  const second', '批注：核对这两行']) assert.ok(message.includes(value), value)
    await until('!document.querySelector(".wc-reference-chip")', 'sent references leave the composer')
    await clicked(await center('#submit'))
    assert.equal(await run('document.querySelector("#message").textContent'), '请核对')
    await clicked(await center('#save'))
    await until('document.querySelector("#save").dataset.saved', 'session notes stored')
    stage = 'reopen session'
    await win.loadURL(process.env.WHYCODE_REVIEW_TEST_URL)
    await until('document.querySelector("#reopen")', 'session restored')
    await clicked(await center('#reopen'))
    await until('document.querySelector(".wc-code-note-marker")', 'saved note restored from IndexedDB')
    await run('document.querySelector(".wc-code-note-marker").scrollIntoView({block:"center"})')
    await clicked(await center('.wc-code-note-marker'))
    await until('document.querySelector(".wc-reference-list")?.innerText.includes("核对这两行")', 'marker opens original note')
    await clicked(await center('[aria-label="移除代码引用"]'))
    await until('!document.querySelector(".wc-code-note-marker")', 'removed note releases the marker')
    await clicked(await center('#diff'))
    await until(element('[data-tone="removed"]'), 'diff ready')
    await drag(await pointInCode(1, 4), await pointInCode(3, 2))
    assert.ok(!await run('getSelection().toString().includes("new value")'))
    await clicked(await center('.wc-code-selection-menu button:first-child'))
    await clicked(await center('#submit'))
    const diffMessage = await run('document.querySelector("#message").textContent')
    assert.ok(diffMessage.includes('变更前 (L)\n行号：2–3\n所选原文：\n```\nvalue\nta\n```'))
    console.log('code review passed')
  } finally { clearTimeout(timeout); win.destroy() }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
