import { useEffect, useId, useState } from 'react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { ArrowUp, Square } from 'lucide-react'
import type { ComposerPrimaryAction } from './composer-key.ts'

export interface ComposerActionButtonProps {
  runtimeId: string
  workStartedAt: number | null
  runningSubagentCount: number
  primaryAction: ComposerPrimaryAction
  stopping: boolean
  stopDisabled: boolean
  sendDisabled: boolean
  onSend: () => void
  onStop: () => void
}

export function ComposerActionButton(props: ComposerActionButtonProps) {
  const dialogId = useId()
  const [confirmation, setConfirmation] = useState<{
    runtimeId: string
    workStartedAt: number | null
  } | null>(null)
  const isStopAction = props.primaryAction === 'stop'
  const needsConfirmation = isStopAction && !props.stopDisabled && props.runningSubagentCount > 0
  const open = needsConfirmation
    && confirmation?.runtimeId === props.runtimeId
    && confirmation.workStartedAt === props.workStartedAt
  const label = isStopAction ? (props.stopping ? '停止中' : '停止') : '发送'

  useEffect(() => {
    // 取消已失效的确认，切回原会话或出现新的子代理时也不重新弹出。
    if (confirmation && !open) setConfirmation(null)
  }, [confirmation, open])

  return (
    <AlertDialog.Root open={open} onOpenChange={(nextOpen) => {
      setConfirmation(nextOpen && needsConfirmation
        ? { runtimeId: props.runtimeId, workStartedAt: props.workStartedAt }
        : null)
    }}>
      <AlertDialog.Trigger asChild>
        <button
          type="button"
          className="wc-focus-ring flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--wc-ink)] text-white shadow-sm transition-transform hover:-translate-y-0.5 disabled:cursor-default disabled:bg-[#a9aaa5] disabled:hover:translate-y-0"
          disabled={isStopAction ? props.stopDisabled : props.sendDisabled}
          onClick={(event) => {
            if (needsConfirmation) return
            event.preventDefault()
            if (isStopAction) props.onStop()
            else props.onSend()
          }}
          title={label}
          aria-label={label}
          aria-haspopup={needsConfirmation ? 'dialog' : undefined}
          aria-expanded={needsConfirmation ? open : undefined}
          aria-controls={needsConfirmation ? dialogId : undefined}
        >
          {isStopAction ? <Square size={13} fill="currentColor" /> : <ArrowUp size={17} />}
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
        <AlertDialog.Content id={dialogId} className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 p-5 outline-none">
          <AlertDialog.Title className="text-base font-semibold">停止当前会话？</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-6 text-[var(--wc-muted)]">
            当前有 {props.runningSubagentCount} 个子代理正在运行。
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" className="wc-focus-ring rounded-xl border border-[var(--wc-line)] px-3 py-2 text-sm">取消</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button type="button" className="wc-focus-ring rounded-xl bg-[var(--wc-ink)] px-3 py-2 text-sm text-white" onClick={() => { if (open) props.onStop() }}>
                停止会话
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
