import { Streamdown } from 'streamdown'
import type { CoreEvent } from '@whycode/core/events'

/**
 * 协商 UI（M3-b MVP）：B/C 的讨论过程折叠在卡片里，主线只显示关键节点（候选/投票/决策）。
 */
export interface PeerBlockData {
  agentId: 'B' | 'C'
  status: 'working' | 'done'
  text: string
  tools: { id: string; name: string; summary: string; isError: boolean }[]
  vote?: { vote: string; reason: string; suggestedChange?: string }
}

export type CandidateBlockData = Omit<
  Extract<CoreEvent, { type: 'candidate-submitted' }>,
  'type'
>

export function createPeerBlock(agentId: 'B' | 'C'): PeerBlockData {
  return { agentId, status: 'working', text: '', tools: [] }
}

/** 把 B/C 的内层事件归集进卡片数据（thinking 流不展示，保持卡片轻量） */
export function applyPeerEvent(data: PeerBlockData, event: CoreEvent): PeerBlockData {
  switch (event.type) {
    case 'text-delta':
      return { ...data, text: data.text + event.text }
    case 'tool-start':
      return {
        ...data,
        tools: [
          ...data.tools,
          {
            id: event.toolUseId,
            name: event.toolName,
            summary: peerSummarize(event.input),
            isError: false,
          },
        ],
      }
    case 'tool-end':
      return {
        ...data,
        tools: data.tools.map((t) =>
          t.id === event.toolUseId ? { ...t, isError: event.isError } : t,
        ),
      }
    default:
      return data
  }
}

const VOTE_LABELS: Record<string, string> = {
  accept: '✅ 接受',
  accept_with_minor_edits: '☑️ 接受（小修改）',
  reject: '❌ 拒绝',
}

export function voteLabel(vote: string): string {
  return VOTE_LABELS[vote] ?? vote
}

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
    <div className="mb-2 rounded border border-blue-200 bg-blue-50/60 text-sm">
      <button
        className="flex w-full items-start gap-2 px-3 py-2 text-left"
        disabled={!hasDetails}
        onClick={hasDetails ? onToggle : undefined}
      >
        <span>📋</span>
        <span className="min-w-0 flex-1 text-blue-900">
          <span className="font-medium">
            候选 {candidate.candidateId}（{candidate.agentId}）
          </span>
          <span className="ml-2">{candidate.summary}</span>
        </span>
        {hasDetails && (
          <span className="shrink-0 text-xs text-blue-400">{expanded ? '▾' : '▸'}</span>
        )}
      </button>
      {expanded && candidate.details && (
        <div className="border-t border-blue-100 px-3 py-2 text-blue-950">
          <div className="prose prose-sm max-w-none">
            <Streamdown>{candidate.details.finalAnswerOrPlan}</Streamdown>
          </div>
          {candidate.details.evidenceRefs?.length ? (
            <div className="mt-2 text-xs text-blue-700">
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
    <div className="mb-2 rounded border border-violet-200 bg-violet-50/50 text-sm">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={onToggle}>
        <span className={peer.status === 'working' ? 'animate-pulse text-violet-500' : 'text-violet-500'}>
          {peer.status === 'working' ? '◌' : '●'}
        </span>
        <span className="font-medium text-violet-900">{header}</span>
        <span className="ml-auto shrink-0 text-xs text-violet-400">
          {peer.tools.length > 0 && `${peer.tools.length} 次工具调用 `}
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {/* 工作中实时显示当前动作，让用户看得到 B/C 在干什么 */}
      {peer.status === 'working' && lastTool && (
        <div className="truncate border-t border-violet-100 px-3 py-1.5 text-xs text-violet-500">
          正在：{lastTool.name} <span className="text-violet-400">{lastTool.summary}</span>
        </div>
      )}
      {peer.status === 'done' && peer.vote && (
        <div className="border-t border-violet-100 px-3 py-2 text-xs text-violet-800">
          {peer.vote.reason}
          {peer.vote.suggestedChange && (
            <div className="mt-1 text-violet-600">建议：{peer.vote.suggestedChange}</div>
          )}
        </div>
      )}
      {expanded && (
        <div className="border-t border-violet-100 px-3 py-2">
          {peer.tools.map((t) => (
            <div key={t.id} className="truncate text-xs text-violet-500">
              {t.isError ? '✗' : '·'} {t.name} {t.summary}
            </div>
          ))}
          {peer.text && (
            <div className="prose prose-sm mt-1 max-w-none text-xs text-violet-900">
              <Streamdown>{peer.text}</Streamdown>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function peerSummarize(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.path === 'string') return obj.path
    if (typeof obj.pattern === 'string') return obj.pattern
    if (typeof obj.command === 'string') return obj.command
  }
  return ''
}
