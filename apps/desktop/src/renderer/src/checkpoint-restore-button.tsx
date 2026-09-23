import { LoaderCircle, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  restoreConfirmationActions,
  type CheckpointRestoreRequest,
  type CheckpointRestoreScope,
} from './checkpoint-restore-controls.ts'

interface RestoreButtonProps {
  runtimeId: string
  toolUseId: string
  busy: boolean
  pending: boolean
  onRequest: CheckpointRestoreRequest
}

export function RestoreButton(props: RestoreButtonProps) {
  return <span className="wc-restore-anchor" data-checkpoint-restore={props.toolUseId}>
    <RestoreOptions {...props} />
  </span>
}

function RestoreOptions({
  runtimeId,
  toolUseId,
  busy,
  pending,
  onRequest,
}: RestoreButtonProps) {
  const [open, setOpen] = useState(false)
  const [checkingScope, setCheckingScope] = useState<CheckpointRestoreScope | null>(null)
  const [confirmScope, setConfirmScope] = useState<CheckpointRestoreScope | null>(null)
  const pendingRef = useRef(false)
  const requestVersionRef = useRef(0)

  useEffect(() => {
    requestVersionRef.current++
    pendingRef.current = false
    setOpen(false)
    setCheckingScope(null)
    setConfirmScope(null)
  }, [runtimeId, toolUseId])

  useEffect(() => {
    if (!busy || pending) return
    requestVersionRef.current++
    pendingRef.current = false
    setOpen(false)
    setCheckingScope(null)
    setConfirmScope(null)
  }, [busy, pending])

  const check = async (scope: CheckpointRestoreScope) => {
    if (pendingRef.current || busy) return
    pendingRef.current = true
    const requestVersion = ++requestVersionRef.current
    setCheckingScope(scope)
    try {
      const allowed = await onRequest(toolUseId, scope, 'check')
      if (requestVersionRef.current === requestVersion && allowed) setConfirmScope(scope)
    } finally {
      if (requestVersionRef.current === requestVersion) {
        pendingRef.current = false
        setCheckingScope(null)
      }
    }
  }

  const restore = async () => {
    if (!confirmScope || pendingRef.current || busy) return
    pendingRef.current = true
    const scope = confirmScope
    setOpen(false)
    setConfirmScope(null)
    try {
      await onRequest(toolUseId, scope, 'restore')
    } finally {
      pendingRef.current = false
    }
  }

  if (pending) {
    return (
      <button
        className="flex shrink-0 cursor-wait items-center gap-1 text-xs text-[var(--wc-faint)]"
        disabled
        aria-busy="true"
      >
        <LoaderCircle size={12} className="animate-spin" /> 正在回滚…
      </button>
    )
  }
  if (!open) {
    return (
      <button
        className="wc-restore-button wc-focus-ring flex shrink-0 items-center gap-1 rounded-lg px-1 py-0.5 text-xs text-[var(--wc-faint)] hover:text-[var(--wc-ink)]"
        disabled={busy}
        title="从本轮首个文件改动开始回滚"
        onClick={() => setOpen(true)}
      >
        <RotateCcw size={12} /> 回滚本轮
      </button>
    )
  }
  if (confirmScope) {
    const actions = restoreConfirmationActions(confirmScope)
    const scopeLabel = confirmScope === 'files' ? '仅文件' : '文件与对话'
    return (
      <span className="flex shrink-0 gap-1 text-xs">
        {actions.map((item, index) => (
          <button
            key={`${item.action}-${index}`}
            className={`wc-focus-ring inline-flex justify-center rounded-lg border px-2 py-0.5 ${index === 0 ? 'w-16' : 'w-20'} ${item.action === 'confirm'
              ? 'border-[#dec8bf] text-[var(--wc-danger)] hover:bg-[#f8efec]'
              : 'border-[var(--wc-line)] hover:border-[var(--wc-line-strong)]'
            }`}
            disabled={busy}
            aria-label={item.action === 'confirm' ? `确认回滚${scopeLabel}` : `取消回滚${scopeLabel}`}
            title={item.action === 'confirm' ? `确认回滚${scopeLabel}` : `取消回滚${scopeLabel}`}
            onClick={() => {
              if (item.action === 'confirm') {
                void restore()
              } else {
                setOpen(false)
                setConfirmScope(null)
              }
            }}
          >
            {item.label}
          </button>
        ))}
        <span aria-hidden="true" className="w-5 shrink-0" />
      </span>
    )
  }
  return (
    <span className="flex shrink-0 gap-1 text-xs">
      <button
        className="wc-focus-ring inline-flex w-16 items-center justify-center gap-1 rounded-lg border border-[var(--wc-line)] px-2 py-0.5"
        disabled={busy || checkingScope !== null}
        onClick={() => void check('files')}
      >
        {checkingScope === 'files' ? (
          <><LoaderCircle size={11} className="animate-spin" /> 校验</>
        ) : '仅文件'}
      </button>
      <button
        className="wc-focus-ring inline-flex w-20 items-center justify-center gap-1 rounded-lg border border-[var(--wc-line)] px-2 py-0.5"
        disabled={busy || checkingScope !== null}
        onClick={() => void check('files-and-chat')}
      >
        {checkingScope === 'files-and-chat' ? (
          <><LoaderCircle size={11} className="animate-spin" /> 校验</>
        ) : '文件+对话'}
      </button>
      <button
        className="wc-focus-ring flex w-5 shrink-0 items-center justify-center rounded text-[var(--wc-faint)]"
        disabled={checkingScope !== null}
        onClick={() => setOpen(false)}
        aria-label="关闭回滚选项"
      >
        <X size={12} />
      </button>
    </span>
  )
}
