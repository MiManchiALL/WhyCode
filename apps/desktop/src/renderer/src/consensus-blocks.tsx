import { Streamdown } from 'streamdown'
import { Circle, ClipboardList } from 'lucide-react'
import {
  voteLabel,
  type CandidateBlockData,
  type PeerBlockData,
} from './conversation-state.ts'

/**
 * 协商 UI（M3-b MVP）：B/C 的讨论过程折叠在卡片里，主线只显示关键节点（候选/投票/决策）。
 */
/** 正式候选的实质内容。默认展开，用户可自行收起长分析。 */
export function CandidateCard({
  candidate,
  expanded,
  onToggle,
}: {
  candidate: CandidateBlockData
  expanded: boolean
  onToggle: () => void
}) {
  const hasDetails = Boolean(candidate.details?.finalAnswerOrPlan)
  return (
    <div className="wc-sticker-soft mb-2 overflow-hidden bg-[var(--wc-blue)]/65 text-sm">
      <button
        type="button"
        className="wc-focus-ring flex w-full items-start gap-2 px-3 py-2 text-left"
        disabled={!hasDetails}
        onClick={hasDetails ? onToggle : undefined}
      >
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-white/65 text-[var(--wc-blue-ink)]">
          <ClipboardList size={13} />
        </span>
        <span className="min-w-0 flex-1 text-[var(--wc-blue-ink)]">
          <span className="font-medium">
            候选 {candidate.candidateId}（{candidate.agentId}）
          </span>
          <span className="ml-2">{candidate.summary}</span>
        </span>
        {hasDetails && (
          <span className="shrink-0 text-xs text-[var(--wc-faint)]">{expanded ? '▾' : '▸'}</span>
        )}
      </button>
      {expanded && candidate.details && (
        <div className="border-t border-[var(--wc-line)] bg-white/45 px-3 py-2 text-[var(--wc-ink)]">
          <div className="prose prose-sm max-w-none">
            <Streamdown>{candidate.details.finalAnswerOrPlan}</Streamdown>
          </div>
          {candidate.details.evidenceRefs?.length ? (
            <div className="mt-2 text-xs text-[var(--wc-blue-ink)]">
              证据：{candidate.details.evidenceRefs.join('；')}
            </div>
          ) : null}
          {candidate.details.knownRisks?.length ? (
            <div className="mt-1 text-xs text-amber-700">
              已知风险：{candidate.details.knownRisks.join('；')}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function PeerCard({
  peer,
  expanded,
  onToggle,
}: {
  peer: PeerBlockData
  expanded: boolean
  onToggle: () => void
}) {
  const header =
    peer.status === 'working'
      ? `Agent ${peer.agentId} · 评审中`
      : peer.vote
        ? `Agent ${peer.agentId} · ${voteLabel(peer.vote.vote)}`
        : `Agent ${peer.agentId} · 已结束`
  const lastTool = peer.tools.at(-1)
  return (
    <div className="wc-sticker-soft mb-2 overflow-hidden bg-[var(--wc-sage)]/55 text-sm">
      <button type="button" className="wc-focus-ring flex w-full items-center gap-2 px-3 py-2 text-left" onClick={onToggle}>
        <span className={peer.status === 'working' ? 'animate-pulse text-[var(--wc-sage-ink)]' : 'text-[var(--wc-sage-ink)]'}>
          <Circle size={10} fill={peer.status === 'working' ? 'none' : 'currentColor'} />
        </span>
        <span className="font-medium text-[var(--wc-sage-ink)]">{header}</span>
        <span className="ml-auto shrink-0 text-xs text-[var(--wc-faint)]">
          {peer.tools.length > 0 && `${peer.tools.length} 次工具调用 `}
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {/* 工作中实时显示当前动作，让用户看得到 B/C 在干什么 */}
      {peer.status === 'working' && lastTool && (
        <div className="truncate border-t border-[var(--wc-line)] bg-white/35 px-3 py-1.5 text-xs text-[var(--wc-sage-ink)]">
          正在：{lastTool.name} <span className="text-[var(--wc-muted)]">{lastTool.summary}</span>
        </div>
      )}
      {peer.status === 'done' && peer.vote && (
        <div className="border-t border-[var(--wc-line)] bg-white/35 px-3 py-2 text-xs text-[var(--wc-sage-ink)]">
          {peer.vote.reason}
          {peer.vote.suggestedChange && (
            <div className="mt-1 text-[var(--wc-muted)]">建议：{peer.vote.suggestedChange}</div>
          )}
        </div>
      )}
      {expanded && (
        <div className="border-t border-[var(--wc-line)] bg-white/35 px-3 py-2">
          {peer.tools.map((t) => (
            <div key={t.id} className="truncate text-xs text-[var(--wc-muted)]">
              {t.isError ? '✗' : '·'} {t.name} {t.summary}
            </div>
          ))}
          {peer.text && (
            <div className="prose prose-sm mt-1 max-w-none text-xs text-[var(--wc-ink)]">
              <Streamdown>{peer.text}</Streamdown>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
