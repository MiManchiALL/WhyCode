import { useEffect, useMemo, useState } from 'react'
import type {
  SkillSummary,
  SubagentEventEnvelope,
  SubagentStatus,
  SubagentSummary,
} from '@whycode/core'
import {
  ArrowLeft,
  Ban,
  Bot,
  CheckCircle2,
  CircleAlert,
  CircleStop,
  Gauge,
  LoaderCircle,
} from 'lucide-react'
import {
  applyCoreEvent,
  createConversationState,
  toggleExpanded,
} from './conversation-state.ts'
import { conversationSections } from './conversation-sections.ts'
import { presentBtwConversations } from './conversation-btw-groups.ts'
import { ConversationEventBuffer } from './conversation-event-buffer.ts'
import { ConversationView } from './conversation-view.tsx'
import { ProcessingTime, TotalProcessingTime } from './processing-time.ts'
import {
  isSubagentRunning,
  resolveSubagentPanelPage,
  subagentProfileLabel,
  subagentStatusLabel,
  type SubagentPanelPage,
} from './subagent-presentation.ts'

interface SubagentPanelProps {
  active: boolean
  runtimeId: string
  parentSessionId: string | null
  subagents: readonly SubagentSummary[]
  skills: readonly SkillSummary[]
  projectDir: string | null
  page: SubagentPanelPage | null
  onSelect: (subagentId: string) => void
  onBack: () => void
}

export function SubagentPanelContent(props: SubagentPanelProps) {
  const requestedPage = props.active ? props.page : null
  const page = requestedPage
    ? resolveSubagentPanelPage(requestedPage, props.subagents)
      ?? resolveSubagentPanelPage({ kind: 'subagent-overview' }, props.subagents)
    : null
  return page?.kind === 'transcript' && props.parentSessionId
    ? (
        <SubagentTranscript
          key={`${props.parentSessionId}:${page.subagent.id}`}
          runtimeId={props.runtimeId}
          parentSessionId={props.parentSessionId}
          subagent={page.subagent}
          skills={props.skills}
          projectDir={props.projectDir}
          onBack={props.onBack}
        />
      )
    : page?.kind === 'overview'
      ? <SubagentList subagents={props.subagents} onSelect={props.onSelect} />
      : <div className="min-h-0 flex-1" />
}

function SubagentList({
  subagents,
  onSelect,
}: {
  subagents: readonly SubagentSummary[]
  onSelect: (subagentId: string) => void
}) {
  const groups = useMemo(() => {
    const running = subagents.filter((subagent) => isSubagentRunning(subagent.status))
    const completed = subagents.filter((subagent) => !isSubagentRunning(subagent.status))
    return [
      { id: 'running', label: '正在进行', items: running },
      { id: 'completed', label: '已结束', items: completed },
    ].filter((group) => group.items.length > 0)
  }, [subagents])
  return (
    <div className="wc-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
      {groups.map((group) => (
        <section key={group.id} className="mb-4 last:mb-0">
          <h2 className="mb-1.5 px-1 wc-type-caption font-medium text-[var(--wc-faint)]">
            {group.label} · {group.items.length}
          </h2>
          <div className="space-y-1">
            {group.items.map((subagent) => (
              <button
                key={subagent.id}
                type="button"
                className="wc-focus-ring flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-black/[0.045]"
                onClick={() => onSelect(subagent.id)}
              >
                <span className="mt-0.5 text-[var(--wc-muted)]">
                  <SubagentStatusIcon status={subagent.status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{subagent.name}</span>
                  <span className="mt-0.5 block truncate wc-type-caption text-[var(--wc-muted)]">
                    {subagent.description}
                  </span>
                </span>
                <span className="shrink-0 text-right wc-type-tiny font-normal text-[var(--wc-faint)]">
                  <span className="block">{subagentStatusLabel(subagent.status)}</span>
                  <span className="mt-0.5 block">
                    <TotalProcessingTime
                      completedDurationMs={subagent.completedDurationMs}
                      activeStartedAt={isSubagentRunning(subagent.status)
                        ? Date.parse(subagent.startedAt)
                        : null}
                    />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function SubagentStatusIcon({ status }: { status: SubagentStatus }) {
  switch (status) {
    case 'running': return <LoaderCircle size={14} className="animate-spin" />
    case 'completed': return <CheckCircle2 size={14} />
    case 'error': return <CircleAlert size={14} />
    case 'aborted': return <CircleStop size={14} />
    case 'limit': return <Gauge size={14} />
    case 'refusal': return <Ban size={14} />
  }
}

function SubagentTranscript({
  runtimeId,
  parentSessionId,
  subagent,
  skills,
  projectDir,
  onBack,
}: {
  runtimeId: string
  parentSessionId: string
  subagent: SubagentSummary
  skills: readonly SkillSummary[]
  projectDir: string | null
  onBack: () => void
}) {
  const [view, setView] = useState(() => createConversationState())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let hydrated = false
    let boundary = -1
    const pending: SubagentEventEnvelope[] = []
    const buffer = new ConversationEventBuffer({
      flush: (events) => setView((previous) => events.reduce(
        (current, entry) => applyCoreEvent(current, entry.event, entry.occurredAt),
        previous,
      )),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
    })
    const unsubscribe = window.whycode.onSubagentEvent((envelope) => {
      if (
        envelope.parentSessionId !== parentSessionId
        || envelope.subagentId !== subagent.id
      ) return
      if (!hydrated) {
        pending.push(envelope)
        return
      }
      if (envelope.sequence > boundary) {
        boundary = envelope.sequence
        buffer.push(envelope.event, envelope.occurredAt)
      }
    })
    void window.whycode.subagentTranscript(parentSessionId, subagent.id)
      .then((snapshot) => {
        if (disposed) return
        boundary = snapshot.eventSequence
        setView(createConversationState(
          snapshot.viewEvents,
          snapshot.viewEventTimestamps,
        ))
        hydrated = true
        for (const envelope of pending.splice(0).sort((left, right) => left.sequence - right.sequence)) {
          if (envelope.sequence <= boundary) continue
          boundary = envelope.sequence
          buffer.push(envelope.event, envelope.occurredAt)
        }
        setLoading(false)
      })
      .catch((reason) => {
        if (disposed) return
        hydrated = true
        setLoading(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      disposed = true
      unsubscribe()
      buffer.clear()
    }
  }, [parentSessionId, subagent.id])

  const sections = useMemo(
    () => conversationSections(
      view.blocks,
      isSubagentRunning(subagent.status) ? Date.parse(subagent.startedAt) : null,
    ),
    [subagent.startedAt, subagent.status, view.blocks],
  )
  const presentation = useMemo(
    () => presentBtwConversations(sections, view.expanded),
    [sections, view.expanded],
  )
  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-xs text-[var(--wc-faint)]">正在读取子代理记录…</div>
  }
  if (error) {
    return <div className="m-3 rounded-xl bg-[#f3e8e3] px-3 py-2 text-xs text-[var(--wc-danger)]">{error}</div>
  }
  return (
    <div className="wc-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="mb-3 flex items-center gap-2 border-b border-[var(--wc-line)] pb-3">
        <button
          type="button"
          className="wc-focus-ring flex size-7 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-[var(--wc-muted)] hover:bg-black/[0.07] hover:text-[var(--wc-ink)]"
          onClick={onBack}
          aria-label="返回子代理列表"
          title="返回子代理列表"
        >
          <ArrowLeft size={15} />
        </button>
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--wc-blue)] text-[var(--wc-blue-ink)]">
            <Bot size={14} />
          </span>
          <span className="truncate">{subagentProfileLabel(subagent.profile)}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 wc-type-caption text-[var(--wc-muted)]">
          {isSubagentRunning(subagent.status) && (
            <span className="text-[var(--wc-faint)]">
              <ProcessingTime startedAt={Date.parse(subagent.startedAt)} />
            </span>
          )}
          <span>{subagentStatusLabel(subagent.status)}</span>
        </span>
      </div>
      <ConversationView
        runtimeId={runtimeId}
        items={presentation.items}
        latestBtwConversationId={presentation.latestBtwConversationId}
        expandedIds={view.expanded}
        editableBlockId={null}
        busy={false}
        checkpointRestoreAnchorIds={EMPTY_IDS}
        checkpointRestoreToolUseId={null}
        fileRollbackBoundaryTurnId={view.fileRollbackBoundaryTurnId}
        showThinkingGap={false}
        forkSourceTurnId={null}
        forkPendingTurnId={null}
        skills={skills}
        projectDir={projectDir}
        onCheckpointRestoreRequest={async () => false}
        onEdit={async () => false}
        onFork={() => {}}
        onToggle={(id) => setView((previous) => toggleExpanded(previous, id))}
      />
    </div>
  )
}

const EMPTY_IDS = new Set<string>()
