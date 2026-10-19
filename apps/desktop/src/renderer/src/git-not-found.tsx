export function GitNotFound({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  return <button type="button" className="wc-focus-ring text-left" disabled={loading} aria-busy={loading}
    onClick={onRetry} title="点击重新检测 Git">未检测到 Git，未安装或不在 PATH 中</button>
}
