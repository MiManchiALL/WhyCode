import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Pencil } from 'lucide-react'

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
  className = '',
}: {
  timestamp?: string
  text: string
  editable?: boolean
  onEdit?: () => void
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
    <div
      className={`pointer-events-none flex items-center gap-2 text-[11px] text-[var(--wc-faint)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 ${className}`}
    >
      {timestamp ? <time dateTime={timestamp}>{formatMessageTime(timestamp)}</time> : null}
      <button
        type="button"
        className="wc-focus-ring rounded-md p-0.5 hover:text-[var(--wc-ink)] disabled:opacity-40"
        disabled={!text}
        title={copied ? '已复制' : '复制'}
        aria-label={copied ? '已复制' : '复制消息'}
        onClick={() => void copy()}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
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
    </div>
  )
}

export function formatMessageTime(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : MESSAGE_TIME.format(date)
}
