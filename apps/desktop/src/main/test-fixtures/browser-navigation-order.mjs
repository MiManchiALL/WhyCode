import assert from 'node:assert/strict'

export async function checkBrowserNavigationOrder({ guest, guests, id, url, workspaceLookups }) {
  const file = 'file:///C:/workspace/delayed.html'
  const runtime = 'delayed-workspace'
  const currentUrl = `${url}?latest`
  try {
    for (const outcome of ['resolve', 'reject']) {
      const started = Promise.withResolvers(), lookup = Promise.withResolvers()
      workspaceLookups.set(runtime, () => { started.resolve(); return lookup.promise })
      const stale = guests.navigate(id, file, runtime)
      const rejected = assert.rejects(stale, /新的请求替代|旧工作区连接失败/)
      await started.promise
      await guests.navigate(id, currentUrl)
      if (outcome === 'resolve') lookup.resolve(undefined)
      else lookup.reject(new Error('旧工作区连接失败'))
      await rejected
      assert.equal(guest.getURL(), currentUrl, '迟到文件准备不能覆盖新页面')
      assert.equal(guests.loadError(id), undefined, '旧请求失败不能污染新页面的成功状态')
      assert.match(await guest.executeJavaScript('document.body.innerText'), /Article content/)
    }
    const started = Promise.withResolvers(), lookup = Promise.withResolvers()
    const controller = new AbortController()
    workspaceLookups.set(runtime, () => { started.resolve(); return lookup.promise })
    const cancelled = guests.navigate(id, file, runtime, controller.signal)
    const rejected = assert.rejects(cancelled, { name: 'AbortError' })
    await started.promise
    controller.abort()
    lookup.resolve(undefined)
    await rejected
    assert.equal(guest.getURL(), currentUrl, '取消文件准备后不再派发导航')
    assert.equal(guests.loadError(id), undefined, '取消不覆盖原页面的状态')
    await guests.waitForDocument(id, new AbortController().signal)
  } finally { workspaceLookups.delete(runtime) }
}
