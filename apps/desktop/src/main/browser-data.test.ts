import assert from 'node:assert/strict'
import { it } from 'node:test'
import { clearBrowserSession } from './browser-data.ts'

function browserSession() {
  const data = new Set(['cache', 'serviceWorkers', 'cookies', 'localStorage', 'indexedDB', 'fileSystems'])
  let authenticated = true
  let codeCached = true
  const session = {
    async clearData(options?: { dataTypes?: string[] }) {
      for (const key of options?.dataTypes ?? [...data]) data.delete(key)
    },
    async clearCodeCaches() { codeCached = false },
    async clearAuthCache() { authenticated = false },
    async clearHostResolverCache() {},
    async closeAllConnections() {},
  }
  return { session, data, authenticated: () => authenticated, codeCached: () => codeCached }
}

it('轻量清理保留 Cookie、本地存储、数据库和 HTTP 登录；全部清理删除这些数据', async () => {
  const browser = browserSession()
  await clearBrowserSession(browser.session, 'cache')
  assert.deepEqual([...browser.data], ['cookies', 'localStorage', 'indexedDB', 'fileSystems'])
  assert.equal(browser.authenticated(), true)
  assert.equal(browser.codeCached(), false)
  await clearBrowserSession(browser.session, 'all')
  assert.equal(browser.data.size, 0)
  assert.equal(browser.authenticated(), false)
})

it('部分清理失败仍等待其余操作结束才报错，允许用户重试', async () => {
  const browser = browserSession()
  let release!: () => void
  let finished = false
  const pending = new Promise<void>(resolve => { release = resolve })
  browser.session.clearCodeCaches = () => pending
  browser.session.clearData = async () => { throw new Error('disk busy') }
  const operation = clearBrowserSession(browser.session, 'all').finally(() => { finished = true })
  const rejected = assert.rejects(operation, /未完全清理.*disk busy/u)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  assert.equal(browser.authenticated(), false)
  release()
  await rejected
  browser.session.clearData = async () => { browser.data.clear() }
  await clearBrowserSession(browser.session, 'all')
  assert.equal(browser.data.size, 0)
})
