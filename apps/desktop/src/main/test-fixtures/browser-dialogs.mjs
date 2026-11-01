import assert from 'node:assert/strict'

export async function checkBrowserDialogs({ run, finish, agent, guests, until }) {
  const html = '<!doctype html><title>Dialogs</title><output></output>'
    + '<button onclick="document.querySelector(\'output\').textContent=String(confirm(\'Share this session?\'))">Confirm</button>'
    + '<button onclick="alert(\'Connection notice\')">Alert</button>'
  const url = `data:text/html,${encodeURIComponent(html)}`
  try {
    assert.equal((await run('dialogs', `await browser.open({url:${JSON.stringify(url)}}); text(await browser.snapshot());`)).isError, false)
    const guest = guests.get(agent.pages.current('dialogs').surfaceId)
    const trigger = async index => {
      const result = await run('dialogs', `await browser.evaluate({expression:'document.querySelectorAll("button")[${index}].click()'});`)
      assert.equal(result.isError, true)
      assert.match(result.text, /javascript_dialog_open/)
      assert.doesNotMatch(result.text, /timed out/)
    }
    await trigger(0)
    const blocked = await run('dialogs', 'image(await browser.screenshot());')
    assert.equal(blocked.images.length, 0)
    assert.match(blocked.text, /javascript_dialog_open/)
    const confirm = await run('dialogs', 'text(await browser.dialog());')
    assert.equal(confirm.isError, false, confirm.text)
    assert.deepEqual(JSON.parse(confirm.text.split('\n')[0]).dialog, { type: 'confirm', message: 'Share this session?' })
    const invalid = await run('dialogs', 'await browser.dialog({accept:"yes"});')
    assert.equal(invalid.isError, true)
    const dismissed = await run('dialogs', 'await browser.dialog({accept:false}); text(await browser.wait({expression:\'document.querySelector("output").textContent==="false"\'}));')
    assert.equal(dismissed.isError, false, dismissed.text)
    await trigger(0)
    const entered = await run('dialogs', 'await browser.dialog({accept:true}); text(await browser.wait({expression:\'document.querySelector("output").textContent==="true"\'})); image(await browser.screenshot());')
    assert.equal(entered.isError, false, entered.text)
    assert.equal(entered.images.length, 1)
    await trigger(1)
    await guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true })
    const manual = await run('dialogs', 'text(await browser.dialog()); text(await browser.snapshot());')
    assert.equal(manual.isError, false, manual.text)
    assert.deepEqual(JSON.parse(manual.text.split('\n')[0]), { dialog: null }, '人工关闭后不保留陈旧弹窗')
    await finish('dialogs')

    assert.equal((await run('existing-dialog', `await browser.open({url:${JSON.stringify(url)}});`)).isError, false)
    const existing = guests.get(agent.pages.current('existing-dialog').surfaceId)
    // 原生弹窗使该调用悬挂；这里只验证取消与 guest 销毁，不把迟到返回视为响应成功。
    void existing.executeJavaScript('confirm("Already open")').catch(() => {})
    const controller = new AbortController()
    const reading = run('existing-dialog', 'text(await browser.dialog());', controller.signal)
    await until(() => existing.debugger.isAttached(), 'attach while native dialog is already open')
    controller.abort(new Error('cancel dialog inspection'))
    const cancelled = await reading
    assert.equal(cancelled.isError, true)
    assert.match(cancelled.text, /cancel dialog inspection/)
    // 接入前的原生弹窗由 Electron 持有；取消查询不会假报已处理，结束时完整释放。
    await finish('existing-dialog')
    assert.equal(existing.isDestroyed(), true)
  } finally { await finish('dialogs'); await finish('existing-dialog') }
}
