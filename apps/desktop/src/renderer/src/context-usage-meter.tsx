import { useEffect, useId, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import type { ContextUsageInfo } from '@whycode/core/events'
import { contextUsagePresentation, formatContextTokens, type ContextUsagePresentation } from './context-usage.ts'

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const ROWS = [
  { key: 'system', field: 'systemPromptTokens', label: '系统提示词' },
  { key: 'tools', field: 'toolTokens', label: '工具' },
  { key: 'messages', field: 'messageTokens', label: '消息与上下文' },
] as const
type Category = typeof ROWS[number]['key']

export function ContextUsageMeter({ usage }: { usage: ContextUsageInfo | null }) {
  const [open, setOpen] = useState(false)
  const presentation = usage ? contextUsagePresentation(usage) : null
  const available = Boolean(presentation)

  useEffect(() => {
    if (!available) setOpen(false)
  }, [available])

  if (!usage || !presentation) return null
  const label = presentation.autoCompactPending
    ? `上下文已用 ${presentation.percent}%，将在下次模型请求前自动压缩`
    : `上下文已用 ${presentation.percent}%`

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <span className="wc-context-meter" data-open={open ? 'true' : 'false'}>
        <Popover.Trigger asChild>
          <button type="button" className="wc-context-meter-trigger wc-focus-ring" aria-label={label}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <circle className="wc-context-meter-track" cx="8" cy="8" r={RADIUS} />
              <circle
                className="wc-context-meter-fill"
                cx="8" cy="8" r={RADIUS}
                strokeDasharray={`${CIRCUMFERENCE * presentation.percent / 100} ${CIRCUMFERENCE}`}
                transform="rotate(-90 8 8)"
              />
            </svg>
          </button>
        </Popover.Trigger>
        <span className="wc-context-meter-tooltip" role="tooltip">{label}</span>
      </span>
      <Popover.Portal>
        <Popover.Content
          className="wc-context-meter-panel" side="top" align="end" sideOffset={8}
          collisionPadding={12} aria-label="上下文用量"
          onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}
        >
          <ContextUsagePanel usage={usage} presentation={presentation} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function ContextUsagePanel({ usage, presentation }: { usage: ContextUsageInfo; presentation: ContextUsagePresentation }) {
  const [selected, setSelected] = useState<Category | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const detailId = useId()
  const category = ROWS.find(row => row.key === selected)
  return <Popover.Root open={Boolean(category)} onOpenChange={open => { if (!open) setSelected(null) }}>
    <Popover.Anchor asChild>
      <div ref={panelRef}>
        <div className="wc-context-meter-header">
          <span>上下文已用</span>
          <strong>{presentation.percent}%</strong>
          <span className="wc-context-meter-total">
            ~{formatContextTokens(presentation.usedTokens)} / {formatContextTokens(presentation.contextWindow)}
          </span>
        </div>
        <div className="wc-context-meter-bar" aria-hidden="true">
          {presentation.segments.map(segment => (
            <span
              key={segment.key}
              className={`wc-context-meter-segment wc-context-meter-${segment.key}`}
              style={{ width: `${segment.width}%` }}
            />
          ))}
        </div>
        <div className="wc-context-meter-rows">
          {ROWS.map(row => (
            <button
              key={row.key} type="button" className="wc-context-meter-row wc-context-meter-category wc-focus-ring"
              aria-label={`${row.label}明细`} aria-haspopup="dialog" aria-expanded={selected === row.key}
              aria-controls={selected === row.key ? detailId : undefined}
              onClick={event => {
                triggerRef.current = event.currentTarget
                setSelected(selected === row.key ? null : row.key)
              }}
            >
              <span className="wc-context-meter-row-label">
                <span className={`wc-context-meter-swatch wc-context-meter-${row.key}`} aria-hidden="true" />
                {row.label}
              </span>
              <span className="wc-context-meter-row-value">
                ~{formatContextTokens(usage.breakdown[row.field])}
              </span>
            </button>
          ))}
        </div>
        <div className="wc-context-meter-threshold" data-pending={presentation.autoCompactPending ? 'true' : 'false'}>
          <span>{presentation.autoCompactPending ? '下次模型请求前自动压缩' : '自动压缩阈值'}</span>
          <strong>~{formatContextTokens(presentation.autoCompactThreshold)}</strong>
        </div>
      </div>
    </Popover.Anchor>
    <Popover.Portal>
      <Popover.Content
        id={detailId} className="wc-context-meter-panel wc-context-meter-detail" side="left" align="start"
        sideOffset={20} collisionPadding={12} aria-label={`${category?.label}明细`}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => {
          if (event.target instanceof Node && panelRef.current?.contains(event.target)) event.preventDefault()
        }}
        onEscapeKeyDown={event => {
          if (event.isComposing) event.preventDefault()
          else triggerRef.current?.focus()
        }}
      >
        {category && <ContextUsageDetails usage={usage} category={category.key} label={category.label} />}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

function ContextUsageDetails({ usage, category, label }: { usage: ContextUsageInfo; category: Category; label: string }) {
  const { system, tools, messages } = usage.details
  const rows: Array<{ label: string; tokens: number }> = category === 'system'
    ? [
        ...(system.mode !== 'replace' ? [{ label: '内置系统提示词', tokens: system.builtIn }] : []),
        ...(system.mode !== 'off' ? [{ label: '自定义系统提示词', tokens: system.custom }] : []),
      ]
    : category === 'tools'
      ? [
          { label: '内置工具', tokens: tools.builtIn },
          ...(tools.mcp > 0 ? [{ label: '已加载 MCP 工具', tokens: tools.mcp }] : []),
        ]
      : [
          { label: 'AGENTS.md', tokens: messages.agents },
          { label: '子代理目录', tokens: messages.subagents },
          { label: 'Skill 目录', tokens: messages.skills },
          { label: '上下文', tokens: messages.context },
        ]
  return <>
    <div className="wc-context-meter-detail-heading">
      <strong><span className={`wc-context-meter-swatch wc-context-meter-${category}`} aria-hidden="true" />{label}</strong>
      {category === 'system' && system.mode !== 'off' && <span>{system.mode === 'replace' ? '覆盖模式' : '追加模式'}</span>}
    </div>
    <dl className="wc-context-meter-rows">
      {rows.map(row => <div className="wc-context-meter-row" key={row.label}>
        <dt>{row.label}</dt><dd>~{formatContextTokens(row.tokens)}</dd>
      </div>)}
    </dl>
  </>
}
