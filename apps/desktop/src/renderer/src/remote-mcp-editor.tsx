import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { RemoteMcpDocument } from '../../shared/ssh-mcp.ts'
import type { SettingsMutationResult } from '../../shared/settings.ts'
import { SettingsButton } from './settings-layout.tsx'

export function RemoteMcpEditor({ document, onClose, onSaved }: {
  document: RemoteMcpDocument
  onClose: () => void
  onSaved: (result: SettingsMutationResult) => void
}) {
  const [text, setText] = useState(document.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true); setError(null)
    try {
      const result = await window.whycode.saveRemoteMcpConfig({ ...document, text })
      if (!result.ok) { setError(result.error ?? '保存失败'); return }
      onSaved(result); onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
    <Dialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] flex max-h-[90vh] w-[min(92vw,720px)] -translate-x-1/2 -translate-y-1/2 flex-col p-5 outline-none"
      onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }} onInteractOutside={event => event.preventDefault()}>
      <div className="flex items-center justify-between gap-3">
        <Dialog.Title className="text-base font-semibold">项目 MCP 配置</Dialog.Title>
        <Dialog.Close asChild><button aria-label="关闭配置编辑" disabled={busy} className="wc-focus-ring rounded-lg p-1.5 hover:bg-black/[0.05]"><X size={17} /></button></Dialog.Close>
      </div>
      <Dialog.Description className="mt-2 break-all text-xs leading-5 text-[var(--wc-muted)]">{document.directory.replace(/\/$/u, '')}/.whycode/mcp.json</Dialog.Description>
      <textarea aria-label="MCP 配置 JSON" autoFocus spellCheck={false} disabled={busy}
        className="wc-settings-input wc-scrollbar my-4 min-h-48 flex-1 resize-none font-mono text-xs leading-6" style={{ height: 'min(50vh, 420px)' }}
        value={text} onChange={event => setText(event.target.value)} />
      {error && <p role="alert" className="mb-3 break-words text-sm text-[var(--wc-danger)]">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-[var(--wc-muted)]">保存到服务器，新会话生效。</p>
        <div className="flex gap-2"><SettingsButton disabled={busy} onClick={onClose}>取消</SettingsButton><SettingsButton variant="primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</SettingsButton></div>
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
