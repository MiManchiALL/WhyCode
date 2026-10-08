export function SessionLoading({ alignConversation = false }: { alignConversation?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center px-4" role="status">
      <div className={`mx-auto flex w-full max-w-4xl justify-center ${alignConversation ? 'wc-conversation-balanced-content' : ''}`}>
        <span className="wc-session-loading text-sm">稍等一会，马上就好</span>
      </div>
    </div>
  )
}
