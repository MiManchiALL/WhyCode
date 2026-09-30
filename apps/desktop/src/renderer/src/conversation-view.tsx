import type { SkillSummary } from '@whycode/core/skills'
import { readPresentationResult } from '@whycode/core/presentation'
import { ResponseFooter } from './response-footer.tsx'
import { ResponseSourcesContext, responsePresentationResult, responseSources } from './response-presentation.ts'
import { AlertCircle, GitFork } from 'lucide-react'
import { memo, useDeferredValue, useLayoutEffect, useMemo, useRef } from 'react'
import { SessionLoading } from './session-loading.tsx'
import type { Block } from '../../shared/conversation-state.ts'
import { BlockView } from './conversation-block.tsx'
import type { ConversationDisplayItem } from './conversation-btw-groups.ts'
import {
  BtwConversationGroup,
  useAutomaticallyCollapsingBtwId,
} from './btw-conversation-group.tsx'
import {
  isFileRollbackBoundarySection,
  isForkBoundarySection,
  shouldSealTrailingToolBatch,
  type ConversationSection,
} from '../../shared/conversation-sections.ts'
import {
  assistantTextRenderState,
  sameConversationBlockRenderProps,
  type ConversationBlockRenderProps,
} from './conversation-render-cache.ts'
import { formatFinishedWorkTime } from './processing-time.ts'
import type { CheckpointRestoreRequest } from './checkpoint-restore-controls.ts'
import {
  presentConversationToolBatches,
  presentToolBatches,
  type ConversationToolBatchDisplayItem,
  type ToolBatch,
  type ToolBatchSegment,
} from './conversation-tool-batches.ts'
import { ToolBatchGroup } from './tool-batch-group.tsx'
import { ToolBatchSegmentView } from './tool-batch-segment.tsx'
import type { RightPanelPage } from './right-panel-state.ts'
import { useCheckpointRestoreNavigation } from './checkpoint-restore-navigation.ts'
import type { ConversationScrollAlignment } from './conversation-scroll.ts'

interface ConversationViewProps {
  remote?: boolean
  runtimeId: string
  pendingSessionId?: string | null
  onReady?: () => void
  active?: boolean
  items: readonly ConversationDisplayItem[]
  latestBtwConversationId: string | null
  expandedIds: ReadonlySet<string>
  editableBlockId: string | null
  busy: boolean
  checkpointRestoreAnchorIds: ReadonlySet<string>
  checkpointRestoreToolUseId: string | null
  fileRollbackBoundaryTurnId: string | null
  forkSourceTurnId: string | null
  forkPendingTurnId: string | null
  skills: readonly SkillSummary[]
  projectDir: string | null
  onCheckpointRestoreRequest: CheckpointRestoreRequest
  onEdit: (block: Extract<Block, { kind: 'user' }>, text: string, restoreFiles: boolean) => Promise<boolean>
  onFork: (turnId: string) => void
  onOpenFilePreview?: (page: Extract<RightPanelPage, { kind: 'file' }>) => void
  onOpenChanges?: (page: Extract<RightPanelPage, { kind: 'changes' }>) => void
  onNavigate?: (target: HTMLElement, alignment: ConversationScrollAlignment) => void
  onToggle: (id: string) => void
}

type WorkSectionData = Extract<
  ConversationSection,
  { kind: 'active-work' | 'completed-work' }
>

type WorkTiming =
  | { kind: 'active' }
  | {
      kind: 'completed'
      durationMs: number
      outcome: 'completed' | 'stopped' | 'error'
    }

function useNewlySealedToolSegmentIds(
  runtimeId: string,
  items: readonly ConversationToolBatchDisplayItem[],
): ReadonlySet<string> {
  const currentStates = toolSegmentSealStates(items)
  const previousRef = useRef<{
    runtimeId: string
    states: ReadonlyMap<string, boolean>
  } | null>(null)
  const previousStates = previousRef.current?.runtimeId === runtimeId
    ? previousRef.current.states
    : new Map<string, boolean>()
  const newlySealed = new Set<string>()
  for (const [id, sealed] of currentStates) {
    if (sealed && previousStates.get(id) === false) newlySealed.add(id)
  }
  useLayoutEffect(() => {
    previousRef.current = { runtimeId, states: currentStates }
  })
  return newlySealed
}

function toolSegmentSealStates(
  items: readonly ConversationToolBatchDisplayItem[],
): ReadonlyMap<string, boolean> {
  const states = new Map<string, boolean>()
  const collectSection = (section: ConversationSection) => {
    if (section.kind === 'block') return
    for (const item of presentToolBatches(
      section.activityBlocks,
      shouldSealTrailingToolBatch(section),
    )) {
      if (item.kind === 'tool-segment') states.set(item.id, item.sealed)
    }
  }

  for (const item of items) {
    if (item.kind === 'tool-segment') {
      states.set(item.id, item.sealed)
    } else if (item.kind === 'section') {
      collectSection(item.section)
    } else {
      for (const section of item.sections) collectSection(section)
    }
  }
  return states
}

export const ConversationView = memo(function ConversationView(props: ConversationViewProps) {
  const deferred = useDeferredValue(props)
  const rendering = deferred.runtimeId !== props.runtimeId
  // 读取与渲染共用一次等待生命周期，阶段交接不能重建提示并重启其显示延迟。
  const pending = !!props.pendingSessionId || rendering
  useLayoutEffect(() => {
    if (!pending && props.active !== false) props.onReady?.()
  }, [pending, props.runtimeId, props.onReady, props.active, props.items])
  return (
    <>
      {pending && <SessionLoading />}
      <div hidden={pending} inert={props.active === false}>
        <ConversationContents {...(pending || props.active === false ? deferred : props)} />
      </div>
    </>
  )
})

const ConversationContents = memo(function ConversationContents(props: ConversationViewProps) {
  const automaticallyCollapsingId = useAutomaticallyCollapsingBtwId(
    props.runtimeId,
    props.latestBtwConversationId,
  )
  const items = presentConversationToolBatches(props.items)
  const newlySealedSegmentIds = useNewlySealedToolSegmentIds(props.runtimeId, items)

  return (
    <>
      {items.map((item) => item.kind === 'section'
        ? (
            <ConversationSectionView
              key={item.id}
              props={props}
              section={item.section}
              newlySealedSegmentIds={newlySealedSegmentIds}
            />
          )
        : item.kind === 'btw-group' ? (
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
                <ConversationSectionView
                  key={section.id}
                  props={props}
                  section={section}
                  newlySealedSegmentIds={newlySealedSegmentIds}
                />
              ))}
            </BtwConversationGroup>
          ) : (
            <ConversationToolSegment
              key={item.id}
              props={props}
              segment={item}
              animateOnMount={newlySealedSegmentIds.has(item.id)}
            />
          ))}
    </>
  )
})

function ConversationSectionView({
  props,
  section,
  newlySealedSegmentIds,
}: {
  props: ConversationViewProps
  section: ConversationSection
  newlySealedSegmentIds: ReadonlySet<string>
}) {
  const showFileRollbackBoundary = isFileRollbackBoundarySection(
    section,
    props.fileRollbackBoundaryTurnId,
  )
  if (section.kind === 'block') {
    return (
      <>
        {showFileRollbackBoundary ? <FileRollbackBoundary /> : null}
        <ConversationBlock {...conversationBlockProps(props, section.block)} />
      </>
    )
  }
  return (
    <div>
      {showFileRollbackBoundary ? <FileRollbackBoundary /> : null}
      <WorkSection
        {...props}
        section={section}
        newlySealedSegmentIds={newlySealedSegmentIds}
      />
      {isForkBoundarySection(section, props.forkSourceTurnId) ? <ForkBoundary /> : null}
    </div>
  )
}

function WorkSection({
  section,
  newlySealedSegmentIds,
  ...props
}: ConversationViewProps & {
  section: WorkSectionData
  newlySealedSegmentIds: ReadonlySet<string>
}) {
  const navigationEntryId = section.userBlocks.find((block) => block.kind === 'user')?.id
  const expanded = section.activityBlocks.length > 0
    && props.expandedIds.has(section.id)
  const activityId = `work-activity-${section.id}`
  const completed = section.kind === 'completed-work' && section.duration.outcome === 'completed'
  const presentationResult = completed ? responsePresentationResult(section.activityBlocks) : null
  const presentation = useMemo(
    () => presentationResult === null ? null : readPresentationResult(presentationResult),
    [presentationResult],
  )
  // 分组数组随会话投影重建；以正文值作为依赖，避免其它轮次的流式更新重复解析历史。
  const responseText = completed ? JSON.stringify(section.finalBlocks.flatMap(block => block.kind === 'text' ? [block.text] : [])) : null
  const sources = useMemo(() => responseText === null ? null : responseSources(JSON.parse(responseText) as string[]), [responseText])
  const activityItems = presentToolBatches(
    section.activityBlocks,
    shouldSealTrailingToolBatch(section),
  )
  const restoreNavigation = useCheckpointRestoreNavigation({
    runtimeId: props.runtimeId, sectionId: section.id, items: activityItems,
    anchors: props.checkpointRestoreAnchorIds, expandedIds: props.expandedIds,
    onToggle: props.onToggle, onNavigate: props.onNavigate,
  })
  return (
    <section
      ref={restoreNavigation.ref}
      className={section.kind === 'completed-work' ? 'wc-completed-work-section' : undefined}
      data-conversation-scroll-section={section.id}
      data-conversation-navigator-section={navigationEntryId}
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
          ? { kind: 'active' }
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
          {activityItems.map((item) => item.kind === 'tool-segment'
            ? (
                <ConversationToolSegment
                  key={item.id}
                  props={props}
                  segment={item}
                  animateOnMount={newlySealedSegmentIds.has(item.id)}
                  renderMath={
                    section.kind === 'active-work'
                    || section.duration.outcome === 'completed'
                  }
                />
              )
            : (
                <ConversationBlock
                  key={item.id}
                  {...conversationBlockProps(props, item.block)}
                  renderMath={
                    section.kind === 'active-work'
                    || section.duration.outcome === 'completed'
                  }
                />
              ))}
        </div>
      )}
      {section.kind === 'completed-work' && section.duration.outcome === 'error' && section.duration.error && (
        <div className="wc-type-caption mb-4 flex items-start gap-2 px-1 text-[var(--wc-muted)]" role="status">
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-[var(--wc-danger)]" />
          <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{section.duration.error}</span>
        </div>
      )}
      <ResponseSourcesContext value={sources}>
        <div className="group" data-source-scope="">
          {section.finalBlocks.map((block) => (
            <ConversationBlock
              key={block.id}
              {...conversationBlockProps(props, block)}
              streamingAssistantText={section.kind === 'active-work'}
              renderMath={completed}
            />
          ))}
          {completed && (
            <ResponseFooter key={`${props.runtimeId}:${section.id}`} runtimeId={props.runtimeId} projectDir={props.projectDir}
              remote={props.remote}
              activity={section.activityBlocks} final={section.finalBlocks} presentation={presentation} onOpenFile={props.onOpenFilePreview}
              onOpenChanges={props.onOpenChanges}
              onRevealRestore={props.busy ? undefined : restoreNavigation.navigate}
              onFork={section.forkTurnId && !props.busy ? () => props.onFork(section.forkTurnId!) : undefined}
              forkPending={section.forkTurnId !== null && section.forkTurnId === props.forkPendingTurnId} />
          )}
        </div>
      </ResponseSourcesContext>
    </section>
  )
}

function ConversationToolSegment({
  props,
  segment,
  animateOnMount,
  renderMath,
}: {
  props: ConversationViewProps
  segment: ToolBatchSegment
  animateOnMount: boolean
  renderMath?: boolean
}) {
  return (
    <ToolBatchSegmentView
      segment={segment}
      animateOnMount={animateOnMount}
      batchExpanded={props.expandedIds.has(segment.batch.id)}
      renderBlock={(block) => {
        const blockProps = conversationBlockProps(props, block)
        return (
          <ConversationBlock
            {...blockProps}
            renderMath={renderMath ?? blockProps.renderMath}
          />
        )
      }}
      renderBatch={(batch) => <ConversationToolBatch props={props} batch={batch} />}
    />
  )
}

function ConversationToolBatch({
  props,
  batch,
}: {
  props: ConversationViewProps
  batch: ToolBatch
}) {
  return (
    <ToolBatchGroup
      runtimeId={props.runtimeId}
      batch={batch}
      expandedIds={props.expandedIds}
      busy={props.busy}
      checkpointRestoreAnchorIds={props.checkpointRestoreAnchorIds}
      checkpointRestoreToolUseId={props.checkpointRestoreToolUseId}
      skills={props.skills}
      projectDir={props.projectDir}
      onCheckpointRestoreRequest={props.onCheckpointRestoreRequest}
      onOpenFilePreview={props.onOpenFilePreview}
      onToggle={props.onToggle}
    />
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
  onCheckpointRestoreRequest,
  onEdit,
  onToggle,
  skills,
  projectDir,
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
      onCheckpointRestoreRequest={onCheckpointRestoreRequest}
      onEdit={onEdit}
      onToggle={() => onToggle(block.id)}
      skills={skills}
      projectDir={projectDir}
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
    skills: props.skills,
    projectDir: props.projectDir,
    onCheckpointRestoreRequest: props.onCheckpointRestoreRequest,
    onEdit: props.onEdit,
    onToggle: props.onToggle,
  }
}

function ForkBoundary() {
  return (
    <div className="wc-type-caption mb-4 flex items-center gap-3 px-1 text-[var(--wc-faint)]">
      <span className="h-px flex-1 bg-[var(--wc-line)]" />
      <span className="flex items-center gap-1 text-[var(--wc-blue-ink)]">
        <GitFork size={13} /> 从聊天中继续
      </span>
      <span className="h-px flex-1 bg-[var(--wc-line)]" />
    </div>
  )
}

function FileRollbackBoundary() {
  return (
    <div className="wc-type-caption mb-3 rounded-xl bg-[var(--wc-rollback)] px-3 py-2 text-[var(--wc-rollback-ink)]" data-conversation-timeline-marker="rollback">
      文件已回退至此检查点
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
    ? '处理过程'
    : formatFinishedWorkTime(timing.durationMs, timing.outcome)
  return (
    <div className="wc-type-caption mb-3 px-1 text-[var(--wc-faint)]">
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
