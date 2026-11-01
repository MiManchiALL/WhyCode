import { randomUUID, X509Certificate } from 'node:crypto'
import type { Certificate, Event, WebContents } from 'electron'
import type { BrowserCertificateError } from '../shared/browser.ts'

export interface BrowserCertificatePage {
  readonly pending: BrowserCertificateError | null
  reset(): void
  trust(id: string): string
  close(): void
}

const overridableErrors = new Set(['ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID'])

/** 仅记录用户确认的站点与证书；不修改 Chromium 或系统的信任库。 */
export class BrowserCertificates {
  private readonly trusted = new Map<string, string>()

  clear(): void { this.trusted.clear() }

  bind(guest: WebContents, notify: (error: BrowserCertificateError | null) => void): BrowserCertificatePage {
    let pending: BrowserCertificateError | null = null
    const reset = () => { if (pending) { pending = null; notify(null) } }
    const started = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (event.isMainFrame && !event.isSameDocument) reset()
    }
    const failed = (event: Event, url: string, error: string, certificate: Certificate,
      callback: (trusted: boolean) => void, mainFrame: boolean) => {
      const code = error.replace(/^net::/u, '')
      if (!overridableErrors.has(code)) return
      const address = new URL(url)
      if (address.protocol !== 'https:' && address.protocol !== 'wss:') return
      const fingerprint = new X509Certificate(certificate.data).fingerprint256
      // 同一设备可通过不同端口提供 HTTPS 与 WSS，仍须匹配用户确认的证书。
      if (this.trusted.get(address.hostname) === fingerprint) {
        event.preventDefault()
        callback(true)
        return
      }
      if (!mainFrame || address.protocol !== 'https:') return
      pending = { id: randomUUID(), url, error: code, fingerprint,
        subjectName: certificate.subjectName, issuerName: certificate.issuerName,
        validStart: certificate.validStart, validExpiry: certificate.validExpiry }
      notify(pending)
      // 当前请求按 Electron 默认行为拒绝；用户确认后重新导航，不悬挂网络回调。
    }
    const close = () => {
      pending = null
      guest.removeListener('certificate-error', failed)
      guest.removeListener('did-start-navigation', started)
      guest.removeListener('destroyed', close)
    }
    guest.on('certificate-error', failed)
    guest.on('did-start-navigation', started)
    guest.once('destroyed', close)
    return { get pending() { return pending }, reset, close, trust: id => {
      if (!pending || pending.id !== id || guest.isDestroyed()) throw new Error('证书确认已失效，请重新加载页面')
      const { url, fingerprint } = pending
      const hostname = new URL(url).hostname
      this.trusted.delete(hostname)
      this.trusted.set(hostname, fingerprint)
      if (this.trusted.size > 64) this.trusted.delete(this.trusted.keys().next().value!)
      reset()
      return url
    } }
  }
}
