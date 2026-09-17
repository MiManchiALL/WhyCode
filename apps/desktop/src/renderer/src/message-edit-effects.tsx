import { useEffect, useId, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import type { TurnEditEffects } from '@whycode/core'

const UNTRACKED_WARNING = '重新发送不会撤销已执行的命令或其他未跟踪操作。'

export function useMessageEditEffects(runtimeId: string, turnId: string | undefined) {
  const [effects, setEffects] = useState<TurnEditEffects | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setEffects(null)
    setError(null)
    if (!turnId) {
      setEffects({ hasFileChanges: false, hasUntrackedEffects: false })
      return
    }
    void window.whycode.sendCommand(runtimeId, { type: 'inspect-user-message-edit', turnId })
      .then(result => {
        if (cancelled) return
        if (!result?.ok || !result.editEffects) throw new Error(result?.error ?? '无法检查本轮改动，请重新打开编辑')
        setEffects(result.editEffects)
      })
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '无法检查本轮改动，请重新打开编辑')
      })
    return () => { cancelled = true }
  }, [runtimeId, turnId])
  return { effects, error }
}

export function MessageEditEffects({ effects, checked, disabled, onChange }: {
  effects: TurnEditEffects | null
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const warningId = useId()
  if (!effects) return <span className="text-[var(--wc-muted)]">正在检查本轮改动…</span>
  if (!effects.hasFileChanges) return effects.hasUntrackedEffects
    ? <span className="text-[var(--wc-rollback-ink)]">{UNTRACKED_WARNING}</span> : null
  return (
    <div className="relative flex min-w-0 items-center gap-1.5 text-[var(--wc-muted)]">
      <label className="inline-flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" className="wc-focus-ring size-3.5 accent-[var(--wc-ink)]"
          checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
        同时回滚本轮文件改动
      </label>
      {effects.hasUntrackedEffects && (
        <span className="group/warning inline-flex">
          <button type="button" className="wc-focus-ring rounded text-[var(--wc-rollback-ink)]"
            aria-label="未跟踪操作提醒" aria-describedby={warningId}>
            <CircleAlert size={14} aria-hidden="true" />
          </button>
          <span id={warningId} role="tooltip"
            className="pointer-events-none absolute bottom-full left-0 z-10 mb-2 w-64 rounded-lg border border-[var(--wc-line)] bg-white px-3 py-2 text-xs text-[var(--wc-rollback-ink)] shadow-sm invisible group-hover/warning:visible group-focus-within/warning:visible">
            {UNTRACKED_WARNING}
          </span>
        </span>
      )}
    </div>
  )
}
