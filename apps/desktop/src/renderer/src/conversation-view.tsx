import type { Block } from './conversation-state.ts'
import { BlockView } from './conversation-block.tsx'
import {
  conversationSections,
  type ConversationSection,
} from './conversation-sections.ts'
import { formatProcessingTime } from './processing-time.ts'

interface ConversationViewProps {
  runtimeId: string
  blocks: readonly Block[]
  expandedIds: ReadonlySet<string>
  editableBlockId: string | null
  busy: boolean
  checkpointRestoreToolUseId: string | null
  onCheckpointRestoreChange: (toolUseId: string, pending: boolean) => void
  onEdit: (turnId: string, text: string) => Promise<boolean>
  onToggle: (id: string) => void
}

export function ConversationView(props: ConversationViewProps) {
  return conversationSections(props.blocks).map((section) =>
    section.kind === 'block'
      ? <ConversationBlock key={section.id} {...props} block={section.block} />
      : <CompletedWorkSection key={section.id} {...props} section={section} />)
}

function CompletedWorkSection({
  section,
  ...props
}: ConversationViewProps & {
  section: Extract<ConversationSection, { kind: 'completed-work' }>
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
        durationMs={section.duration.durationMs}
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
  durationMs,
  expandable,
  expanded,
  onToggle,
}: {
  activityId: string
  durationMs: number
  expandable: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const label = formatProcessingTime(durationMs)
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
