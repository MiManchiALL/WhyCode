export const BROWSER_PARTITION = 'persist:whycode-browser'
export const MAX_BROWSER_GUESTS = 12

export interface BrowserLease { id: string; partition: string }
export type BrowserShortcut = 'address' | 'find' | 'reload' | 'reload-clean' | 'back' | 'forward'
  | 'new-tab' | 'close-tab' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'escape'
export type BrowserEventPayload =
  | { type: 'open'; url: string }
  | { type: 'shortcut'; command: BrowserShortcut }
  | { type: 'notice'; message: string; error: boolean }
export type BrowserEvent = { id: string } & BrowserEventPayload

export function browserAddress(input: string): string {
  const text = input.trim()
  if (!text || text === 'about:blank') return 'about:blank'
  if (text.length > 8192) throw new Error('网址过长')
  if (/^[a-z][a-z\d+.-]*:/iu.test(text) && !/^[^\s/:]+:\d+(?:\/|$)/u.test(text)) {
    if (!isBrowserUrl(text)) throw new Error('内置浏览器仅支持 HTTP 和 HTTPS 网址')
    return new URL(text).href
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
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && value.length <= 8192 && !/[\u0000-\u0020\\]/u.test(value)
  } catch { return false }
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
