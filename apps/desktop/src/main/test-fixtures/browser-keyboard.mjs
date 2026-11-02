import assert from 'node:assert/strict'

export async function checkBrowserKeyboard({ run, finish, agent, guests, until }) {
  const html = `<!doctype html><title>Keyboard</title>
    <input aria-label="Text"><div contenteditable="true" aria-label="Editor"></div>
    <canvas tabindex="0" width="400" height="100" style="background:lightblue"></canvas><output></output>
    <script>
      window.events=[];
      for (const type of ['keydown','keypress','keyup']) document.addEventListener(type, event => {
        events.push({type,key:event.key,code:event.code,keyCode:event.keyCode,shift:event.shiftKey,control:event.ctrlKey,trusted:event.isTrusted,target:event.target.tagName});
        if(event.target.tagName==='CANVAS' && type==='keypress') document.querySelector('output').textContent+=event.key;
      });
    </script>`
  const url = `data:text/html,${encodeURIComponent(html)}`
  const execute = async code => {
    const result = await run('keyboard', code)
    assert.equal(result.isError, false, result.text)
    return result
  }
  try {
    await execute(`await browser.open({url:${JSON.stringify(url)}}); text(await browser.snapshot());`)
    const guest = guests.get(agent.pages.current('keyboard').surfaceId)
    await execute('const s=await browser.snapshot(); await browser.click({ref:s.nodes.find(n=>n.role==="textbox"&&n.name==="Text").ref}); await browser.type({text:"普通文本🙂"});')
    assert.equal(await guest.executeJavaScript('document.querySelector("input").value'), '普通文本🙂')
    await execute('await browser.press({key:"Control+A"}); await browser.type({text:"aB9!",mode:"keys"});')
    assert.equal(await guest.executeJavaScript('document.querySelector("input").value'), 'aB9!', JSON.stringify(await guest.executeJavaScript('events')))
    await execute('await browser.evaluate({expression:\'document.querySelector("[contenteditable]").focus()\'}); await browser.type({text:"editable"});')
    assert.equal(await guest.executeJavaScript('document.querySelector("[contenteditable]").textContent'), 'editable')
    await execute('const r=await browser.evaluate({expression:\'document.querySelector("canvas").getBoundingClientRect().toJSON()\'}); await browser.click({x:r.x+20,y:r.y+20});')
    const refused = await run('keyboard', 'await browser.type({text:"not a field"});')
    assert.equal(refused.isError, true)
    assert.match(refused.text, /mode:.*keys/)
    await guest.executeJavaScript('events.length=0')
    await execute('await browser.type({text:"aB9!",mode:"keys"}); await browser.press({key:"Enter"});')
    assert.equal(await guest.executeJavaScript('document.querySelector("output").textContent'), 'aB9!Enter', '画布收到字符和 Enter 的原生 keypress')
    const events = await guest.executeJavaScript('events')
    assert.ok(events.every(event => event.trusted), '通过 Chromium 派发真实键盘事件')
    assert.deepEqual(events.filter(event => event.type === 'keydown').map(event => [event.key, event.code, event.keyCode]),
      [['a','KeyA',65],['Shift','ShiftLeft',16],['B','KeyB',66],['9','Digit9',57],['Shift','ShiftLeft',16],['!','Digit1',49],['Enter','Enter',13]])
    assert.equal(events.at(-1).shift, false, '自动 Shift 已释放')
    await guest.executeJavaScript('events.length=0')
    await execute('await browser.press({key:"Control+Shift+A"}); await browser.press({key:"F2"}); await browser.press({key:"+"});')
    const combo = await guest.executeJavaScript('events')
    assert.deepEqual(combo.filter(event => event.type === 'keydown').map(event => event.key), ['Control','Shift','A','F2','Shift','+'])
    assert.equal(combo.find(event => event.key === 'A').control, true)
    assert.equal(combo.find(event => event.key === 'F2').shift, false)
    assert.equal(combo.find(event => event.key === 'F2').control, false, '组合键不影响下一次输入')
    const printable = Array.from({length:95}, (_, index) => String.fromCharCode(32 + index)).join('')
    await guest.executeJavaScript('document.querySelector("output").textContent=""')
    await execute(`await browser.type({text:${JSON.stringify(printable)},mode:"keys"});`)
    assert.equal(await guest.executeJavaScript('document.querySelector("output").textContent'), printable, '完整 US 字符集包含数字、大小写、空格和标点')
    await guest.executeJavaScript('events.length=0')
    const unsupported = await run('keyboard', 'await browser.type({text:"prefix中文",mode:"keys"});')
    assert.equal(unsupported.isError, true)
    assert.match(unsupported.text, /Unicode/)
    assert.deepEqual(await guest.executeJavaScript('events'), [], '完整校验后才发送，不能输入一半再发现不支持')
    assert.equal((await run('keyboard', 'await browser.press({key:"toString"});')).isError, true, '未知按键不从对象原型取值')

    const controller = new AbortController()
    const send = guest.debugger.sendCommand.bind(guest.debugger)
    let entered
    const down = new Promise(resolve => { entered = resolve })
    let release
    const paused = new Promise(resolve => { release = resolve })
    guest.debugger.sendCommand = async (method, args) => {
      const value = await send(method, args)
      if (method === 'Input.dispatchKeyEvent' && args.type === 'keyDown' && args.key === 'Control') { entered(); await paused }
      return value
    }
    try {
      const running = run('keyboard', 'await browser.press({key:"Control+a"});', controller.signal)
      await down
      controller.abort(new Error('cancel keyboard'))
      release()
      assert.equal((await running).isError, true)
      await until(async () => (await guest.executeJavaScript('events')).some(event => event.type === 'keyup' && event.key === 'Control'), 'cancelled modifier released')
      assert.deepEqual((await guest.executeJavaScript('events')).map(event => [event.type,event.key]), [['keydown','Control'],['keyup','Control']])
    } finally { release(); guest.debugger.sendCommand = send }
    await execute('await browser.press({key:"b"});')
    assert.equal((await guest.executeJavaScript('events')).at(-1).control, false)
    await guest.executeJavaScript('events.length=0; document.querySelector("canvas").onkeydown=e=>{if(e.key==="Tab")e.preventDefault()}; null')
    await execute('await browser.type({text:"line\\r\\nnext\\t",mode:"keys"});')
    assert.deepEqual((await guest.executeJavaScript('events')).filter(event => event.type === 'keydown').map(event => event.key),
      ['l','i','n','e','Enter','n','e','x','t','Tab'], 'Windows 换行只发送一个 Enter，制表符发送 Tab')
    await guest.executeJavaScript('document.querySelector("canvas").removeAttribute("tabindex"); document.activeElement.blur(); events.length=0; null')
    await execute('const r=await browser.evaluate({expression:\'document.querySelector("canvas").getBoundingClientRect().toJSON()\'}); await browser.click({x:r.x+20,y:r.y+20}); await browser.type({text:"body",mode:"keys"});')
    const bodyInput = (await guest.executeJavaScript('events')).filter(event => event.type === 'keypress')
    assert.equal(bodyInput.map(event => event.key).join(''), 'body')
    assert.ok(bodyInput.every(event => event.target === 'BODY' && event.trusted), '不可聚焦画布由 document/body 接收按键，不要求伪造输入框')
  } finally { await finish('keyboard') }
}
