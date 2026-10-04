import type { Session } from 'electron'
import type { BrowserDataClearMode } from '../shared/browser.ts'

type BrowserSession = Pick<Session, 'clearData' | 'clearCodeCaches' | 'clearAuthCache'
  | 'clearHostResolverCache' | 'closeAllConnections'>

export async function clearBrowserSession(browser: BrowserSession, mode: BrowserDataClearMode): Promise<void> {
  // cache 同时覆盖 HTTP、Cache Storage、着色器与共享字典缓存，保留承载登录的网站存储。
  const operations = [
    browser.clearData(mode === 'cache' ? { dataTypes: ['cache', 'serviceWorkers'] } : undefined),
    browser.clearCodeCaches({}),
  ]
  if (mode === 'all') operations.push(
    browser.clearAuthCache(), browser.clearHostResolverCache(), browser.closeAllConnections(),
  )
  // 所有清理都结束后才释放操作锁；部分失败仍尝试清理其余数据，并明确报告失败。
  const results = await Promise.allSettled(operations)
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new Error(`浏览器数据未完全清理，请重试：${failures.map(result =>
    result.reason instanceof Error ? result.reason.message : String(result.reason)).join('；')}`)
}
