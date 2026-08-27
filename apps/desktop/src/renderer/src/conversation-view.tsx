import { GitFork } from 'lucide-react'
import { memo } from 'react'
import type { Block } from './conversation-state.ts'
import { BlockView } from './conversation-block.tsx'
import type { ConversationDisplayItem } from './conversation-btw-groups.ts'
import {
  BtwConversationGroup,
  useAutomaticallyCollapsingBtwId,
} from './btw-conversation-group.tsx'
import {
  isForkBoundarySection,
  type ConversationSection,
} from './conversation-sections.ts'
import {
  assistantTextRenderState,
  sameConversationBlockRenderProps,
  type ConversationBlockRenderProps,
} from './conversation-render-cache.ts'
import { formatFinishedWorkTime, ProcessingTime } from './processing-time.ts'
import { ThinkingGapIndicator } from './thinking-gap-indicator.tsx'

interface ConversationViewProps {
  runtimeId: string
  items: readonly ConversationDisplayItem[]
  latestBtwConversationId: string | null
  expandedIds: ReadonlySet<string>
  editableBlockId: string | null
  busy: boolean
  checkpointRestoreAnchorIds: ReadonlySet<string>
  checkpointRestoreToolUseId: string | null
  showThinkingGap: boolean
  forkSourceTurnId: string | null
  forkPendingTurnId: string | null
  onCheckpointRestoreChange: (toolUseId: string, pending: boolean) => void
  onEdit: (block: Extract<Block, { kind: 'user' }>, text: string) => Promise<boolean>
  onFork: (turnId: string) => void
  onToggle: (id: string) => void
}

type WorkSectionData = Extract<
  ConversationSection,
  { kind: 'active-work' | 'completed-work' }
>

type WorkTiming =
  | { kind: 'active'; startedAt: number }
  | {
      kind: 'completed'
      durationMs: number
      outcome: 'completed' | 'stopped'
    }

export const ConversationView = memo(function ConversationView(props: ConversationViewProps) {
  const automaticallyCollapsingId = useAutomaticallyCollapsingBtwId(
    props.runtimeId,
    props.latestBtwConversationId,
  )

  return (
    <>
      {props.items.map((item) => item.kind === 'section'
        ? (
            <ConversationSectionView
              key={item.id}
              props={props}
              section={item.section}
            />
          )
        : (
            <BtwConversationGroup
              key={item.id}
              id={item.id}
              conversationId={item.conversationId}
              summary={item.summary}
              expanded={props.expandedIds.has(item.id)}
              automaticallyCollapse={item.id === automaticallyCollapsingId}
              onToggle={() => props.onToggle(item.id)}
            >
              {item.sections.map((section) => (
                <ConversationSectionView key={section.id} props={props} section={section} />
              ))}
            </BtwConversationGroup>
          ))}
      {props.showThinkingGap && <ThinkingGapIndicator />}
    </>
  )
})

function ConversationSectionView({
  props,
  section,
}: {
  props: ConversationViewProps
  section: ConversationSection
}) {
  if (section.kind === 'block') {
    return <ConversationBlock {...conversationBlockProps(props, section.block)} />
  }
  return (
    <div>
      <WorkSection {...props} section={section} />
      {isForkBoundarySection(section, props.forkSourceTurnId) ? <ForkBoundary /> : null}
    </div>
  )
}

function WorkSection({
  section,
  ...props
}: ConversationViewProps & {
  section: WorkSectionData
}) {
  const navigationEntryId = section.userBlocks.find((block) => block.kind === 'user')?.id
  const expanded = section.activityBlocks.length > 0
    && props.expandedIds.has(section.id)
  const activityId = `work-activity-${section.id}`
  return (
    <section
      className={section.kind === 'completed-work' ? 'wc-completed-work-section' : undefined}
      data-conversation-scroll-section={section.id}
      data-conversation-navigator-section={navigationEntryId}
      data-source-scope=""
    >
      {section.userBlocks.map((block) => (
        <ConversationBlock
          key={block.id}
          {...conversationBlockProps(props, block)}
        />
      ))}
      <WorkSummary
        activityId={activityId}
        timing={section.kind === 'active-work'
          ? { kind: 'active', startedAt: section.startedAt }
          : {
              kind: 'completed',
              durationMs: section.duration.durationMs,
              outcome: section.duration.outcome,
            }}
        expandable={section.activityBlocks.length > 0}
        expanded={expanded}
        onToggle={() => props.onToggle(section.id)}
      />
      {expanded && (
        <div id={activityId}>
          {section.activityBlocks.map((block) => (
            <ConversationBlock
              key={block.id}
              {...conversationBlockProps(props, block)}
              renderMath={
                section.kind === 'active-work'
                || section.duration.outcome === 'completed'
              }
            />
          ))}
        </div>
      )}
      {section.finalBlocks.map((block, index) => (
        <ConversationBlock
          key={block.id}
          {...conversationBlockProps(props, block)}
          streamingAssistantText={section.kind === 'active-work'}
          renderMath={
            section.kind === 'completed-work'
            && section.duration.outcome === 'completed'
          }
          showAssistantActions={
            section.kind === 'completed-work'
            && section.duration.outcome === 'completed'
          }
          forkTurnId={section.kind === 'completed-work'
            && index === section.finalBlocks.length - 1
            ? section.forkTurnId
            : null}
          forkPending={section.kind === 'completed-work'
            && section.forkTurnId === props.forkPendingTurnId}
        />
      ))}
    </section>
  )
}

const ConversationBlock = memo(function ConversationBlock({
  block,
  runtimeId,
  editable,
  expanded,
  busy,
  showCheckpointRestore,
  checkpointRestorePending,
  streamingAssistantText,
  renderMath,
  onCheckpointRestoreChange,
  onEdit,
  onToggle,
  showAssistantActions,
  forkTurnId,
  forkPending,
  onFork,
}: ConversationBlockRenderProps) {
  return (
    <BlockView
      runtimeId={runtimeId}
      block={block}
      editable={editable}
      expanded={expanded}
      busy={busy}
      showCheckpointRestore={showCheckpointRestore}
      checkpointRestorePending={checkpointRestorePending}
      streamingAssistantText={streamingAssistantText}
      renderMath={renderMath}
      onCheckpointRestoreChange={onCheckpointRestoreChange}
      onEdit={onEdit}
      onToggle={() => onToggle(block.id)}
      showAssistantActions={showAssistantActions}
      forkTurnId={forkTurnId}
      forkPending={forkPending}
      onFork={onFork}
    />
  )
}, sameConversationBlockRenderProps)

function conversationBlockProps(
  props: ConversationViewProps,
  block: Block,
): ConversationBlockRenderProps {
  const textRendering = assistantTextRenderState(block)
  const editable = block.id === props.editableBlockId
  const showCheckpointRestore = block.kind === 'tool'
    && props.checkpointRestoreAnchorIds.has(block.call.id)
  return {
    runtimeId: props.runtimeId,
    block,
    editable,
    expanded: props.expandedIds.has(block.id),
    busy: editable || showCheckpointRestore ? props.busy : false,
    showCheckpointRestore,
    checkpointRestorePending: block.kind === 'tool'
      && props.checkpointRestoreToolUseId === block.call.id,
    ...textRendering,
    showAssistantActions: false,
    forkTurnId: null,
    forkPending: false,
    onCheckpointRestoreChange: props.onCheckpointRestoreChange,
    onEdit: props.onEdit,
    onFork: props.onFork,
    onToggle: props.onToggle,
  }
}

function ForkBoundary() {
  return (
    <div className="mb-4 flex items-center gap-3 px-1 text-xs text-[var(--wc-faint)]">
      <span className="h-px flex-1 bg-[var(--wc-line)]" />
      <span className="flex items-center gap-1 text-[var(--wc-blue-ink)]">
        <GitFork size={13} /> 从聊天中继续
      </span>
      <span className="h-px flex-1 bg-[var(--wc-line)]" />
    </div>
  )
}

function WorkSummary({
  activityId,
  timing,
  expandable,
  expanded,
  onToggle,
}: {
  activityId: string
  timing: WorkTiming
  expandable: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const label = timing.kind === 'active'
    ? <ProcessingTime startedAt={timing.startedAt} />
    : formatFinishedWorkTime(timing.durationMs, timing.outcome)
  return (
    <div className="mb-3 px-1 text-xs text-[var(--wc-faint)]">
      {expandable ? (
        <button
          type="button"
          className="wc-focus-ring inline-flex items-center gap-1 rounded-lg px-1 py-0.5 hover:text-[var(--wc-muted)]"
          aria-controls={activityId}
          aria-expanded={expanded}
          title={expanded ? '收起处理过程' : '展开处理过程'}
          onClick={onToggle}
        >
          <span>{label}</span>
          <span
            aria-hidden="true"
            className={`inline-block text-sm transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            ›
          </span>
        </button>
      ) : (
        <span>{label}</span>
      )}
      <div className="mt-1.5 w-full border-t border-[var(--wc-line)]" />
    </div>
  )
}
