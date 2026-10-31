import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { checkBrowserNavigationOrder } from './browser-navigation-order.mjs'

export async function checkBrowserLoadErrors({ run, finish, execute, until, agent, guests, workspaceLookups }) {
  let recoveredSite = false
  let retryRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/retry') retryRequests++
    if (request.url === '/failed' || (request.url === '/retry' && !recoveredSite)) { response.destroy(); return }
    response.end(`<!doctype html><title>Loaded article</title><article>Article content</article>
      ${request.url === '/frame-failed' ? '<iframe src="/failed"></iframe>' : ''}`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const failedUrl = `${url}failed`
  const read = 'text(await browser.evaluate({expression:"document.body.innerText"}));'
  try {
    const failed = await run('load-error', `await browser.open({url:${JSON.stringify(failedUrl)}}); ${read}`)
    assert.equal(failed.isError, true, '首次加载失败必须返回工具错误，不能成功读取错误页的空正文')
    assert.match(failed.text, /ERR_EMPTY_RESPONSE/)
    assert.ok(failed.text.includes(failedUrl), '保留失败网址')
    assert.match(failed.text, /"operation":"open","status":"failed"/)
    assert.doesNotMatch(failed.text, /"operation":"evaluate"/, 'open 失败后不执行依赖读取')
    const guest = guests.get(agent.pages.current('load-error').surfaceId)
    for (const code of ['await browser.open();', read, 'text(await browser.snapshot());', 'image(await browser.screenshot());']) {
      const result = await run('load-error', code)
      assert.equal(result.isError, true, result.text)
      assert.match(result.text, /ERR_EMPTY_RESPONSE/)
      assert.equal(result.images.length, 0, '加载失败不返回成功的空白截图')
    }
    const recovered = await run('load-error', `await browser.navigate({url:${JSON.stringify(url)}}); ${read}`)
    assert.equal(recovered.isError, false, recovered.text)
    assert.match(recovered.text, /Article content/)
    assert.equal(guests.get(agent.pages.current('load-error').surfaceId), guest, '在同一页导航恢复，不新建网页')

    const navigateFailed = await run('load-error', `await browser.navigate({url:${JSON.stringify(failedUrl)}}); ${read}`)
    assert.equal(navigateFailed.isError, true)
    assert.match(navigateFailed.text, /ERR_EMPTY_RESPONSE/)
    assert.doesNotMatch(navigateFailed.text, /"operation":"evaluate"/)
    const afterFailure = await run('load-error', read)
    assert.equal(afterFailure.isError, true, '后续调用仍须报告主页面失败')
    assert.match(afterFailure.text, /ERR_EMPTY_RESPONSE/)

    const subframe = await run('load-error', `await browser.navigate({url:${JSON.stringify(`${url}frame-failed`)}}); ${read}`)
    assert.equal(subframe.isError, false, subframe.text)
    assert.match(subframe.text, /Article content/, '子框架失败不阻断有效主页面')
    const blank = await run('load-error', 'await browser.navigate({url:"about:blank"}); text(await browser.evaluate({expression:"({title:document.title,bodyText:document.body.innerText})"}));')
    assert.equal(blank.isError, false, blank.text)
    assert.match(blank.text, /"bodyText":""/, '合法空白页仍可读取')
    const retryUrl = `${url}retry`
    assert.equal((await run('load-error', `await browser.navigate({url:${JSON.stringify(retryUrl)}});`)).isError, true)
    const failedRequests = retryRequests
    recoveredSite = true
    assert.equal((await run('load-error', `await browser.open({url:${JSON.stringify(retryUrl)}});`)).isError, true)
    assert.equal(retryRequests, failedRequests, 'open 只复用本轮页面，不隐式重载')
    const retried = await run('load-error', `await browser.navigate({url:${JSON.stringify(retryUrl)}}); ${read}`)
    assert.equal(retried.isError, false, retried.text)
    assert.match(retried.text, /Article content/)
    assert.ok(retryRequests > failedRequests, '同一网址的 navigate 重试必须发出新的请求')
    await checkBrowserNavigationOrder({ guest, guests, id: agent.pages.current('load-error').surfaceId, url, workspaceLookups })
    await finish('load-error')
    assert.equal(guest.isDestroyed(), true)

    const blocked = await run('blocked-url', 'await browser.open({url:"http://127.0.0.1:43123/"});')
    assert.equal(blocked.isError, true)
    assert.match(blocked.text, /不支持此网页地址/, '导航前策略拒绝必须传回模型，不能耗尽就绪等待')
    assert.doesNotMatch(blocked.text, /网页尚未准备好/)
    const unblocked = await run('blocked-url', `await browser.navigate({url:${JSON.stringify(url)}}); ${read}`)
    assert.equal(unblocked.isError, false, unblocked.text)
    assert.match(unblocked.text, /Article content/)
    await finish('blocked-url')

    await execute('fixture.session("file-unavailable")')
    await until(() => execute('fixture.state().tabs.length===0'), 'file workspace selected')
    const fileDriver = agent.forRuntime('file-unavailable')
    const fileContext = { turnId: 'file-failed', toolCallId: 'file-failed', abortSignal: new AbortController().signal }
    const fileFailed = await fileDriver.execute('await browser.open({url:"file:///C:/workspace/article.html"});', fileContext)
    assert.equal(fileFailed.isError, true)
    assert.match(fileFailed.text, /工作区连接不可用/, '文件准备错误必须传回模型，不能等 did-fail-load')
    assert.doesNotMatch(fileFailed.text, /网页尚未准备好/)
    const fileRecovered = await fileDriver.execute(`await browser.navigate({url:${JSON.stringify(url)}}); ${read}`, fileContext)
    assert.equal(fileRecovered.isError, false, fileRecovered.text)
    assert.match(fileRecovered.text, /Article content/)
    await finish('file-failed')
    await execute('fixture.session("alpha")')
    await until(() => execute('fixture.state().tabs.length===0'), 'return to default workspace')

    await execute(`fixture.open(${JSON.stringify(failedUrl)})`)
    await until(() => execute('Array.from(document.querySelectorAll("[aria-label=\'内置浏览器\'] button")).some(button=>button.textContent==="重新加载")'), 'failed user page')
    const userPage = agent.pages.list('alpha')[0]
    const claimed = await run('claim-failed', `await browser.open({url:${JSON.stringify(failedUrl)}}); ${read}`)
    assert.equal(claimed.isError, true, '接管已有失败用户页时仍能获取此前的导航错误')
    assert.match(claimed.text, /ERR_EMPTY_RESPONSE/)
    assert.equal(agent.pages.current('claim-failed').surfaceId, userPage.id)
    await execute('fixture.visible(false)')
    await until(() => !agent.pages.list('alpha').some(page => page.active), 'failed page hidden')
    await finish('claim-failed')
    await execute('fixture.session("alpha")')
    await until(() => execute('fixture.state().tabs.length===0'), 'load error fixture reset')
  } finally {
    await finish('load-error')
    await finish('claim-failed')
    await finish('blocked-url')
    await finish('file-failed')
    await new Promise(resolve => server.close(resolve))
  }
}
