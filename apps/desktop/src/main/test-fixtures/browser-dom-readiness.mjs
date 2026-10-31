import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export async function checkBrowserDomReadiness({ run, finish, agent, guests, until }) {
  const pending = new Set(), requests = new Map()
  const hold = name => {
    const received = Promise.withResolvers()
    requests.set(name, received)
    return received.promise
  }
  const article = name => `<!doctype html><title>${name}</title><article>${name} content</article>`
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (requests.has(request.url)) {
      pending.add(response)
      response.once('close', () => pending.delete(response))
      requests.get(request.url).resolve(response)
      requests.delete(request.url)
      return
    }
    if (request.url === '/dynamic') {
      response.end(`${article('Shell')}<main></main><script>
        fetch('/data').then(r=>r.text()).then(text=>document.querySelector('main').textContent=text)
      </script>`)
      return
    }
    response.end(`${article(request.url)}<img src="/image${request.url}">`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const navigation = path => `text(await browser.navigate({url:${JSON.stringify(url + path)}}));`
  const read = 'text(await browser.evaluate({expression:"document.querySelector(\'article\').textContent"}));'
  const unhandled = []
  const rejected = error => unhandled.push(error)
  process.on('unhandledRejection', rejected)
  try {
    // 子资源始终不结束：只有放开全资源等待，正文、快照和截图才能在这里完成。
    const firstImage = hold('/image/first')
    const first = await run('dom-ready', `text(await browser.open({url:${JSON.stringify(`${url}/first`)}}));
      ${read} text(await browser.snapshot()); image(await browser.screenshot());`)
    assert.equal(first.isError, false, first.text)
    assert.match(first.text, /\/first content/)
    assert.match(first.text, /"loading":true/)
    assert.equal(first.images.length, 1)
    const id = agent.pages.current('dom-ready').surfaceId, guest = guests.get(id)
    assert.equal(guest.isLoading(), true, '主文档可读时，图片仍在加载')
    await firstImage

    const nextImage = hold('/image/next')
    const next = await run('dom-ready', `${navigation('/next')} ${read}`)
    assert.equal(next.isError, false, next.text)
    assert.match(next.text, /"loading":true/)
    assert.match(next.text, /\/next content/)
    await nextImage
    assert.equal(guests.loadError(id), undefined, '旧 loadURL 的迟到中断不污染新文档')
    // 停止剩余图片加载后，已就绪的当前文档继续可用。
    guest.stop()
    await until(() => !guest.isLoading(), 'resource loading stopped')
    const afterStop = await run('dom-ready', read)
    assert.equal(afterStop.isError, false, afterStop.text)

    // 旧页面已 complete，新目标尚未提交：不能把旧 DOM 的状态当作本轮就绪。
    const old = await guest.debugger.sendCommand('Runtime.evaluate', {
      expression: '({ready:document.readyState,text:document.querySelector("article").textContent})', returnByValue: true,
    })
    assert.deepEqual(old.result.value, { ready: 'complete', text: '/next content' })
    const received = hold('/delayed')
    let settled = false
    const delayed = run('dom-ready', `${navigation('/delayed')} ${read}`).then(result => { settled = true; return result })
    const response = await received
    assert.equal(guest.getURL(), `${url}/next`, '目标响应未返回时仍是旧文档')
    assert.equal(settled, false, '新文档提交前不返回旧页面的成功结果')
    response.end(article('New document'))
    const loaded = await delayed
    assert.equal(loaded.isError, false, loaded.text)
    assert.match(loaded.text, /New document content/)
    assert.doesNotMatch(loaded.text, /\/next content/)

    const hash = await run('dom-ready', `${navigation('/delayed#section')} ${read}`)
    assert.equal(hash.isError, false, hash.text)
    assert.match(hash.text, /New document content/, '同文档锚点导航不等待新的 dom-ready')

    // 资源已加载并不代表业务数据齐全；等待实际 DOM 条件后再读取。
    const data = hold('/data')
    const dynamic = await run('dom-ready', navigation('/dynamic'))
    assert.equal(dynamic.isError, false, dynamic.text)
    const dataResponse = await data
    const checked = Promise.withResolvers()
    const observe = (_event, method, params) => {
      if (method === 'Runtime.consoleAPICalled' && params.args?.[0]?.value === 'condition checked') checked.resolve()
    }
    guest.debugger.on('message', observe)
    await guest.debugger.sendCommand('Runtime.enable')
    const condition = '(console.debug("condition checked"), document.querySelector("main")?.textContent === "Async article")'
    let matched = false
    const waiting = run('dom-ready', `text(await browser.wait({expression:${JSON.stringify(condition)}}));
      text(await browser.evaluate({expression:'document.querySelector("main").textContent'}));`)
      .then(result => { matched = true; return result })
    await Promise.race([checked.promise, waiting.then(result => { throw new Error(`未检查条件就结束：${result.text}`) })])
    assert.equal(matched, false, '已出现的页面外壳不能满足正文条件')
    dataResponse.end('Async article')
    const populated = await waiting
    guest.debugger.removeListener('message', observe)
    assert.equal(populated.isError, false, populated.text)
    assert.match(populated.text, /"matched":true/)
    assert.match(populated.text, /Async article/)
    for (const expression of ['document.title', 'new Promise(() => {})']) {
      const invalid = await run('dom-ready', `await browser.wait({expression:${JSON.stringify(expression)}});`)
      assert.equal(invalid.isError, true)
      assert.match(invalid.text, /必须返回布尔值/, '条件同步返回布尔值，不能被未完成的 Promise 挂起')
    }
    const expired = await run('dom-ready', 'await browser.wait({expression:"false",timeoutMs:50});')
    assert.equal(expired.isError, true)
    assert.match(expired.text, /等待网页条件超时/)

    // 启动空白文档也不能代替尚未到达的目标页面。
    const initialResponse = hold('/initial-delayed')
    let opened = false
    const initial = run('dom-initial', `await browser.open({url:${JSON.stringify(`${url}/initial-delayed`)}}); ${read}`)
      .then(result => { opened = true; return result })
    const initialTarget = await initialResponse
    assert.equal(opened, false)
    initialTarget.end(article('Initial target'))
    const initialResult = await initial
    assert.equal(initialResult.isError, false, initialResult.text)
    assert.match(initialResult.text, /Initial target content/)
    await finish('dom-initial')
    await finish('dom-ready')
    assert.deepEqual(unhandled, [], '提前返回 DOM 就绪后仍消费所有底层 loadURL 拒绝')
  } finally {
    await finish('dom-initial')
    await finish('dom-ready')
    process.removeListener('unhandledRejection', rejected)
    for (const response of pending) response.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
