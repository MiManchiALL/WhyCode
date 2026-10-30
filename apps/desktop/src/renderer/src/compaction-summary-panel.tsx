import { useEffect, useState } from 'react'
import type { CompactionSummaryResult } from '../../shared/compaction-summary.ts'
import { MarkdownContent } from './markdown-content.tsx'

export function CompactionSummaryPanel({ runtimeId, index }: { runtimeId: string; index: number }) {
  const [result, setResult] = useState<CompactionSummaryResult | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setResult(null)
    void window.whycode.compactionSummary({ runtimeId, index }).then(
      value => { if (active) setResult(value) },
      (error: unknown) => {
        if (active) setResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { active = false }
  }, [runtimeId, index, revision])

  return (
    <div className="wc-scrollbar min-h-0 flex-1 overflow-y-auto p-4" aria-busy={!result}>
      <h2 className="mb-2 text-sm font-semibold">第 {index} 次完整压缩</h2>
      {!result ? <p className="wc-type-caption text-[var(--wc-muted)]">正在读取摘要…</p>
        : !result.ok ? (
          <div className="wc-type-caption text-[var(--wc-danger)]" role="alert">
            <p>{result.error}</p>
            <button className="wc-focus-ring mt-2 rounded px-2 py-1 hover:bg-black/5" onClick={() => setRevision(value => value + 1)}>重试</button>
          </div>
        ) : (
          <>
            <p className="wc-type-caption mb-5 text-[var(--wc-muted)]">
              {new Date(result.summary.timestamp).toLocaleString()} · {Math.round(result.summary.preTokens / 1000)}k → {Math.round(result.summary.postTokens / 1000)}k tokens
            </p>
            {[
              ['历史摘要', result.summary.historySummary],
              ['当前 turn 前缀摘要', result.summary.turnPrefixSummary],
            ].map(([title, text]) => text && (
              <section key={title} className="mb-6 last:mb-0">
                <h3 className="mb-3 border-b border-[var(--wc-line)] pb-2 text-sm font-medium">{title}</h3>
                <div className="wc-conversation-copy min-w-0">
                  <MarkdownContent text={text} streaming={false} renderMath />
                </div>
              </section>
            ))}
          </>
        )}
    </div>
  )
}
