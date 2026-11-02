import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function checkBrowserPopups({ directory, workspaceLookups, run, finish, execute, until, agent, guests }) {
  const server = createServer((request, response) => {
    response.end(request.url === '/child'
      ? '<!doctype html><title>Popup</title><h1>Popup content</h1><button onclick="this.textContent=\'Clicked\'">Child action</button>'
      : '<!doctype html><title>Parent</title><input aria-label="Draft"><button onclick="document.body.dataset.blocked=String(!window.open(\'/child\'))">Open popup</button>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const tabFor = async url => execute(`fixture.state().tabs.find(tab=>tab.page.url===${JSON.stringify(url)}).id`)
  try {
    const opened = await run('popups', `await browser.open({url:${JSON.stringify(url)}}); await browser.evaluate({expression:'document.querySelector("input").value="parent-draft"'});`)
    assert.equal(opened.isError, false, opened.text)
    const parentId = agent.pages.current('popups').surfaceId, parent = guests.get(parentId)
    const launched = await run('popups', 'const s=await browser.snapshot(); text(s); await browser.click({ref:s.nodes.find(n=>n.role==="button").ref});')
    assert.equal(launched.isError, false, launched.text)
    assert.match(launched.text, /parent-draft/)
    const reported = JSON.parse(launched.text.split('网页状态：')[1])
    assert.equal(reported.newPages.length, 1, '点击结果直接报告新页面')
    const childPage = reported.newPages[0], childId = childPage.id
    assert.equal(childPage.url, url + 'child')
    assert.equal(childPage.agent, false, '新页面在模型接管前属于普通标签')
    assert.equal(childPage.selected, false)
    assert.equal(childPage.openerId, parentId)
    assert.equal(reported.selectedPageId, parentId, '弹窗不隐式改变脚本操作目标')
    await until(() => guests.get(childId)?.getURL() === url + 'child', 'child loaded')
    const child = guests.get(childId)
    assert.equal(parent.getURL(), url)
    assert.equal(await parent.executeJavaScript('document.querySelector("input").value'), 'parent-draft')
    assert.equal(await parent.executeJavaScript('document.body.dataset.blocked'), 'true', '现有受管弹窗仍不伪造原生 WindowProxy')
    await until(() => execute('fixture.state().tabs.length===2'), 'two independently stored tabs')
    const parentTab = await tabFor(url), childTab = await tabFor(url + 'child')
    await execute(`fixture.select(${JSON.stringify(childTab)}); fixture.visible(true)`)
    await until(() => agent.pages.list('alpha').find(page => page.id === childId)?.active, 'ordinary popup visible')
    assert.equal(await execute('!!document.querySelector(\'[aria-label="内置浏览器"] [aria-label="Agent 正在操作此网页"]\')'), false)
    const claimed = await run('popups', `await browser.open({id:${JSON.stringify(childId)}}); const s=await browser.snapshot(); await browser.click({ref:s.nodes.find(n=>n.role==="button").ref});`)
    assert.equal(claimed.isError, false, claimed.text)
    assert.equal(await child.executeJavaScript('document.querySelector("button").textContent'), 'Clicked')
    const sourceRef = JSON.parse(launched.text.split('\n')[0]).nodes.find(node => node.role === 'button').ref
    const wrongPage = await run('popups', `await browser.click({ref:${JSON.stringify(sourceRef)}});`)
    assert.equal(wrongPage.isError, true, '两个页面的首个快照引用也不能相互命中')
    assert.match(wrongPage.text, /元素引用已失效/)
    assert.equal(agent.pages.list('alpha').filter(page => page.agent).length, 2, '同一轮可同时接管两个独立标签')
    await parent.executeJavaScript('document.title="Updated parent"')
    await until(() => execute(`fixture.state().tabs.find(tab=>tab.id===${JSON.stringify(parentTab)}).page.title==="Updated parent"`), 'parent title persisted separately')
    assert.equal(await execute(`fixture.state().tabs.find(tab=>tab.id===${JSON.stringify(childTab)}).page.url`), url + 'child')

    await execute(`fixture.closeId(${JSON.stringify(parentTab)})`)
    await until(() => execute('!!document.querySelector(\'[role="alertdialog"]\')'), 'specific page close confirmation')
    await execute('Array.from(document.querySelectorAll(\'[role="alertdialog"] button\')).find(b=>b.textContent==="停止并继续").click()')
    await until(() => parent.isDestroyed(), 'parent destroyed')
    assert.equal(child.isDestroyed(), false, '关闭 A 不释放 B')
    const continued = await run('popups', 'text(await browser.snapshot()); image(await browser.screenshot());')
    assert.equal(continued.isError, false, continued.text)
    assert.match(continued.text, /Clicked/)
    const closed = await run('popups', `await browser.open({id:${JSON.stringify(parentId)}});`)
    assert.equal(closed.isError, true)
    assert.match(closed.text, /user_closed/)
    assert.equal((await run('popups', 'text(await browser.snapshot());')).isError, false, '访问已关闭的 A 失败后仍可操作 B')

    await child.executeJavaScript('window.open("/child"); null')
    await until(() => agent.pages.list('alpha').length === 2, 'asynchronous popup')
    const later = await run('popups', 'text(await browser.tabs());')
    const newPages = JSON.parse(later.text.split('网页状态：')[1]).newPages
    assert.equal(newPages.length, 1)
    assert.equal(newPages[0].openerId, childId)
    assert.equal(newPages[0].agent, false)
    const unchanged = await run('popups', 'text(await browser.tabs());')
    assert.deepEqual(JSON.parse(unchanged.text.split('网页状态：')[1]).newPages, [], '已报告的页面不反复提示新增')
    await execute('fixture.visible(false)')
    await finish('popups')
    assert.equal(child.isDestroyed(), false)
    assert.equal(agent.pages.list('alpha').length, 2)
    assert.equal(agent.pages.list('alpha').some(page => page.agent), false, '收起侧栏也交还全部标签')

    await execute('fixture.session("alpha")')
    const parentFile = path.join(directory, 'popup-local.html'), childFile = path.join(directory, 'popup-child.html')
    await writeFile(parentFile, '<!doctype html><button onclick="window.open(\'popup-child.html\')">Local popup</button>')
    await writeFile(childFile, '<!doctype html><h1>Local child</h1>')
    const priorLookup = workspaceLookups.get('alpha')
    workspaceLookups.set('alpha', () => { throw new Error('普通本机弹窗不能使用会话工作区') })
    try {
      await execute(`fixture.open(${JSON.stringify(pathToFileURL(parentFile).href)})`)
      await until(() => agent.pages.list('alpha').some(page => guests.get(page.id)), 'local source ready')
      const source = guests.get(agent.pages.list('alpha')[0].id)
      await until(() => source.executeJavaScript('!!document.querySelector("button")'), 'local source document')
      await source.executeJavaScript('document.querySelector("button").click()')
      await until(() => agent.pages.list('alpha').length === 2, 'local popup tab')
      const child = agent.pages.list('alpha').find(page => page.openerId)
      await until(() => guests.get(child.id)?.getTitle() === pathToFileURL(childFile).href
        || guests.get(child.id)?.getURL().includes('popup-child.html'), 'local child navigation')
      assert.equal(await guests.get(child.id).executeJavaScript('document.querySelector("h1")?.textContent'), 'Local child', '普通本机弹窗继承本机文件作用域')
    } finally {
      if (priorLookup) workspaceLookups.set('alpha', priorLookup)
      else workspaceLookups.delete('alpha')
    }
  } finally {
    await finish('popups')
    await execute('fixture.session("alpha")')
    await new Promise(resolve => server.close(resolve))
  }
}
