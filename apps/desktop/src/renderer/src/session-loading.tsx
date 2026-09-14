export function SessionLoading({ className = '' }: { className?: string }) {
  return (
    <div className={`flex min-h-0 flex-1 items-center justify-center p-6 ${className}`} role="status">
      <span className="wc-session-loading text-sm">稍等一会，马上就好</span>
    </div>
  )
}
