import assert from 'node:assert/strict'

/** 真实 Chromium 验证视口、滚动容器、遮挡与系统文件框，不访问外部站点。 */
export async function checkBrowserObservation(run, guest) {
  await guest.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', \`<section id="observation">
    <button aria-label="Attach" onclick="document.body.dataset.attached='clicked';document.getElementById('upload').click()">+</button><input id="upload" type="file" hidden oncancel="document.body.dataset.chooser='cancelled'">
    <button style="display:none">Display hidden</button><button style="visibility:hidden">Visibility hidden</button>
    <div style="opacity:0"><button>Transparent parent</button></div>
    <div style="height:25px;overflow:hidden"><div style="height:80px"></div><button>Clipped item</button></div>
    <div style="position:relative;width:140px;height:40px"><button>Covered item</button><div style="position:absolute;inset:0;background:black"></div></div>
    <button style="position:absolute;top:1600px">Offscreen item</button>
    <button disabled>Disabled item</button>
    <div style="position:absolute;top:2000px">${'<p>Offscreen history</p>'.repeat(250)}</div>
  </section>\`)`)
  const snapshot = await run('one', 'text(await browser.snapshot());')
  assert.equal(snapshot.isError, false, snapshot.text)
  const observation = JSON.parse(snapshot.text.split('\n')[0])
  for (const name of ['Display hidden', 'Visibility hidden', 'Transparent parent', 'Clipped item', 'Covered item', 'Offscreen item', 'Offscreen history']) {
    assert.ok(!observation.nodes.some(node => node.name === name), `${name} 不进入可见快照`)
  }
  assert.ok(observation.nodes.some(node => node.name === 'Attach' && node.role === 'button' && node.bounds && node.point && node.tag === 'button'))
  assert.deepEqual(observation.viewport, { width: 1280, height: 800 })
  const disabled = await run('one', 'const s=await browser.snapshot(); await browser.click({ref:s.nodes.find(n=>n.name==="Disabled item"&&n.role==="button").ref});')
  assert.equal(disabled.isError, true)
  assert.match(disabled.text, /元素不可用/)
  const attachment = await run('one', 'const s=await browser.snapshot(); await browser.click({ref:s.nodes.find(n=>n.name==="Attach"&&n.role==="button").ref});')
  assert.equal(attachment.isError, true, attachment.text)
  assert.match(attachment.text, /文件选择器.*已取消选择/)
  assert.equal(await guest.executeJavaScript('document.body.dataset.chooser'), 'cancelled', 'Chromium 真正取消文件选择')
  assert.equal(await guest.executeJavaScript('document.querySelector("#upload").files.length'), 0)
  const after = await run('one', 'text(await browser.snapshot());')
  assert.equal(after.isError, false, '文件选择事件不污染后续操作')
  const offscreen = await run('one', 'await browser.scroll({y:1400}); text(await browser.snapshot());')
  assert.equal(offscreen.isError, false, offscreen.text)
  assert.match(offscreen.text, /Offscreen item/)
  const stale = await run('one', 'const s=await browser.snapshot(); await browser.scroll({y:-1400}); await browser.click({ref:s.nodes.find(n=>n.name==="Offscreen item"&&n.role==="button").ref});')
  assert.equal(stale.isError, true)
  assert.match(stale.text, /不在可见视口内或被遮挡/)
  const outside = await run('one', 'await browser.click({x:100,y:928});')
  assert.equal(outside.isError, true)
  assert.match(outside.text, /1280×800/)
  await guest.executeJavaScript('document.getElementById("observation").remove()')
}
