import type { Block } from './conversation-state.ts'
import { BlockView } from './conversation-block.tsx'
import type { ConversationSection } from './conversation-sections.ts'
import { formatProcessingTime, ProcessingTime } from './processing-time.ts'

interface ConversationViewProps {
  runtimeId: string
  sections: readonly ConversationSection[]
  expandedIds: ReadonlySet<string>
  editableBlockId: string | null
  busy: boolean
  checkpointRestoreToolUseId: string | null
  onCheckpointRestoreChange: (toolUseId: string, pending: boolean) => void
  onEdit: (turnId: string, text: string) => Promise<boolean>
  onToggle: (id: string) => void
}

type WorkSectionData = Extract<
  ConversationSection,
  { kind: 'active-work' | 'completed-work' }
>

type WorkTiming =
  | { kind: 'active'; startedAt: number }
  | { kind: 'completed'; durationMs: number }

export function ConversationView(props: ConversationViewProps) {
  return props.sections.map((section) =>
    section.kind === 'block'
      ? <ConversationBlock key={section.id} {...props} block={section.block} />
      : <WorkSection key={section.id} {...props} section={section} />)
}

function WorkSection({
  section,
  ...props
}: ConversationViewProps & {
  section: WorkSectionData
}) {
  const expanded = section.activityBlocks.length > 0
    && props.expandedIds.has(section.id)
  const activityId = `work-activity-${section.id}`
  return (
    <>
      {section.userBlocks.map((block) => (
        <ConversationBlock key={block.id} {...props} block={block} />
      ))}
      <WorkSummary
        activityId={activityId}
        timing={section.kind === 'active-work'
          ? { kind: 'active', startedAt: section.startedAt }
          : { kind: 'completed', durationMs: section.duration.durationMs }}
        expandable={section.activityBlocks.length > 0}
        expanded={expanded}
        onToggle={() => props.onToggle(section.id)}
      />
      {expanded && (
        <div id={activityId}>
          {section.activityBlocks.map((block) => (
            <ConversationBlock key={block.id} {...props} block={block} />
          ))}
        </div>
      )}
      {section.finalBlocks.map((block) => (
        <ConversationBlock key={block.id} {...props} block={block} />
      ))}
    </>
  )
}

function ConversationBlock({
  block,
  runtimeId,
  expandedIds,
  editableBlockId,
  busy,
  checkpointRestoreToolUseId,
  onCheckpointRestoreChange,
  onEdit,
  onToggle,
}: ConversationViewProps & { block: Block }) {
  return (
    <BlockView
      runtimeId={runtimeId}
      block={block}
      editable={block.id === editableBlockId}
      expanded={expandedIds.has(block.id)}
      busy={busy}
      checkpointRestoreToolUseId={checkpointRestoreToolUseId}
      onCheckpointRestoreChange={onCheckpointRestoreChange}
      onEdit={onEdit}
      onToggle={() => onToggle(block.id)}
    />
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
    : formatProcessingTime(timing.durationMs)
  return (
    <div className="mb-2 px-3 text-xs text-neutral-400">
      {expandable ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-transparent hover:text-neutral-600 focus-visible:border-neutral-300 focus-visible:outline-none"
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
      <div className="mt-1 w-full border-t border-neutral-200" />
    </div>
  )
}
