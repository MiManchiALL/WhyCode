import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export async function checkBrowserPopups({ run, finish, execute, until, agent, guests }) {
  const server = createServer((request, response) => {
    response.end(request.url === '/child'
      ? '<!doctype html><title>Popup</title><h1>Popup content</h1><button onclick="this.textContent=\'Clicked\'">Child action</button>'
      : '<!doctype html><title>Parent</title><input aria-label="Draft"><button onclick="window.open(\'/child\')">Open popup</button>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const launch = async turnId => {
    await execute('fixture.session("alpha")')
    const opened = await run(turnId, `await browser.open({url:${JSON.stringify(url)}}); await browser.evaluate({expression:'document.querySelector("input").value="parent-draft"'});`)
    assert.equal(opened.isError, false, opened.text)
    const parentId = agent.pages.current(turnId).surfaceId, parent = guests.get(parentId)
    const launched = await run(turnId, 'const s=await browser.snapshot(); await browser.click({ref:s.nodes.find(n=>n.role==="button").ref}); text(await browser.snapshot());')
    assert.equal(launched.isError, false, launched.text)
    assert.match(launched.text, /Popup content/)
    const childId = agent.pages.current(turnId).surfaceId, child = guests.get(childId)
    assert.notEqual(childId, parentId)
    assert.equal(parent.getURL(), url, '弹窗不能导航或卸载发起页')
    assert.equal(await parent.executeJavaScript('document.querySelector("input").value'), 'parent-draft')
    assert.equal(agent.pages.list('alpha').length, 2)
    return { parentId, parent, childId, child }
  }
  try {
    const visible = await launch('popup-visible')
    await execute('fixture.visible(true)')
    await until(() => agent.pages.list('alpha').find(p => p.id === visible.childId)?.active, 'popup is visible')
    assert.equal(await execute('fixture.display().tabs.length'), 1, '父子页沿用一个侧栏入口')
    await visible.parent.executeJavaScript('document.title="Updated parent"')
    await until(() => agent.pages.list('alpha').find(p => p.id === visible.parentId)?.title === 'Updated parent', 'parent title published')
    assert.equal(await execute('fixture.display().tabs[0].page.url'), url + 'child', '后台父页更新不能覆盖当前子页的地址')
    const selected = await run('popup-visible', `await browser.open({id:${JSON.stringify(visible.parentId)}}); text(await browser.evaluate({expression:'document.querySelector("input").value'})); await browser.open({id:${JSON.stringify(visible.childId)}}); const s=await browser.snapshot(); await browser.click({ref:s.nodes.find(n=>n.role==="button").ref});`)
    assert.equal(selected.isError, false, selected.text)
    assert.match(selected.text, /parent-draft/)
    assert.equal(await visible.child.executeJavaScript('document.querySelector("button").textContent'), 'Clicked', '切页后输入协议绑定到所选网页')
    await finish('popup-visible')
    assert.equal(visible.child.isDestroyed(), false)
    assert.equal(visible.parent.isDestroyed(), false, '交还子页时保留其依赖的发起页')
    const handedBack = agent.pages.list('alpha')
    assert.equal(handedBack.length, 1, '后台依赖页不作为独立用户页供接管')
    assert.equal(handedBack[0].id, visible.childId)
    assert.equal(handedBack[0].agent, false)
    assert.equal((await run('popup-reclaim', `await browser.open({id:${JSON.stringify(handedBack[0].id)}}); text(await browser.snapshot());`)).isError, false)
    assert.equal(agent.pages.list('alpha').length, 2, '再次接管时一并接管父页生命周期')
    await finish('popup-reclaim')
    await execute('fixture.close()')
    await until(() => visible.child.isDestroyed() && visible.parent.isDestroyed(), 'closing entry releases popup family')

    const selectedParent = await launch('popup-parent-visible')
    await execute('fixture.visible(true)')
    assert.equal((await run('popup-parent-visible', `await browser.open({id:${JSON.stringify(selectedParent.parentId)}});`)).isError, false)
    await until(() => agent.pages.list('alpha').find(p => p.id === selectedParent.parentId)?.active, 'parent selected for handback')
    await finish('popup-parent-visible')
    assert.equal(selectedParent.child.isDestroyed(), true)
    assert.equal(selectedParent.parent.isDestroyed(), false, '回收子页不能释放正在交还的父页')
    assert.equal(agent.pages.list('alpha')[0].id, selectedParent.parentId)
    await execute('fixture.close()')
    await until(() => selectedParent.parent.isDestroyed(), 'handed-back parent released')

    const hidden = await launch('popup-hidden')
    await finish('popup-hidden')
    assert.equal(hidden.child.isDestroyed(), true)
    assert.equal(hidden.parent.isDestroyed(), true, '隐藏弹窗随本轮完整释放')

    const personal = await launch('popup-personal')
    await execute('fixture.visible(true)')
    await until(() => execute('!!document.querySelector(\'[aria-label="切换到我的网页"]\')'), 'popup switch ready')
    await execute('document.querySelector(\'[aria-label="切换到我的网页"]\').click()')
    await until(() => agent.pages.list('alpha').some(p => !p.agent && guests.get(p.id)?.getURL() === url + 'child'), 'personal popup copy')
    const user = guests.get(agent.pages.list('alpha').find(p => !p.agent).id)
    await finish('popup-personal')
    assert.equal(personal.child.isDestroyed(), true)
    assert.equal(personal.parent.isDestroyed(), false, '用户视图仍依赖父页时保留父页')
    assert.equal(user.isDestroyed(), false)
    await execute('fixture.close()')
    await until(() => user.isDestroyed() && personal.parent.isDestroyed(), 'personal popup dependencies released')

    const stopped = await launch('popup-stopped')
    await execute('fixture.visible(true)')
    await until(() => agent.pages.list('alpha').find(p => p.id === stopped.childId)?.active, 'stoppable popup visible')
    await execute('fixture.close()')
    await until(() => execute('!!document.querySelector(\'[role="alertdialog"]\')'), 'popup close confirmation')
    await execute('Array.from(document.querySelectorAll(\'[role="alertdialog"] button\')).find(b=>b.textContent==="停止并继续").click()')
    await until(() => stopped.child.isDestroyed() && stopped.parent.isDestroyed(), 'stop releases all turn pages')
    const ended = await run('popup-stopped', 'text(await browser.snapshot());')
    assert.match(ended.text, /user_closed/)
  } finally {
    for (const turnId of ['popup-visible', 'popup-reclaim', 'popup-parent-visible', 'popup-hidden', 'popup-personal', 'popup-stopped']) await finish(turnId)
    await execute('fixture.session("alpha")')
    await new Promise(resolve => server.close(resolve))
  }
}
