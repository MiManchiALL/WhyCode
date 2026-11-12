import * as Dialog from '@radix-ui/react-dialog'
import { LoaderCircle } from 'lucide-react'

export function SessionLoading() {
  return (
    <div className="absolute inset-0 flex items-center px-4" role="status">
      <div className="wc-conversation-balanced-content mx-auto flex w-full max-w-4xl justify-center">
        <span className="wc-shimmer-text wc-session-loading text-sm">稍等一会，马上就好</span>
      </div>
    </div>
  )
}

export function ForkProgressDialog() {
  return <Dialog.Root open><Dialog.Portal>
    <Dialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/15" />
    <Dialog.Content aria-describedby={undefined}
      onEscapeKeyDown={event => event.preventDefault()}
      onCloseAutoFocus={event => event.preventDefault()}
      className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] flex -translate-x-1/2 -translate-y-1/2 items-center gap-3 px-5 py-4 outline-none">
      <LoaderCircle aria-hidden size={18} className="animate-spin text-[var(--wc-sage-ink)] motion-reduce:animate-none" />
      <Dialog.Title className="text-sm font-medium">正在创建会话分支…</Dialog.Title>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
