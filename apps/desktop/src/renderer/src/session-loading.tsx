export function SessionLoading() {
  return (
    <div className="absolute inset-0 flex items-center px-4" role="status">
      <div className="wc-conversation-balanced-content mx-auto flex w-full max-w-4xl justify-center">
        <span className="wc-session-loading text-sm">稍等一会，马上就好</span>
      </div>
    </div>
  )
}
