import { useEffect, useRef, useState } from 'react'
import type { ContextUsageInfo } from '@whycode/core/events'
import { contextUsagePresentation, formatContextTokens } from './context-usage.ts'

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const ROWS = [
  { key: 'system' as const, field: 'systemPromptTokens' as const, label: '系统提示词' },
  { key: 'tools' as const, field: 'toolTokens' as const, label: '工具' },
  { key: 'messages' as const, field: 'messageTokens' as const, label: '对话消息' },
]

export function ContextUsageMeter({ usage }: { usage: ContextUsageInfo | null }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const presentation = usage ? contextUsagePresentation(usage) : null

  useEffect(() => {
    if (!presentation && open) setOpen(false)
  }, [open, presentation])

  useEffect(() => {
    if (!open || !presentation) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, presentation])

  if (!usage || !presentation) return null
  const label = presentation.autoCompactPending
    ? `上下文已用 ${presentation.percent}%，将在下次模型请求前自动压缩`
    : `上下文已用 ${presentation.percent}%`

  return (
    <span
      ref={rootRef}
      className="wc-context-meter"
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        className="wc-context-meter-trigger wc-focus-ring"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle className="wc-context-meter-track" cx="8" cy="8" r={RADIUS} />
          <circle
            className="wc-context-meter-fill"
            cx="8"
            cy="8"
            r={RADIUS}
            strokeDasharray={`${CIRCUMFERENCE * presentation.percent / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
      <span className="wc-context-meter-tooltip" role="tooltip">{label}</span>
      {open && (
        <div className="wc-context-meter-panel" role="dialog" aria-label="上下文用量">
          <div className="wc-context-meter-header">
            <span>上下文已用</span>
            <strong>{presentation.percent}%</strong>
            <span className="wc-context-meter-total">
              ~{formatContextTokens(presentation.usedTokens)} / {formatContextTokens(presentation.contextWindow)}
            </span>
          </div>
          <div className="wc-context-meter-bar" aria-hidden="true">
            {presentation.segments.map((segment) => (
              <span
                key={segment.key}
                className={`wc-context-meter-segment wc-context-meter-${segment.key}`}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          <dl className="wc-context-meter-rows">
            {ROWS.map((row) => (
              <div key={row.key} className="wc-context-meter-row">
                <dt>
                  <span className={`wc-context-meter-swatch wc-context-meter-${row.key}`} aria-hidden="true" />
                  {row.label}
                </dt>
                <dd>~{formatContextTokens(usage.breakdown[row.field])}</dd>
              </div>
            ))}
          </dl>
          <div
            className="wc-context-meter-threshold"
            data-pending={presentation.autoCompactPending ? 'true' : 'false'}
          >
            <span>
              {presentation.autoCompactPending ? '下次模型请求前自动压缩' : '自动压缩阈值'}
            </span>
            <strong>~{formatContextTokens(presentation.autoCompactThreshold)}</strong>
          </div>
        </div>
      )}
    </span>
  )
}
