import { ShieldAlert } from 'lucide-react'

export interface Approval {
  requestId: string
  toolName: string
  input: unknown
  reason: string
  diff?: string
  items?: readonly {
    toolCallId: string
    toolName: string
    input: unknown
    reason: string
    diff?: string
  }[]
  suggestion?: { kind: 'add-dir'; dir: string } | { kind: 'allow-tool'; toolName: string }
}

export function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: Approval
  onRespond: (approved: boolean, remember?: boolean) => void
}) {
  const rememberLabel =
    approval.suggestion?.kind === 'add-dir'
      ? '允许并记住此路径范围（本会话）'
      : approval.suggestion?.kind === 'allow-tool'
        ? `允许且本会话不再询问 ${approval.suggestion.toolName}`
        : null
  return (
    <div className="wc-menu-surface p-3.5 text-sm">
      <div className="mb-1 flex items-center gap-2 font-medium text-[var(--wc-ink)]">
        <span className="flex size-7 items-center justify-center rounded-lg bg-white/70 text-[var(--wc-sand-ink)]">
          <ShieldAlert size={15} />
        </span>
        <span>
          {approval.items
            ? `请求执行：同一步的 ${approval.items.length} 项操作`
            : `请求执行：${approval.toolName}`}
        </span>
      </div>
      <div className="mb-2 pl-9 text-xs leading-5 text-[var(--wc-sand-ink)]">{approval.reason}</div>
      {approval.items ? (
        <div className="wc-scrollbar mb-2 max-h-80 space-y-2 overflow-auto">
          {approval.items.map((item, index) => (
            <div key={item.toolCallId} className="rounded-xl border border-[var(--wc-line)] bg-white/80 p-2.5">
              <div className="mb-1 text-xs font-medium text-[var(--wc-ink)]">
                {index + 1}. {item.toolName}
              </div>
              <div className="mb-1 text-xs text-[var(--wc-sand-ink)]">{item.reason}</div>
              <ApprovalInputPreview input={item.input} diff={item.diff} />
            </div>
          ))}
        </div>
      ) : (
        <ApprovalInputPreview input={approval.input} diff={approval.diff} />
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="wc-focus-ring rounded-xl bg-[var(--wc-ink)] px-3 py-1.5 text-xs text-white"
          onClick={() => onRespond(true, false)}
        >
          批准（仅本次）
        </button>
        {rememberLabel && (
          <button
            type="button"
            className="wc-focus-ring rounded-xl border border-[var(--wc-line)] bg-white px-3 py-1.5 text-xs"
            onClick={() => onRespond(true, true)}
          >
            {rememberLabel}
          </button>
        )}
        <button
          type="button"
          className="wc-focus-ring rounded-xl border border-[var(--wc-line)] bg-white/60 px-3 py-1.5 text-xs"
          onClick={() => onRespond(false)}
        >
          拒绝
        </button>
      </div>
    </div>
  )
}

function ApprovalInputPreview({ input, diff }: { input: unknown; diff?: string }) {
  if (!diff) {
    return (
      <pre className="wc-scrollbar max-h-40 overflow-auto rounded-xl bg-white/70 p-2.5 text-xs text-[var(--wc-muted)]">
        {summarizeApprovalInput(input)}
      </pre>
    )
  }
  return (
    <pre className="wc-scrollbar max-h-64 overflow-auto rounded-xl bg-white/70 p-2.5 text-xs">
      {diff.split('\n').map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'text-[#4e7a5c]'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'text-[var(--wc-danger)]'
                : 'text-[var(--wc-muted)]'
          }
        >
          {line}
        </div>
      ))}
    </pre>
  )
}

function summarizeApprovalInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const value = input as Record<string, unknown>
    if (typeof value.path === 'string') return value.path
    if (typeof value.pattern === 'string') return value.pattern
    if (typeof value.command === 'string') return value.command
  }
  return JSON.stringify(input) ?? ''
}
