import { isBrowserUrl } from '../shared/browser.ts'

export function browserRequestAllowed(value: string, applicationUrl?: string): boolean {
  try {
    const url = new URL(value)
    if (['about:', 'data:', 'blob:'].includes(url.protocol)) return true
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) return false
    if (!applicationUrl) return true
    const application = new URL(applicationUrl)
    const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host)
    return url.port !== application.port || (url.hostname !== application.hostname
      && !(loopback(url.hostname) && loopback(application.hostname)))
  } catch { return false }
}

export function browserNavigationAllowed(value: string, applicationUrl?: string): boolean {
  return (value === 'about:blank' || value.startsWith('about:blank#') || isBrowserUrl(value))
    && browserRequestAllowed(value, applicationUrl)
}

/** 挂载参数来自 DOM；只保留原生弹窗派发标记，其余权限由宿主固定。 */
export function browserGuestPreferences(preferences: Record<string, unknown>, partition: string): void {
  const disablePopups = preferences.disablePopups
  for (const key of Object.keys(preferences)) delete preferences[key]
  Object.assign(preferences, { partition, disablePopups,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    webviewTag: false, plugins: false, navigateOnDragDrop: false,
  })
}
