import type { BrowserWindow } from 'electron'

export function installExternalWebLinkHandlers(
  window: BrowserWindow,
  openExternal: (url: string) => Promise<void>,
  reportError: (error: unknown) => void,
): void {
  const open = (url: string) => {
    const target = normalizeExternalWebUrl(url)
    if (target) void openExternal(target).catch(reportError)
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    open(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    open(url)
  })
}

export function normalizeExternalWebUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}
