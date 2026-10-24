import { RefreshCw } from 'lucide-react'
import { useRefreshFeedback } from './use-refresh-feedback.ts'

export function GitNotFound({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  const refresh = useRefreshFeedback(loading)
  return <button type="button" className="wc-focus-ring flex items-center gap-1 text-left" disabled={refresh.busy} aria-busy={refresh.busy}
    onClick={() => void refresh.run(onRetry)} title="点击重新检测 Git">
    <RefreshCw size={12} className={`shrink-0 ${refresh.busy ? 'animate-spin' : ''}`} />未检测到 Git，未安装或不在 PATH 中
  </button>
}
