export const BROWSER_PARTITION = 'persist:whycode-browser'
// 12 个侧栏入口可以同时各有一份用户网页和一份本轮 Agent 网页。
export const MAX_BROWSER_GUESTS = 24
export const BROWSER_FILE_SCHEME = 'whycode-browser-file'
export const MAX_BROWSER_DATA_URL_LENGTH = 1024 * 1024

export interface BrowserLease { id: string; partition: string }
export type BrowserDataClearMode = 'cache' | 'all'
export interface BrowserDataState { clearing: BrowserDataClearMode | null }
export type BrowserShortcut = 'address' | 'find' | 'reload' | 'reload-clean' | 'back' | 'forward'
  | 'new-tab' | 'close-tab' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'escape'
export type BrowserEventPayload =
  | { type: 'open'; url: string }
  | { type: 'shortcut'; command: BrowserShortcut }
  | { type: 'notice'; message: string; error: boolean }
export type BrowserEvent = { id: string } & BrowserEventPayload

export function browserAddress(input: string): string {
  let text = input.trim()
  if (!text || text === 'about:blank') return 'about:blank'
  const path = text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
  if (/^(?:\\\\|\/\/)/u.test(path)) throw new Error('暂不支持网络共享路径')
  if (/^[a-z]:[\\/]/iu.test(path) || /^\/(?!\/)/u.test(path)) {
    const url = new URL('file:///')
    url.pathname = path.replaceAll('\\', '/').replaceAll('%', '%25')
    text = url.href
  }
  const limit = /^data:/iu.test(text) ? MAX_BROWSER_DATA_URL_LENGTH : 8192
  if (text.length > limit) throw new Error('地址内容过长，请改为打开文件')
  if (/^[a-z][a-z\d+.-]*:/iu.test(text) && !/^[^\s/:]+:\d+(?:\/|$)/u.test(text)) {
    if (!isBrowserUrl(text)) throw new Error('支持 HTTP、HTTPS、本机 file:、data: 和 about:blank 地址')
    const url = new URL(text).href
    if (url.length > limit) throw new Error('地址内容过长，请改为打开文件')
    return url
  }
  if (!/\s/u.test(text) && /^(?:localhost|\[[\da-f:]+\]|[^/]+[.:][^/]*)(?:\/|$)/iu.test(text)) {
    const local = /^(?:localhost|127\.|\[::1\]|[^/]+:\d+(?:\/|$))/iu.test(text)
    const url = `${local ? 'http' : 'https'}://${text}`
    if (!isBrowserUrl(url)) throw new Error('网址无效，请检查后重试')
    return new URL(url).href
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}

export function isBrowserUrl(value: string): boolean {
  if (value.length > MAX_BROWSER_DATA_URL_LENGTH) return false
  try {
    const url = new URL(value)
    if (url.username || url.password || /[\u0000-\u001f\u007f]/u.test(value)) return false
    if (url.protocol === 'data:') return url.pathname.includes(',')
    if (value.length > 8192) return false
    if (url.protocol === 'about:') return url.pathname === 'blank' && !url.search
    if (url.protocol === 'file:') return !url.hostname && !url.pathname.startsWith('//')
    return ['http:', 'https:'].includes(url.protocol) && !/[\u0020\\]/u.test(value)
  } catch { return false }
}

/** 本地页面实际使用隔离 origin，地址栏与标签记录仍保留用户的文件地址。 */
export function browserDisplayUrl(value: string): string {
  if (!value.startsWith(`${BROWSER_FILE_SCHEME}:`)) return value
  const url = new URL(value)
  return `file://${url.pathname}${url.search}${url.hash}`
}

export function isExternalBrowserUrl(value: string): boolean {
  return /^https?:/u.test(value) && isBrowserUrl(value)
}

export function browserShortcut(input: {
  key: string; control?: boolean; meta?: boolean; alt?: boolean; shift?: boolean; isComposing?: boolean
}): BrowserShortcut | null {
  if (input.isComposing) return null
  const key = input.key.toLowerCase()
  if (key === 'escape') return 'escape'
  if (key === 'f5') return input.control || input.shift ? 'reload-clean' : 'reload'
  if (input.alt && !input.control && !input.meta) {
    return key === 'arrowleft' ? 'back' : key === 'arrowright' ? 'forward' : null
  }
  if ((!input.control && !input.meta) || input.alt) return null
  if (key === 'r') return input.shift ? 'reload-clean' : 'reload'
  if (key === '+' || key === '=') return 'zoom-in'
  if (key === '-') return 'zoom-out'
  if (key === '0') return 'zoom-reset'
  if (input.shift) return null
  switch (key) {
    case 'l': return 'address'
    case 'f': return 'find'
    case 't': return 'new-tab'
    case 'w': return 'close-tab'
    default: return null
  }
}
