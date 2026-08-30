import { useEffect, useRef, useState } from 'react'
import { Check, Copy, GitFork, LoaderCircle, Pencil } from 'lucide-react'

const MESSAGE_TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function MessageActions({
  timestamp,
  text,
  editable = false,
  onEdit,
  onFork,
  forkPending = false,
  className = '',
}: {
  timestamp?: string
  text: string
  editable?: boolean
  onEdit?: () => void
  onFork?: () => void
  forkPending?: boolean
  className?: string
}) {
  return (
    <div
      className={`pointer-events-none flex items-center gap-2 wc-type-caption text-[var(--wc-faint)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 ${className}`}
    >
      {timestamp ? <time dateTime={timestamp}>{formatMessageTime(timestamp)}</time> : null}
      <CopyButton text={text} />
      {editable && onEdit ? (
        <button
          type="button"
          className="wc-focus-ring rounded-md p-0.5 hover:text-[var(--wc-ink)]"
          title="编辑"
          aria-label="编辑消息"
          onClick={onEdit}
        >
          <Pencil size={14} />
        </button>
      ) : null}
      {onFork ? (
        <button
          type="button"
          className="wc-focus-ring rounded-md p-0.5 hover:text-[var(--wc-ink)] disabled:opacity-40"
          disabled={forkPending}
          title="在新对话中继续"
          aria-label="在新对话中继续"
          onClick={onFork}
        >
          {forkPending ? <LoaderCircle size={14} className="animate-spin" /> : <GitFork size={14} />}
        </button>
      ) : null}
    </div>
  )
}

/** 消息与工具详情共用同一套复制反馈和图标。 */
export function CopyButton({
  text,
  label = '复制',
  ariaLabel = '复制消息',
  className = '',
}: {
  text: string
  label?: string
  ariaLabel?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [])

  const copy = async () => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 1600)
    } catch {}
  }

  return (
    <button
      type="button"
      className={`wc-focus-ring rounded-md p-0.5 hover:text-[var(--wc-ink)] disabled:opacity-40 ${className}`}
      disabled={!text}
      title={copied ? '已复制' : label}
      aria-label={copied ? '已复制' : ariaLabel}
      onClick={() => void copy()}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

export function formatMessageTime(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : MESSAGE_TIME.format(date)
}
