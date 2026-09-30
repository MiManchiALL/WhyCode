import { useEffect, useState } from 'react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { CircleAlert } from 'lucide-react'
import type { WorkspaceDeletionPreview } from '../../shared/workspace-lifecycle.ts'
import type { DeleteSessionOptions, DeleteSessionResult, RemoteCleanupFailure } from '../../shared/session.ts'

interface Props {
  sessionId: string
  remoteFailure?: RemoteCleanupFailure
  onClose: () => void
  onDelete: (sessionId: string, options: DeleteSessionOptions) => Promise<DeleteSessionResult | null>
  onError: (message: string) => void
}

export function SessionDeleteDialog({ sessionId, remoteFailure, onClose, onDelete, onError }: Props) {
  const [preview, setPreview] = useState<WorkspaceDeletionPreview | null>(null)
  const [deleteDirectory, setDeleteDirectory] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.whycode.previewSessionDeletion(sessionId).then(result => {
      if (cancelled) return
      if (!result.ok) throw new Error(result.error)
      setPreview(result.value)
    }).catch(error => {
      if (cancelled) return
      onError(`无法确认删除范围：${error instanceof Error ? error.message : String(error)}`)
      onClose()
    })
    return () => { cancelled = true }
  }, [sessionId, onError, onClose])

  const submit = (remoteCleanup: DeleteSessionOptions['remoteCleanup']) => {
    onClose()
    void onDelete(sessionId, { deleteDirectory, remoteCleanup })
  }

  return (
    <AlertDialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
        <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] max-h-[90vh] w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 outline-none">
          <CircleAlert size={20} className="mb-3 text-[var(--wc-danger)]" />
          <AlertDialog.Title className="text-base font-semibold">{remoteFailure ? '远端临时文件未清理' : '删除这个会话？'}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-6 text-[var(--wc-muted)]">
            {remoteFailure === 'connection-missing'
              ? '会话已保留。请重新添加并连接原服务器后再删除，或仅删除本地会话，保留服务器上的临时文件。'
              : remoteFailure
                ? '会话已保留。可以重试清理，或仅删除本地会话，保留服务器上的临时文件。'
                : '会话记录、检查点、后台命令记录和临时工作目录将被永久删除。'}
          </AlertDialog.Description>
          <div className="mt-3 text-sm leading-6">
            {!preview ? <p className="text-[var(--wc-muted)]">正在确认工作目录…</p> : <>
              {preview.directory && <p className="mb-3 break-all rounded-xl bg-black/[0.035] px-3 py-2 text-xs text-[var(--wc-muted)]">{preview.directory}</p>}
              {preview.disposition === 'optional' ? <>
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" className="wc-focus-ring accent-[var(--wc-sage-ink)]" checked={deleteDirectory} onChange={event => setDeleteDirectory(event.target.checked)} />
                  同时删除工作目录
                </label>
                <p className={`mt-2 text-xs leading-5 ${deleteDirectory ? 'text-[var(--wc-danger)]' : 'text-[var(--wc-muted)]'}`}>
                  {deleteDirectory ? preview.warning ?? '工作目录及其中的全部文件将被永久删除。' : '工作目录将保留，可在设置的“保留工作区”中打开或清理。'}
                </p>
              </> : <p className="text-[var(--wc-muted)]">{description(preview)}</p>}
            </>}
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild><button className="wc-focus-ring rounded-xl border border-[var(--wc-line)] px-3 py-2 text-sm">取消</button></AlertDialog.Cancel>
            {remoteFailure && <button className="wc-focus-ring rounded-xl border border-[var(--wc-line)] px-3 py-2 text-sm text-[var(--wc-danger)]" onClick={() => submit('skip')}>
              仅删除本地会话
            </button>}
            {remoteFailure !== 'connection-missing' &&
              <button disabled={!preview} className="wc-focus-ring rounded-xl bg-[var(--wc-danger)] px-3 py-2 text-sm text-white disabled:opacity-40" onClick={() => submit('required')}>
                {remoteFailure ? '重试' : '删除会话'}
              </button>
            }
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function description(preview: WorkspaceDeletionPreview): string {
  switch (preview.disposition) {
    case 'local': return '本地项目目录及其中的文件会保留。'
    case 'remote': return '服务器上的项目目录及其中的文件会保留。'
    case 'shared': return '工作目录仍被其它会话使用，目录及其中的文件会保留。'
    case 'empty': return 'WhyCode 创建的工作目录为空，将一并清理。'
    case 'unverified': return '无法确认工作目录归属，项目文件会保留。'
    default: return '没有需要清理的工作目录。'
  }
}
