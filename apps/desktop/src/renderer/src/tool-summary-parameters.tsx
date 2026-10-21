import type { ToolCallSummary } from '../../shared/tool-call-summary.ts'

export function ToolSummaryParameters({ summary, className = '' }: { summary: ToolCallSummary; className?: string }) {
  return <span className={`wc-tool-summary-parameters ${className}`}
    style={{ gridTemplateColumns: summary.parts.map(part => part.fixed ? 'max-content' : 'minmax(0, max-content)').join(' ') }}>
    {summary.parts.map((part, index) => <span className="wc-tool-summary-parameter" key={index} title={part.text}>
      {index > 0 && <span className="wc-tool-summary-separator">{summary.separator.trim()}</span>}
      <span className="min-w-0 truncate">{part.text}</span>
    </span>)}
  </span>
}
