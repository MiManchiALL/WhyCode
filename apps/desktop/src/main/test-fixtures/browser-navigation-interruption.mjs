import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export async function checkBrowserNavigationInterruption({ directory, run, finish, execute, until, agent, guests }) {
  const pending = new Set()
  let waiting
  const server = createServer((request, response) => {
    if (request.url === '/slow') { pending.add(response); response.once('close', () => pending.delete(response)); waiting?.(); return }
    if (request.url === '/redirect') {
      pending.add(response); response.once('close', () => pending.delete(response))
      response.write('<!doctype html><head><script>location.replace("/article")</script></head>')
      return
    }
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.txt"' })
      response.end('download fixture'); return
    }
    response.end('<!doctype html><title>Navigation target</title><article>Target article</article>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const read = 'text(await browser.evaluate({expression:"document.body.innerText"}));'
  const navigate = suffix => `await browser.navigate({url:${JSON.stringify(url + suffix)}}); ${read}`
  const download = (guest, name) => new Promise(resolve => {
    guest.session.once('will-download', (_event, item) => {
      item.setSavePath(path.join(directory, name))
      item.once('done', (_event, state) => resolve(state))
    })
  })
  try {
    const initial = await run('interruption', `await browser.open({url:${JSON.stringify(`${url}/redirect`)}}); ${read}`)
    assert.equal(initial.isError, false, initial.text)
    assert.match(initial.text, /Target article/, '首次打开的脚本跳转正常读取最终页面')
    const id = agent.pages.current('interruption').surfaceId, guest = guests.get(id)
    const redirected = await run('interruption', navigate('/redirect'))
    assert.equal(redirected.isError, false, redirected.text)
    assert.match(redirected.text, /Target article/)
    assert.equal(guest.getURL(), `${url}/article`)

    for (const kind of ['slow', 'download']) {
      const started = Promise.withResolvers()
      waiting = started.resolve
      const downloaded = kind === 'download' ? download(guest, 'navigation-fixture.txt') : undefined
      const result = run('interruption', navigate(`/${kind}`))
      if (kind === 'slow') { await started.promise; guest.stop() }
      const outcome = await result
      assert.equal(outcome.isError, true, '导航未完成不能让模型继续依赖目标页面')
      assert.match(outcome.text, /网页导航未完成/)
      assert.doesNotMatch(outcome.text, /页面加载失败|"operation":"evaluate"/)
      if (downloaded) {
        assert.equal(await downloaded, 'completed')
        assert.equal(await readFile(path.join(directory, 'navigation-fixture.txt'), 'utf8'), 'download fixture')
      }
      await until(() => !guest.isLoading(), 'interrupted navigation settled')
      assert.equal(guests.loadError(id), undefined, '中断不污染仍可使用的页面')
      const current = await run('interruption', read)
      assert.equal(current.isError, false, current.text)
      assert.match(current.text, /Target article/)
    }
    const firstDownload = download(guest, 'initial-download.txt')
    const initialDownload = await run('initial-download', `await browser.open({url:${JSON.stringify(`${url}/download`)}});`)
    assert.equal(initialDownload.isError, true, '没有实际文档时，启动空白页不能代表下载目标已打开')
    assert.match(initialDownload.text, /网页导航未完成/)
    assert.doesNotMatch(initialDownload.text, /网页尚未准备好/)
    assert.equal(await firstDownload, 'completed')
    await finish('initial-download')
    await finish('interruption')

    await execute(`fixture.open(${JSON.stringify(`${url}/article`)})`)
    await until(() => execute('!!document.querySelector("[aria-label=\'内置浏览器\'] [aria-label=\'刷新网页\']")'), 'user page ready')
    const userPage = agent.pages.list('alpha')[0], userGuest = guests.get(userPage.id)
    const submit = suffix => execute(`(() => {
      const input = document.querySelector('[aria-label="内置浏览器"] [aria-label="网址或搜索"]');
      fixture.flush(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url + suffix)}); input.dispatchEvent(new Event('input', {bubbles:true})); });
      input.form.requestSubmit();
    })()`)
    for (const kind of ['redirect', 'slow', 'download']) {
      const started = Promise.withResolvers()
      waiting = started.resolve
      const downloaded = kind === 'download' ? download(userGuest, 'user-navigation-fixture.txt') : undefined
      await submit(`/${kind}`)
      if (kind === 'slow') {
        await started.promise
        await execute('document.querySelector("[aria-label=\'内置浏览器\'] [aria-label=\'停止加载\']").click()')
      }
      if (downloaded) assert.equal(await downloaded, 'completed')
      await until(() => execute('!!document.querySelector("[aria-label=\'内置浏览器\'] [aria-label=\'刷新网页\']")'), 'user navigation settled')
      assert.doesNotMatch(await execute('document.querySelector("[aria-label=\'内置浏览器\']").textContent'), /页面加载失败|ERR_FAILED|ERR_ABORTED|Error invoking/)
      assert.equal(guests.loadError(userPage.id), undefined)
      assert.equal(await execute('document.querySelector("[aria-label=\'内置浏览器\'] [aria-label=\'网址或搜索\']").value'), `${url}/article`)
    }
    await execute('fixture.session("alpha")')
    await until(() => execute('fixture.state().tabs.length===0'), 'interruption fixture reset')
  } finally {
    await finish('initial-download')
    await finish('interruption')
    for (const response of pending) response.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
