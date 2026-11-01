import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { BrowserCertificateError } from '../../shared/browser.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'

export function BrowserCertificateWarning({ certificate, leaseId, onContinue }: {
  certificate: BrowserCertificateError; leaseId: string; onContinue: (url: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const feedback = useConversationFeedback()
  const proceed = async () => {
    if (busy) return
    setBusy(true)
    try {
      const url = await window.whycode.trustBrowserCertificate(leaseId, certificate.id)
      onContinue(url)
    } catch (error) { feedback('error', error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div className="flex w-full max-w-sm flex-col items-center gap-3" role="alert">
    <ShieldAlert size={26} className="text-[var(--wc-faint)]" aria-hidden />
    <p className="font-medium text-[var(--wc-ink)]">无法验证此网站的身份</p>
    <p className="w-full break-all">{new URL(certificate.url).origin}</p>
    <p>网站证书不受信任、已过期或与地址不匹配。继续访问可能泄露密码等信息。</p>
    <details className="w-full text-left">
      <summary className="wc-focus-ring cursor-pointer rounded px-1 py-1">高级</summary>
      <div className="mt-2 space-y-3 text-xs leading-5">
        <dl className="space-y-1 break-words">
          <div><dt className="inline text-[var(--wc-faint)]">错误：</dt><dd className="inline break-all">{certificate.error}</dd></div>
          <div><dt className="inline text-[var(--wc-faint)]">颁发给：</dt><dd className="inline">{certificate.subjectName || '未提供'}</dd></div>
          <div><dt className="inline text-[var(--wc-faint)]">颁发者：</dt><dd className="inline">{certificate.issuerName || '未提供'}</dd></div>
          <div><dt className="inline text-[var(--wc-faint)]">有效期：</dt><dd className="inline">{new Date(certificate.validStart * 1000).toLocaleDateString()} — {new Date(certificate.validExpiry * 1000).toLocaleDateString()}</dd></div>
          <div><dt className="text-[var(--wc-faint)]">SHA-256 指纹</dt><dd className="break-all font-mono">{certificate.fingerprint}</dd></div>
        </dl>
        <p>仅在确认这是你要访问的设备后继续。本次允许仅适用于此站点的当前证书，重启应用或清除全部浏览器数据后失效。</p>
        <button className="wc-focus-ring rounded-lg border border-[var(--wc-line)] px-3 py-1.5 text-sm text-[var(--wc-ink)]"
          disabled={busy} aria-busy={busy} onClick={() => void proceed()}>继续访问（不安全）</button>
      </div>
    </details>
  </div>
}
