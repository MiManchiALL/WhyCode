import { Globe2 } from 'lucide-react'
import { useState } from 'react'
import { siteIconUrl } from '../../shared/site-icon.ts'

export function SiteIcon({ origin }: { origin: string }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  return <span className="wc-site-icon" aria-hidden="true" data-loaded={status === 'loaded'}>
    {status !== 'loaded' && <Globe2 />}
    {status !== 'failed' && <img src={siteIconUrl(origin)} alt="" width={16} height={16}
      loading="lazy" decoding="async" fetchPriority="low" referrerPolicy="no-referrer" draggable={false}
      onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')} />}
  </span>
}
