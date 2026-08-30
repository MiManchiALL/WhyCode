import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from 'react'
// 注意：Renderer 只能从浏览器安全的子路径导入运行时值；从 '@whycode/core' 根导入值会把
// Node 内置模块拖进渲染端导致白屏（types 导入不受此限）
import type { PermissionMode } from '@whycode/core/permissions'
import type { SkillSummary } from '@whycode/core/skills'
import type {
  BackgroundTaskState,
  BackgroundTaskSummary,
  BtwMode,
  CoreCommand,
  ReasoningEffortSelection,
  SessionForkOrigin,
  SubagentState,
  SubagentSummary,
} from '@whycode/core'
import {
  formatUserQuestionAnswer,
  type AgentStatus,
  type ContextUsageInfo,
  type CoreEvent,
  type QueuedUserMessage,
} from '@whycode/core/events'
import type {
  RuntimeEventEnvelope,
  RuntimeSnapshot,
  SessionListItem,
} from '../../shared/session.ts'
import type { ConnectionSettingsSnapshot, ModelListItem } from '../../shared/settings.ts'
import { attachmentFallbackText } from '../../shared/user-message.ts'
import {
  workspaceDisplayDirectory,
  type RuntimeWorkspace,
  type StartWorkspaceRequest,
  type WorkspaceCandidate,
} from '../../shared/workspace.ts'
import {
  applyCoreEvent,
  appendNotice,
  checkpointRestoreAnchorIds,
  createConversationState,
  editableUserBlockId,
  runtimeEventsAfterSnapshot,
  resumeTargetCommitted,
  toggleExpanded,
  voteLabel,
  type Block,
} from './conversation-state.ts'
import {
  isCurrentSessionDeletion,
  preserveDeletionTarget,
} from './session-deletion-state.ts'
import { QuestionCard } from './question-card.tsx'
import { ProcessingTime } from './processing-time.ts'
import { ConversationView } from './conversation-view.tsx'
import { ConversationNavigator } from './conversation-navigator.tsx'
import { presentBtwConversations } from './conversation-btw-groups.ts'
import {
  conversationSections,
  findLatestForkTurnId,
  shouldShowComposerProcessingTime,
} from './conversation-sections.ts'
import { thinkingGapRevealDelay } from './thinking-gap.ts'
import { ConnectionSettingsPanel } from './connection-settings-panel.tsx'
import {
  ImageDraftStrip,
  QueuedImageStrip,
  useImageDrafts,
} from './image-attachments.tsx'
import {
  prepareImageDrafts,
  releaseImageDrafts,
  restoredImageDrafts,
  type ImageDraft,
} from './image-draft.ts'
import { collectPastedImageFiles, collectPastedPdfFiles } from './image-paste.ts'
import { useAttachmentDropTarget } from './image-drop.ts'
import {
  PdfDraftStrip,
  QueuedPdfStrip,
  usePdfDrafts,
} from './pdf-attachments.tsx'
import {
  preparePdfDrafts,
  restoredPdfDrafts,
  type PdfDraft,
} from './pdf-draft.ts'
import { composerKeyAction, composerPrimaryAction } from './composer-key.ts'
import type { WorkspaceStartChoice } from './workspace-start-controls.tsx'
import { WorkspaceContextBar } from './workspace-context-bar.tsx'
import { SkillBadges, SkillChips, ComposerSlashMenu } from './skill-picker.tsx'
import { useSkillComposer } from './use-skill-composer.ts'
import type { ComposerCommandId } from './skill-trigger.ts'
import { AppSidebar } from './app-sidebar.tsx'
import { TaskHeader } from './task-header.tsx'
import { ComposerToolbar } from './composer-toolbar.tsx'
import { TaskInspector } from './task-inspector.tsx'
import { SubagentPanel } from './subagent-panel.tsx'
import { WorktreePreparation } from './worktree-preparation.tsx'
import type { SubagentPanelPage } from './subagent-presentation.ts'
import { ApprovalCard, type Approval } from './approval-card.tsx'
import {
  applyExpandedOverrides,
  ConversationPresentationCache,
  type ConversationScrollPosition,
} from './conversation-presentation.ts'
import {
  captureConversationScrollPosition,
  restoreConversationScrollPosition,
  scrollConversationToTarget,
} from './conversation-scroll.ts'
import { ConversationEventBuffer } from './conversation-event-buffer.ts'
import { subscribeRuntimeEventBatches } from './runtime-event-stream.ts'

export function App() {
  const [runtimeId, setRuntimeId] = useState('')
  const [view, setView] = useState(() => createConversationState())
  const [input, setInput] = useState('')
  const [btwMode, setBtwModeState] = useState<BtwMode | null>(null)
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [workStartedAt, setWorkStartedAt] = useState<number | null>(null)
  const [stopping, setStopping] = useState(false)
  const [sessionTransitionPending, setSessionTransitionPending] = useState(false)
  const [questionSubmitting, setQuestionSubmitting] = useState(false)
  const [attachmentSubmissionPending, setAttachmentSubmissionPending] = useState(false)
  const [models, setModels] = useState<ModelListItem[]>([])
  const [modelId, setModelId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortSelection>('default')
  const [contextUsage, setContextUsage] = useState<ContextUsageInfo | null>(null)
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskSummary[]>([])
  const [worktreeStatusRevision, setWorktreeStatusRevision] = useState(0)
  const [subagents, setSubagents] = useState<SubagentSummary[]>([])
  const [subagentPanelOpen, setSubagentPanelOpen] = useState(false)
  const [subagentPanelRetained, setSubagentPanelRetained] = useState(false)
  const [subagentPanelPage, setSubagentPanelPage] = useState<SubagentPanelPage | null>(null)
  const [showConnectionSettings, setShowConnectionSettings] = useState(false)
  const [connectionSettings, setConnectionSettings] =
    useState<ConnectionSettingsSnapshot | null>(null)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [workspace, setWorkspace] = useState<RuntimeWorkspace>({ mode: 'none' })
  const [worktreePreparation, setWorktreePreparation] = useState<{
    message: string
    baseRef: string | null
  } | null>(null)
  const [queued, setQueued] = useState<QueuedUserMessage[]>([])
  const [restoredInputIds, setRestoredInputIds] = useState<string[]>([])
  const [restoredQueue, setRestoredQueue] = useState<QueuedUserMessage[]>([])
  const [restoredSubmissionPending, setRestoredSubmissionPending] = useState(false)
  const [permMode, setPermMode] = useState<PermissionMode>('default')
  const [consensus, setConsensus] = useState<{ ready: boolean; reason: string | null; enabled: boolean }>({ ready: false, reason: null, enabled: false })
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [sessionListError, setSessionListError] = useState<string | null>(null)
  const [sessionActionError, setSessionActionError] = useState<string | null>(null)
  const [workspaceCandidate, setWorkspaceCandidate] = useState<WorkspaceCandidate | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [deletionBlocksRuntime, setDeletionBlocksRuntimeState] = useState(false)
  const [resumingSessionId, setResumingSessionIdState] = useState<string | null>(null)
  const [checkpointRestoreToolUseId, setCheckpointRestoreToolUseId] = useState<string | null>(null)
  const [forkOrigin, setForkOrigin] = useState<SessionForkOrigin | null>(null)
  const [forkPendingTurnId, setForkPendingTurnId] = useState<string | null>(null)
  /** 协商进行中的状态条文案（null = 无协商） */
  const [negoStatus, setNegoStatus] = useState<string | null>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const conversationContentRef = useRef<HTMLDivElement>(null)
  const questionSubmittingRef = useRef(false)
  const sessionTransitionPendingRef = useRef(false)
  const resumingSessionIdRef = useRef<string | null>(null)
  const ownsResumeRequestRef = useRef(false)
  const deletingSessionIdRef = useRef<string | null>(null)
  const deletionBlocksRuntimeRef = useRef(false)
  const runtimeIdRef = useRef('')
  const sessionIdRef = useRef<string | null>(null)
  const activeSnapshotSequenceRef = useRef(0)
  const sessionListRefreshInFlightRef = useRef<Promise<void> | null>(null)
  const sessionListRefreshRequestedRef = useRef(false)
  const backgroundTaskRevisionRef = useRef(-1)
  const backgroundTaskStatesRef = useRef(new Map<string, BackgroundTaskState>())
  const subagentRevisionRef = useRef(-1)
  const subagentStatesRef = useRef(new Map<string, SubagentState>())
  const hydratingRuntimeIdRef = useRef<string | null>(null)
  const backgroundEventsRef = useRef(new Map<string, {
    event: CoreEvent
    sequence: number
    sessionId: string | null
    occurredAt: string
  }[]>())
  const composerDraftsRef = useRef(new Map<string, {
    text: string
    images: ImageDraft[]
    pdfs: PdfDraft[]
    skills: SkillSummary[]
    btwMode: BtwMode | null
  }>())
  const conversationPresentationsRef = useRef(new ConversationPresentationCache())
  const pendingScrollRestoreRef = useRef<ConversationScrollPosition | null>(null)
  const conversationScrollReleaseRef = useRef<(() => void) | null>(null)
  const expandedIdsRef = useRef(view.expanded)
  expandedIdsRef.current = view.expanded
  /** 贴底跟随：仅当用户本就在底部附近才自动滚动；往上翻阅时不打扰 */
  const stickToBottom = useRef(true)
  const [showJumpBottom, setShowJumpBottom] = useState(false)
  const inputRef = useRef('')
  const btwModeRef = useRef<BtwMode | null>(null)
  const slashCommandRef = useRef<(command: ComposerCommandId) => void>(() => {})
  const conversationEventBufferRef = useRef<ConversationEventBuffer | null>(null)
  if (!conversationEventBufferRef.current) {
    conversationEventBufferRef.current = new ConversationEventBuffer({
      flush: (events) => {
        setView((previous) => events.reduce(
          (current, { event, occurredAt }) => applyCoreEvent(current, event, occurredAt),
          previous,
        ))
      },
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
    })
  }
  const applyConversationEvent = useCallback((event: CoreEvent, occurredAt?: string) => {
    conversationEventBufferRef.current!.push(event, occurredAt)
  }, [])
  const blocks = view.blocks
  const projectDir = workspaceDisplayDirectory(workspace)
  const explicitProjectSelected = workspace.mode !== 'pending-managed' && Boolean(projectDir)
  const conversationStarted = blocks.some((block) => block.kind === 'user')
  const sections = useMemo(
    () => conversationSections(blocks, workStartedAt),
    [blocks, workStartedAt],
  )
  const btwPresentation = useMemo(
    () => presentBtwConversations(sections, view.expanded),
    [sections, view.expanded],
  )
  const releaseConversationScroll = useCallback(() => {
    const release = conversationScrollReleaseRef.current
    conversationScrollReleaseRef.current = null
    release?.()
  }, [])
  const navigateConversation = useCallback((targetId: string) => {
    const scroller = scrollRef.current
    if (!scroller) return
    releaseConversationScroll()
    const navigation = scrollConversationToTarget(scroller, targetId)
    if (!navigation) return
    conversationScrollReleaseRef.current = navigation.release
    stickToBottom.current = false
    setShowJumpBottom(true)
  }, [releaseConversationScroll])
  const latestForkTurnId = useMemo(() => findLatestForkTurnId(sections), [sections])
  const setBtwMode = useCallback((mode: BtwMode | null) => {
    btwModeRef.current = mode
    setBtwModeState(mode)
  }, [])
  const {
    catalog: skillCatalog,
    selected: selectedSkills,
    trigger: skillTrigger,
    matches: composerMenuItems,
    activeIndex: skillActiveIndex,
    limitReached: skillLimitReached,
    textareaRef: composerTextareaRef,
    capture: captureSkills,
    clear: clearSkills,
    replace: replaceSkills,
    mergeRestored: mergeRestoredSkills,
    remove: removeSelectedSkill,
    select: selectComposerMenuItem,
    resetCatalog: resetSkillCatalog,
    updateMenu: updateSkillMenu,
    closeMenu: closeSkillMenu,
    setActiveIndex: setSkillActiveIndex,
    handlePickerKeyDown,
  } = useSkillComposer({
    input,
    setInput,
    inputRef,
    runtimeId,
    runtimeIdRef,
    modelId,
    projectDir,
    workspaceMode: workspace.mode,
    compactAvailable: conversationStarted,
    compactDisabled: status !== 'idle'
      && status !== 'error',
    forkAvailable: latestForkTurnId !== null
      && (status === 'idle' || status === 'error'),
    forkDisabled: sessionTransitionPending || forkPendingTurnId !== null,
    btwAvailable: latestForkTurnId !== null && (status === 'idle' || status === 'error'),
    bbtwAvailable: latestForkTurnId !== null
      && view.btwContinuation !== null
      && (status === 'idle' || status === 'error'),
    skillsEnabled: btwMode === null,
    onCommand: (command) => slashCommandRef.current(command),
  })
  const checkpointRestoreAnchors = useMemo(
    () => checkpointRestoreAnchorIds(view),
    [view.blocks, view.turnStartBlocks],
  )
  const composerProcessingTimeVisible =
    shouldShowComposerProcessingTime(workStartedAt, sections)
  const thinkingGapDelay = thinkingGapRevealDelay({
    blocks,
    status,
    stopping,
    workStartedAt,
  })
  const [thinkingGapIdleTarget, setThinkingGapIdleTarget] = useState<{
    runtimeId: string
    blocks: readonly Block[]
  } | null>(null)
  useEffect(() => {
    if (thinkingGapDelay === null || thinkingGapDelay === 0) {
      setThinkingGapIdleTarget(null)
      return
    }
    const observedBlocks = blocks
    const timer = window.setTimeout(
      () => setThinkingGapIdleTarget({ runtimeId, blocks: observedBlocks }),
      thinkingGapDelay,
    )
    return () => window.clearTimeout(timer)
  }, [blocks, runtimeId, thinkingGapDelay])
  const thinkingGapVisible = thinkingGapDelay === 0
    || (
      thinkingGapDelay !== null
      && thinkingGapIdleTarget?.runtimeId === runtimeId
      && thinkingGapIdleTarget.blocks === blocks
    )
  const addError = useCallback((text: string) => {
    applyConversationEvent({ type: 'error', message: text, recoverable: true })
  }, [applyConversationEvent])
  const {
    drafts: imageDrafts,
    addFiles: addImageFiles,
    remove: removeImageDraft,
    clear: clearImageDrafts,
    detach: detachImageDrafts,
    restore: restoreImageDrafts,
  } = useImageDrafts(addError)
  const {
    drafts: pdfDrafts,
    addFiles: addPdfFiles,
    remove: removePdfDraft,
    clear: clearPdfDrafts,
    detach: detachPdfDrafts,
    restore: restorePdfDrafts,
  } = usePdfDrafts(addError)


  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => () => {
    conversationEventBufferRef.current?.clear()
    for (const draft of composerDraftsRef.current.values()) {
      releaseImageDrafts(draft.images)
    }
    composerDraftsRef.current.clear()
  }, [])

  const stashActiveComposer = useCallback(() => {
    const currentRuntimeId = runtimeIdRef.current
    if (!currentRuntimeId) return
    const currentSessionId = sessionIdRef.current
    const images = detachImageDrafts()
    const pdfs = detachPdfDrafts()
    const text = inputRef.current
    const skills = captureSkills()
    const currentBtwMode = btwModeRef.current
    // 尚未产生 JSONL 的空白页没有历史入口，切走后不能再导航回来。
    if (!currentSessionId) {
      releaseImageDrafts(images)
      return
    }
    const key = composerKey(currentRuntimeId, currentSessionId)
    if (text || images.length > 0 || pdfs.length > 0 || skills.length > 0 || currentBtwMode) {
      composerDraftsRef.current.set(key, {
        text,
        images,
        pdfs,
        skills,
        btwMode: currentBtwMode,
      })
    } else {
      composerDraftsRef.current.delete(key)
    }
  }, [captureSkills, detachImageDrafts, detachPdfDrafts])

  const stashActivePresentation = useCallback(() => {
    const currentRuntimeId = runtimeIdRef.current
    const scrollElement = scrollRef.current
    if (!currentRuntimeId || !scrollElement) return
    const key = composerKey(currentRuntimeId, sessionIdRef.current)
    conversationPresentationsRef.current.saveScroll(
      key,
      captureConversationScrollPosition(scrollElement),
    )
  }, [])

  const resetActiveComposer = useCallback(() => {
    const currentRuntimeId = runtimeIdRef.current
    const currentSessionId = sessionIdRef.current
    const key = composerKey(currentRuntimeId, currentSessionId)
    const detachedDraft = composerDraftsRef.current.get(key)
    if (detachedDraft) releaseImageDrafts(detachedDraft.images)
    composerDraftsRef.current.delete(key)
    backgroundEventsRef.current.delete(currentRuntimeId)
    inputRef.current = ''
    setInput('')
    clearSkills()
    clearImageDrafts()
    clearPdfDrafts()
    setBtwMode(null)
  }, [clearImageDrafts, clearPdfDrafts, clearSkills, setBtwMode])

  const setResumingSessionId = useCallback((sessionId: string | null) => {
    resumingSessionIdRef.current = sessionId
    setResumingSessionIdState(sessionId)
  }, [])

  const setDeletionBlocksRuntime = useCallback((blocked: boolean) => {
    deletionBlocksRuntimeRef.current = blocked
    setDeletionBlocksRuntimeState(blocked)
  }, [])

  const setDeletingSession = useCallback((sessionId: string | null) => {
    deletingSessionIdRef.current = sessionId
    setDeletingSessionId(sessionId)
  }, [])

  const beginSessionTransition = useCallback(() => {
    if (sessionTransitionPendingRef.current) return false
    sessionTransitionPendingRef.current = true
    setSessionTransitionPending(true)
    return true
  }, [])

  const endSessionTransition = useCallback(() => {
    sessionTransitionPendingRef.current = false
    setSessionTransitionPending(false)
  }, [])

  const sendRuntimeCommand = useCallback((command: CoreCommand) => {
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId) return Promise.resolve({ ok: false })
    return window.whycode.sendCommand(targetRuntimeId, command)
  }, [])

  const restoreQueuedDrafts = useCallback((items: readonly QueuedUserMessage[]) => {
    if (items.length === 0) return
    setRestoredQueue((previous) => {
      const known = new Set(previous.map((item) => item.id))
      return [...previous, ...items.filter((item) => !known.has(item.id))]
    })
  }, [])

  // 恢复输入保持原消息边界：一条确认提交后才激活下一条，避免多条各 4 图被扁平截断。
  useEffect(() => {
    if (
      restoredQueue.length === 0
      || restoredInputIds.length > 0
      || restoredSubmissionPending
      || input.trim()
      || imageDrafts.length > 0
      || pdfDrafts.length > 0
      || selectedSkills.length > 0
    ) return
    const next = restoredQueue[0]!
    setRestoredQueue((previous) => previous.filter((item) => item.id !== next.id))
    setInput(next.text)
    restoreImageDrafts(restoredImageDrafts([next]))
    restorePdfDrafts(restoredPdfDrafts([next]))
    replaceSkills(next.skills ?? [])
    setRestoredInputIds([next.id])
  }, [
    imageDrafts.length,
    pdfDrafts.length,
    input,
    restoreImageDrafts,
    restorePdfDrafts,
    replaceSkills,
    restoredInputIds.length,
    restoredQueue,
    restoredSubmissionPending,
    selectedSkills.length,
  ])

  const refreshSessions = useCallback(async () => {
    sessionListRefreshRequestedRef.current = true
    if (sessionListRefreshInFlightRef.current) {
      return sessionListRefreshInFlightRef.current
    }
    const refresh = async () => {
      do {
        sessionListRefreshRequestedRef.current = false
        try {
          const next = await window.whycode.listSessions()
          setSessions((current) => sameSessionList(current, next) ? current : next)
          setSessionListError(null)
        } catch (error) {
          setSessionListError(
            `会话历史读取失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } while (sessionListRefreshRequestedRef.current)
    }
    const inFlight = refresh().finally(() => {
      if (sessionListRefreshInFlightRef.current === inFlight) {
        sessionListRefreshInFlightRef.current = null
      }
    })
    sessionListRefreshInFlightRef.current = inFlight
    return inFlight
  }, [])

  const refreshModelCatalog = useCallback(async () => {
    const targetRuntimeId = runtimeIdRef.current
    const nextModels = await window.whycode.listModels(targetRuntimeId || undefined)
    if (runtimeIdRef.current !== targetRuntimeId) return
    setModels(nextModels)
  }, [])

  const applyBackgroundTaskState = useCallback((state: BackgroundTaskState) => {
    if (
      state.sessionId !== sessionIdRef.current
      || state.revision <= backgroundTaskRevisionRef.current
    ) return
    backgroundTaskRevisionRef.current = state.revision
    setBackgroundTasks(state.tasks)
    setWorktreeStatusRevision((revision) => revision + 1)
  }, [])

  const applySubagentState = useCallback((state: SubagentState) => {
    if (
      state.parentSessionId !== sessionIdRef.current
      || state.revision <= subagentRevisionRef.current
    ) return
    subagentRevisionRef.current = state.revision
    setSubagents(state.subagents)
    setWorktreeStatusRevision((revision) => revision + 1)
  }, [])

  const applyRuntimeSnapshot = useCallback((snapshot: RuntimeSnapshot) => {
    const changingRuntime = runtimeIdRef.current !== snapshot.runtimeId
    const changingSession = sessionIdRef.current !== snapshot.sessionId
    if (changingRuntime) {
      stashActiveComposer()
      stashActivePresentation()
    }
    if (changingRuntime) hydratingRuntimeIdRef.current = snapshot.runtimeId
    runtimeIdRef.current = snapshot.runtimeId
    sessionIdRef.current = snapshot.sessionId
    if (changingSession) {
      backgroundTaskRevisionRef.current = -1
      setBackgroundTasks([])
      subagentRevisionRef.current = -1
      setSubagents([])
      setSubagentPanelPage(null)
    }
    if (snapshot.backgroundTasks) {
      applyBackgroundTaskState(snapshot.backgroundTasks)
      const buffered = backgroundTaskStatesRef.current.get(snapshot.backgroundTasks.sessionId)
      if (buffered) {
        applyBackgroundTaskState(buffered)
        backgroundTaskStatesRef.current.delete(buffered.sessionId)
      }
    }
    if (snapshot.subagents) {
      applySubagentState(snapshot.subagents)
      const buffered = subagentStatesRef.current.get(snapshot.subagents.parentSessionId)
      if (buffered) {
        applySubagentState(buffered)
        subagentStatesRef.current.delete(buffered.parentSessionId)
      }
    }
    activeSnapshotSequenceRef.current = snapshot.eventSequence
    setRuntimeId(snapshot.runtimeId)
    if (changingRuntime) {
      resetSkillCatalog()
      const key = composerKey(snapshot.runtimeId, snapshot.sessionId)
      const draft = composerDraftsRef.current.get(key)
      composerDraftsRef.current.delete(key)
      setInput(draft?.text ?? '')
      setBtwMode(draft?.btwMode ?? null)
      replaceSkills(draft?.skills ?? [])
      if (draft) {
        restoreImageDrafts(draft.images)
        restorePdfDrafts(draft.pdfs)
      }
    }
    const presentation = conversationPresentationsRef.current.get(
      composerKey(snapshot.runtimeId, snapshot.sessionId),
    )
    const replayedView = createConversationState(
      snapshot.viewEvents,
      snapshot.viewEventTimestamps,
    )
    conversationEventBufferRef.current?.clear()
    setView({
      ...replayedView,
      expanded: applyExpandedOverrides(
        replayedView.expanded,
        presentation?.expandedOverrides,
      ),
    })
    if (changingRuntime) {
      const scroll = presentation?.scroll ?? { atBottom: true, scrollTop: 0 }
      pendingScrollRestoreRef.current = scroll
      stickToBottom.current = scroll.atBottom
      setShowJumpBottom(!scroll.atBottom)
    }
    setWorkspace(snapshot.workspace)
    if (changingRuntime) setWorktreePreparation(null)
    setPermMode(snapshot.permissionMode)
    setContextUsage(snapshot.contextUsage)
    setWorkStartedAt(snapshot.workStartedAt)
    setStatus(snapshot.status)
    setDeletingSessionId((current) => {
      const next = preserveDeletionTarget(current, snapshot.deletingSessionId)
      deletingSessionIdRef.current = next
      return next
    })
    setDeletionBlocksRuntime(Boolean(snapshot.deletingSessionId))
    setResumingSessionId(snapshot.resumingSessionId)
    setCheckpointRestoreToolUseId(snapshot.checkpointRestoreToolUseId)
    setStopping(false)
    setQueued(snapshot.queuedInputs)
    setRestoredInputIds([])
    setRestoredQueue(snapshot.restoredInputs)
    setRestoredSubmissionPending(false)
    setApproval(snapshot.approval)
    setModelId(snapshot.modelId ?? '')
    setReasoningEffort(snapshot.reasoningEffort)
    setForkOrigin(snapshot.forkOrigin)
    setForkPendingTurnId(null)
  }, [
    applyBackgroundTaskState,
    applySubagentState,
    restoreImageDrafts,
    restorePdfDrafts,
    replaceSkills,
    resetSkillCatalog,
    setBtwMode,
    setDeletionBlocksRuntime,
    setResumingSessionId,
    stashActiveComposer,
    stashActivePresentation,
  ])

  const synchronizeUnownedResume = useCallback(async () => {
    const targetSessionId = resumingSessionIdRef.current
    if (!targetSessionId || ownsResumeRequestRef.current) return
    try {
      const snapshot = await window.whycode.runtimeSnapshot()
      if (resumeTargetCommitted(snapshot, targetSessionId)) {
        applyRuntimeSnapshot(snapshot)
        void window.whycode.consensusStatus().then(setConsensus)
        void refreshSessions()
        void refreshModelCatalog()
        return
      }
      if (snapshot.resumingSessionId) return
      setResumingSessionId(null)
      setStatus(snapshot.status)
      setSessionActionError('会话恢复失败，当前会话未更改')
    } catch (error) {
      setResumingSessionId(null)
      const message = `恢复完成后的运行态同步失败：${error instanceof Error ? error.message : String(error)}`
      setSessionActionError(message)
      addError(message)
    }
  }, [
    addError,
    applyRuntimeSnapshot,
    refreshModelCatalog,
    refreshSessions,
    setResumingSessionId,
  ])

  const consumeEvent = useCallback((event: CoreEvent, occurredAt?: string) => {
    applyConversationEvent(event, occurredAt)
    switch (event.type) {
      case 'work-started':
        setWorkStartedAt(event.startedAt)
        void refreshSessions()
        break
      case 'turn-start':
        // 后台唤醒先进入 work，再在回合起点写稳会话活动时间；这里确认最近顺序。
        void refreshSessions()
        break
      case 'work-finished':
        setWorkStartedAt(null)
        setWorktreeStatusRevision((revision) => revision + 1)
        void refreshSessions()
        break
      case 'tool-end':
        setWorktreeStatusRevision((revision) => revision + 1)
        break
      case 'agent-status':
        setStatus(event.status)
        if (event.status !== 'waiting-approval') setApproval(null)
        if (event.status === 'idle' || event.status === 'error') {
          setStopping(false)
          // work-finished 在 Main 中先于权威终态发布；再读一次列表，避免首次快照
          // 恰好仍观察到 busy 而让侧栏运行标记滞留。
          void refreshSessions()
        }
        if (event.status === 'idle') setNegoStatus(null)
        if (
          (event.status === 'idle' || event.status === 'error')
          && resumingSessionIdRef.current
          && !ownsResumeRequestRef.current
        ) void synchronizeUnownedResume()
        break
      case 'turn-end':
        void refreshSessions()
        break
      case 'context-usage':
        setContextUsage(event.usage)
        break
      case 'checkpoint-restored':
        setCheckpointRestoreToolUseId((current) =>
          current === event.toolUseId ? null : current,
        )
        break
      case 'message-queued':
        // 运行中插话不会重复发 work-started，但已是新的用户活动。
        void refreshSessions()
        setQueued((prev) => [...prev, {
          id: event.id,
          text: event.text,
          ...(event.attachments?.length ? { attachments: event.attachments } : {}),
          ...(event.pdfAttachments?.length ? { pdfAttachments: event.pdfAttachments } : {}),
          ...(event.skills?.length ? { skills: event.skills } : {}),
        }])
        break
      case 'message-injected':
        setQueued((prev) => prev.filter((q) => q.id !== event.id))
        break
      case 'queue-restored':
        setQueued([])
        if (event.items?.length) restoreQueuedDrafts(event.items)
        else setInput((prev) => (prev ? `${prev}\n${event.text}` : event.text))
        break
      case 'approval-request':
        setApproval({
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          reason: event.reason,
          diff: event.diff,
          suggestion: event.suggestion,
        })
        break
      case 'vote-cast':
        setNegoStatus((prev) =>
          prev ? `${event.from} 已投票（${voteLabel(event.vote)}）· 等待其余评审…` : prev,
        )
        break
      case 'negotiation-started':
        setNegoStatus('B、C 正在独立评审 M1…')
        break
      case 'round-started':
        setNegoStatus(event.round === 2 ? '第二轮：Main 修订候选，B/C 再评…' : '第三轮：最终兜底决策…')
        break
      case 'execution-started':
        setNegoStatus(null)
        break
      default:
        break
    }
  }, [
    applyConversationEvent,
    refreshSessions,
    restoreQueuedDrafts,
    setDeletionBlocksRuntime,
    synchronizeUnownedResume,
  ])

  useEffect(() => {
    if (!runtimeId) return
    const buffered = (backgroundEventsRef.current.get(runtimeId) ?? [])
      .sort((left, right) => left.sequence - right.sequence)
    backgroundEventsRef.current.delete(runtimeId)
    for (const entry of buffered) {
      if (entry.sequence <= activeSnapshotSequenceRef.current) continue
      sessionIdRef.current = entry.sessionId
      consumeEvent(entry.event, entry.occurredAt)
    }
    if (hydratingRuntimeIdRef.current === runtimeId) {
      hydratingRuntimeIdRef.current = null
    }
  }, [consumeEvent, runtimeId])

  useEffect(() => {
    return window.whycode.onBackgroundTasks((state) => {
      if (
        state.sessionId === sessionIdRef.current
        && hydratingRuntimeIdRef.current === null
      ) {
        applyBackgroundTaskState(state)
        return
      }
      const states = backgroundTaskStatesRef.current
      const previous = states.get(state.sessionId)
      if (previous && previous.revision >= state.revision) return
      states.delete(state.sessionId)
      states.set(state.sessionId, state)
      if (states.size > 8) {
        const oldestSessionId = states.keys().next().value
        if (oldestSessionId) states.delete(oldestSessionId)
      }
    })
  }, [applyBackgroundTaskState])

  useEffect(() => window.whycode.onSessionDeletion((state) => {
    if (deletingSessionIdRef.current === state.sessionId) {
      setDeletingSession(null)
      setDeletionBlocksRuntime(false)
    }
    if (state.status === 'failed') {
      setSessionActionError(`会话删除未完成：${state.error}`)
    }
    void refreshSessions()
  }), [refreshSessions, setDeletingSession, setDeletionBlocksRuntime])

  useEffect(() => {
    if (subagentPanelOpen) setSubagentPanelRetained(true)
  }, [subagentPanelOpen])

  useEffect(() => {
    return window.whycode.onSubagents((state) => {
      if (
        state.parentSessionId === sessionIdRef.current
        && hydratingRuntimeIdRef.current === null
      ) {
        applySubagentState(state)
        return
      }
      const states = subagentStatesRef.current
      const previous = states.get(state.parentSessionId)
      if (previous && previous.revision >= state.revision) return
      states.delete(state.parentSessionId)
      states.set(state.parentSessionId, state)
      if (states.size > 8) {
        const oldestSessionId = states.keys().next().value
        if (oldestSessionId) states.delete(oldestSessionId)
      }
    })
  }, [applySubagentState])

  useEffect(() => {
    void window.whycode.listModels().then(setModels)
    void window.whycode.consensusStatus().then(setConsensus)
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    let disposed = false
    let hydrated = false
    const buffered: {
      event: CoreEvent
      sequence: number
      runtimeId: string
      sessionId: string | null
      occurredAt: string
    }[] = []
    const acceptEvent = ({
      event,
      sequence,
      runtimeId: eventRuntimeId,
      sessionId: eventSessionId,
      occurredAt,
    }: RuntimeEventEnvelope) => {
      if (!hydrated) {
        buffered.push({
          event,
          sequence,
          runtimeId: eventRuntimeId,
          sessionId: eventSessionId,
          occurredAt,
        })
        return
      }
      if (
        eventRuntimeId === runtimeIdRef.current
        && hydratingRuntimeIdRef.current !== eventRuntimeId
      ) {
        sessionIdRef.current = eventSessionId
        consumeEvent(event, occurredAt)
      } else if (
        event.type === 'work-started'
        || event.type === 'turn-start'
        || event.type === 'work-finished'
        || event.type === 'turn-end'
        || (
          event.type === 'agent-status'
          && (event.status === 'idle' || event.status === 'error')
        )
      ) {
        void refreshSessions()
      }
      if (
        eventRuntimeId !== runtimeIdRef.current
        || hydratingRuntimeIdRef.current === eventRuntimeId
      ) {
        if (
          !backgroundEventsRef.current.has(eventRuntimeId)
          && backgroundEventsRef.current.size >= 8
        ) {
          const oldestRuntimeId = backgroundEventsRef.current.keys().next().value
          if (oldestRuntimeId) backgroundEventsRef.current.delete(oldestRuntimeId)
        }
        const pending = backgroundEventsRef.current.get(eventRuntimeId) ?? []
        pending.push({ event, sequence, sessionId: eventSessionId, occurredAt })
        if (pending.length > 512) pending.splice(0, pending.length - 512)
        backgroundEventsRef.current.set(eventRuntimeId, pending)
      }
      if (
        event.type === 'agent-status'
        && (event.status === 'idle' || event.status === 'error')
        && resumingSessionIdRef.current
        && !ownsResumeRequestRef.current
      ) {
        void synchronizeUnownedResume()
      }
    }
    const eventSubscription = subscribeRuntimeEventBatches((events) => {
      for (const event of events) acceptEvent(event)
    })
    void eventSubscription.ready.then(() => window.whycode.runtimeSnapshot()).then((snapshot) => {
      if (disposed) return
      applyRuntimeSnapshot(snapshot)
      hydrated = true
      const pendingEvents = runtimeEventsAfterSnapshot(
        buffered.splice(0).filter((entry) => entry.runtimeId === snapshot.runtimeId),
        snapshot.eventSequence,
      )
      for (const entry of pendingEvents) consumeEvent(entry.event, entry.occurredAt)
      void refreshSessions()
    }).catch(() => {
      if (disposed) return
      hydrated = true
      for (const bufferedEvent of buffered.splice(0)) {
        if (bufferedEvent.runtimeId === runtimeIdRef.current) {
          consumeEvent(bufferedEvent.event, bufferedEvent.occurredAt)
        }
      }
    })
    return () => {
      disposed = true
      eventSubscription.unsubscribe()
    }
  }, [
    applyRuntimeSnapshot,
    consumeEvent,
    refreshSessions,
    synchronizeUnownedResume,
  ])

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current
    const scrollElement = scrollRef.current
    if (!pending || !scrollElement) return releaseConversationScroll
    pendingScrollRestoreRef.current = null
    releaseConversationScroll()
    const restoration = restoreConversationScrollPosition(pending, scrollElement)
    conversationScrollReleaseRef.current = restoration.release
    stickToBottom.current = restoration.position.atBottom
    setShowJumpBottom(!restoration.position.atBottom)
    return releaseConversationScroll
  }, [releaseConversationScroll, runtimeId])

  useEffect(() => {
    const scrollElement = scrollRef.current
    const contentElement = conversationContentRef.current
    if (!scrollElement || !contentElement) return
    // Markdown/公式与离屏段变为真实高度后，贴底语义仍应指向新的真实底部。
    const observer = new ResizeObserver(() => {
      if (!stickToBottom.current) return
      scrollElement.scrollTop = scrollElement.scrollHeight
      setShowJumpBottom(false)
    })
    observer.observe(contentElement)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (stickToBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }
  }, [blocks, approval, thinkingGapVisible])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    stickToBottom.current = nearBottom
    setShowJumpBottom(!nearBottom)
  }, [])

  const jumpToBottom = useCallback(() => {
    stickToBottom.current = true
    setShowJumpBottom(false)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [])

  const busy = status !== 'idle' && status !== 'error'
  const interactionBusy = busy
    || sessionTransitionPending
    || attachmentSubmissionPending
    || deletionBlocksRuntime
    || resumingSessionId !== null
    || checkpointRestoreToolUseId !== null
  const editableBlockId = !interactionBusy && !stopping
    ? editableUserBlockId(blocks)
    : null
  const attachmentLocked = stopping
    || sessionTransitionPending
    || attachmentSubmissionPending
    || deletionBlocksRuntime
    || resumingSessionId !== null
    || checkpointRestoreToolUseId !== null
  const sessionChangeLocked = deletionBlocksRuntime
    || resumingSessionId !== null
    || sessionTransitionPending
    || attachmentSubmissionPending
    || restoredSubmissionPending

  const changeCheckpointRestore = useCallback((toolUseId: string, pending: boolean) => {
    setCheckpointRestoreToolUseId((current) =>
      pending ? (current ?? toolUseId) : current === toolUseId ? null : current,
    )
  }, [])

  const activateNewSession = useCallback(async (
    workspaceRequest?: StartWorkspaceRequest,
  ): Promise<boolean> => {
    const result = await window.whycode.newSession(
      workspaceRequest ? { workspace: workspaceRequest } : undefined,
    )
    if (!result.ok) {
      setWorkspaceCandidate(null)
      addError(result.error ?? '新建会话失败')
      return false
    }
    applyRuntimeSnapshot(result.snapshot)
    setWorkspaceCandidate(null)
    void window.whycode.consensusStatus().then(setConsensus)
    void refreshSessions()
    void refreshModelCatalog()
    return true
  }, [addError, applyRuntimeSnapshot, refreshModelCatalog, refreshSessions])

  const pickProject = useCallback(() => {
    if (!beginSessionTransition()) return
    void window.whycode.pickProjectDir().then(async (candidate) => {
      if (!candidate) return
      const activated = await activateNewSession({
        mode: 'local',
        selectedDirectory: candidate.selectedDirectory,
      })
      if (activated && candidate.repositoryDirectory) setWorkspaceCandidate(candidate)
    }).catch((error) => {
      addError(`工作文件夹检查失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(endSessionTransition)
  }, [
    activateNewSession,
    addError,
    beginSessionTransition,
    endSessionTransition,
  ])

  const toggleConsensus = useCallback(() => {
    const enabled = !consensus.enabled
    void sendRuntimeCommand({ type: 'set-consensus', enabled })
      .then((r) => {
        if (r && r.ok) setConsensus((prev) => ({ ...prev, enabled }))
      })
  }, [consensus.enabled, sendRuntimeCommand])

  const stop = useCallback(() => {
    if (stopping) return
    setStopping(true)
    setApproval(null)
    void sendRuntimeCommand({ type: 'abort' }).catch(() => {
      setStopping(false)
      addError('停止请求发送失败，请重试')
    })
  }, [addError, sendRuntimeCommand, stopping])

  const startNewSession = useCallback(() => {
    if (!beginSessionTransition()) return
    setWorkspaceCandidate(null)
    void activateNewSession()
      .catch((error) => {
        addError(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(endSessionTransition)
  }, [activateNewSession, addError, beginSessionTransition, endSessionTransition])

  const startWorkspaceSession = useCallback((choice: WorkspaceStartChoice) => {
    const candidate = workspaceCandidate
    if (!candidate || !beginSessionTransition()) return
    const workspaceRequest = choice.mode === 'local'
      ? {
          mode: 'local' as const,
          selectedDirectory: candidate.selectedDirectory,
        }
      : {
          mode: 'worktree' as const,
          selectedDirectory: candidate.selectedDirectory,
          baseRef: choice.base.ref,
          expectedBaseCommit: choice.base.commit,
          acknowledgeUncommittedChangesExcluded: candidate.dirty,
        }
    void activateNewSession(workspaceRequest).then(() => {
      setWorkspaceCandidate(candidate)
    }).catch((error) => {
      setWorkspaceCandidate(candidate)
      addError(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(endSessionTransition)
  }, [
    addError,
    activateNewSession,
    beginSessionTransition,
    endSessionTransition,
    workspaceCandidate,
  ])

  const resumeSession = useCallback((sessionId: string) => {
    if (resumingSessionIdRef.current || sessionTransitionPendingRef.current) return
    ownsResumeRequestRef.current = true
    setSessionActionError(null)
    setResumingSessionId(sessionId)
    void window.whycode.resumeSession(sessionId).then(async (result) => {
      // Main 的事件保留在对话中；面板同时显示结果，避免遮罩让失败提示不可见。
      if (!result.ok) {
        setSessionActionError(result.error)
        return
      }
      applyRuntimeSnapshot(result.snapshot)
      setSessionActionError(null)
      void window.whycode.consensusStatus().then(setConsensus)
      void refreshSessions()
      void refreshModelCatalog()
    }).catch((error) => {
      const message = `会话恢复请求失败：${error instanceof Error ? error.message : String(error)}`
      setSessionActionError(message)
      addError(message)
    }).finally(() => {
      ownsResumeRequestRef.current = false
      if (resumingSessionIdRef.current === sessionId) setResumingSessionId(null)
    })
  }, [
    addError,
    applyRuntimeSnapshot,
    refreshModelCatalog,
    refreshSessions,
    setResumingSessionId,
  ])

  const deleteSession = useCallback((sessionId: string) => {
    if (
      deletingSessionIdRef.current
      || resumingSessionIdRef.current
      || sessionTransitionPendingRef.current
    ) return
    setSessionActionError(null)
    setDeletingSession(sessionId)
    // 同步关闭删除当前会话与切换之间的点击竞态；Main 接管后立即切到替代会话。
    setDeletionBlocksRuntime(isCurrentSessionDeletion(sessionIdRef.current, sessionId))
    let cleanupPending = false
    void window.whycode.deleteSession(sessionId).then(async (result) => {
      cleanupPending = result.ok && result.cleanupPending
      if (result.ok || result.deletedCurrent) {
        const detachedDraft = composerDraftsRef.current.get(sessionId)
        if (detachedDraft) releaseImageDrafts(detachedDraft.images)
        composerDraftsRef.current.delete(sessionId)
        conversationPresentationsRef.current.delete(sessionId)
        for (const [eventRuntimeId, events] of backgroundEventsRef.current) {
          if (events.some((entry) => entry.sessionId === sessionId)) {
            backgroundEventsRef.current.delete(eventRuntimeId)
          }
        }
      }
      if (result.deletedCurrent) {
        resetActiveComposer()
        if (result.snapshot) applyRuntimeSnapshot(result.snapshot)
        conversationPresentationsRef.current.delete(sessionId)
        void window.whycode.consensusStatus().then(setConsensus)
      }
      if (!result.ok) setSessionActionError(result.error ?? '删除会话失败')
    }).catch(() => {
      setSessionActionError('删除会话失败，请重试')
    }).finally(() => {
      if (!cleanupPending) {
        setDeletingSession(null)
        setDeletionBlocksRuntime(false)
      }
      void refreshSessions()
    })
  }, [
    applyRuntimeSnapshot,
    refreshSessions,
    resetActiveComposer,
    setDeletionBlocksRuntime,
    setDeletingSession,
  ])

  const setSessionPinned = useCallback((sessionId: string, pinned: boolean) => {
    setSessionActionError(null)
    void window.whycode.setSessionPinned({ sessionId, pinned }).then((result) => {
      if (!result.ok) {
        setSessionActionError(result.error)
        return
      }
      void refreshSessions()
    }).catch((error) => {
      setSessionActionError(
        `更新会话置顶状态失败：${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }, [refreshSessions])

  const compact = useCallback(() => {
    if (status !== 'idle' && status !== 'error') return
    setView((previous) =>
      appendNotice(previous, '正在压缩上下文（生成摘要中，可点停止取消）…'),
    )
    void sendRuntimeCommand({ type: 'compact' })
  }, [sendRuntimeCommand, status])
  const forkConversation = useCallback((sourceTurnId: string) => {
    if (status !== 'idle' && status !== 'error') return
    const sourceSessionId = sessionIdRef.current
    if (!sourceSessionId || !beginSessionTransition()) return
    setForkPendingTurnId(sourceTurnId)
    setSessionActionError(null)
    void window.whycode.forkSession({ sourceSessionId, sourceTurnId }).then((result) => {
      if (!result.ok) {
        setSessionActionError(result.error)
        return
      }
      applyRuntimeSnapshot(result.snapshot)
      void window.whycode.consensusStatus().then(setConsensus)
      void refreshSessions()
      void refreshModelCatalog()
    }).catch((error) => {
      const message = `创建会话分支失败：${error instanceof Error ? error.message : String(error)}`
      setSessionActionError(message)
      addError(message)
    }).finally(() => {
      setForkPendingTurnId(null)
      endSessionTransition()
    })
  }, [
    addError,
    applyRuntimeSnapshot,
    beginSessionTransition,
    endSessionTransition,
    refreshModelCatalog,
    refreshSessions,
    status,
  ])
  slashCommandRef.current = (command) => {
    if (command === 'compact') compact()
    if (command === 'fork' && latestForkTurnId) forkConversation(latestForkTurnId)
    if (command === 'btw' || command === 'bbtw') {
      if (status !== 'idle' && status !== 'error') return
      if (command === 'bbtw' && !view.btwContinuation) {
        addError('当前没有可续接的 BTW 对话')
        return
      }
      if (pdfDrafts.length > 0 || selectedSkills.length > 0 || restoredInputIds.length > 0) {
        addError('BTW 不使用 PDF、Skill 或恢复队列输入；请先移除这些内容')
        return
      }
      const currentModel = models.find((model) => model.id === modelId)
      if (imageDrafts.length > 0 && currentModel?.imageInputMode !== 'native') {
        addError('BTW 图片必须由当前模型原生读取')
        return
      }
      setBtwMode(command)
    }
  }

  const changePermission = useCallback((mode: PermissionMode) => {
    const previous = permMode
    setPermMode(mode)
    const rollback = () => setPermMode((current) => current === mode ? previous : current)
    void sendRuntimeCommand({ type: 'set-permission-mode', mode }).then((result) => {
      if (!result || !result.ok) rollback()
    }).catch(rollback)
  }, [permMode, sendRuntimeCommand])

  const changeModel = useCallback((next: string) => {
    const nextModel = models.find((model) => model.id === next)
    if (!nextModel?.available) {
      addError(nextModel?.unavailableReason ?? '该模型连接当前不可用')
      return
    }
    if (
      imageDrafts.length > 0
      && (btwMode ? nextModel.imageInputMode !== 'native' : nextModel.imageInputMode === 'none')
    ) {
      addError(btwMode
        ? 'BTW 图片必须由当前模型原生读取'
        : '已添加图片；目标模型既不支持原生识图，也没有可用的辅助识图模型')
      return
    }
    const previous = modelId
    const previousReasoningEffort = reasoningEffort
    setModelId(next)
    setReasoningEffort('default')
    const rollback = () => {
      setModelId((current) => current === next ? previous : current)
      setReasoningEffort((current) =>
        current === 'default' ? previousReasoningEffort : current,
      )
    }
    void sendRuntimeCommand({ type: 'set-model', modelId: next }).then((result) => {
      if (!result || !result.ok) rollback()
    }).catch(rollback)
  }, [addError, btwMode, imageDrafts.length, modelId, models, reasoningEffort, sendRuntimeCommand])

  const changeReasoningEffort = useCallback((next: ReasoningEffortSelection) => {
    const previous = reasoningEffort
    setReasoningEffort(next)
    const rollback = () => setReasoningEffort((current) => current === next ? previous : current)
    void sendRuntimeCommand({
      type: 'set-reasoning-effort',
      reasoningEffort: next,
    }).then((result) => {
      if (!result || !result.ok) rollback()
    }).catch(rollback)
  }, [reasoningEffort, sendRuntimeCommand])

  const openConnectionSettings = useCallback(() => {
    void window.whycode.connectionSettings().then((snapshot) => {
      setConnectionSettings(snapshot)
      setShowConnectionSettings(true)
    }).catch((error) => {
      addError(`连接设置读取失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [addError])

  const openCurrentWorkspaceFolder = useCallback(() => {
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId) return
    void window.whycode.openWorkspaceFolder(targetRuntimeId).then((result) => {
      if (!result.ok) addError(result.error)
    }).catch((error) => {
      addError(`打开工作文件夹失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [addError])

  const prepareCommitPrompt = useCallback(() => {
    const prompt = '请检查当前 Worktree 的改动，先总结将要提交的内容，再创建合适的提交；如果已经配置远程且适合推送，再推送当前分支。'
    setInput((current) => {
      const next = current.trim() ? `${current.trimEnd()}\n\n${prompt}` : prompt
      inputRef.current = next
      return next
    })
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus()
    })
  }, [composerTextareaRef])

  const applyConnectionSettings = useCallback((snapshot: ConnectionSettingsSnapshot) => {
    setConnectionSettings(snapshot)
    void window.whycode.consensusStatus().then(setConsensus)
    void refreshModelCatalog().catch((error) => {
      addError(`模型列表刷新失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [addError, refreshModelCatalog])

  const send = useCallback((urgent = false) => {
    if (
      stopping
      || sessionTransitionPending
      || deletionBlocksRuntime
      || resumingSessionId
      || checkpointRestoreToolUseId
      || attachmentSubmissionPending
    ) return
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId) return
    const sentBtwMode = btwModeRef.current
    const sentSkills = captureSkills()
    if (
      sentBtwMode
      && (pdfDrafts.length > 0 || sentSkills.length > 0 || restoredInputIds.length > 0)
    ) {
      addError('BTW 不使用 PDF、Skill 或恢复队列输入')
      return
    }
    const text = input.trim()
      || attachmentFallbackText(imageDrafts.length, sentBtwMode ? 0 : pdfDrafts.length)
      || (imageDrafts.length === 0 && sentSkills.length ? '请按所选 Skill 执行。' : '')
    if (!text && imageDrafts.length === 0) return
    const preparingWorktree = !conversationStarted && workspace.mode === 'pending-worktree'
    if (preparingWorktree) {
      setWorktreePreparation({ message: text, baseRef: workspace.baseRef })
    }
    const sentImageDrafts = detachImageDrafts()
    const sentPdfDrafts = detachPdfDrafts()
    const sentRestoredInputIds = restoredInputIds
    setRestoredInputIds([])
    if (sentRestoredInputIds.length > 0) setRestoredSubmissionPending(true)
    // IPC 确认持久化并交给目标 Agent 前，暂不允许切换；否则失败恢复可能落入另一对话。
    setAttachmentSubmissionPending(true)
    setInput('')
    inputRef.current = ''
    clearSkills()
    setBtwMode(null)
    // 自己发消息 = 主动行为，恢复贴底跟随
    stickToBottom.current = true
    setShowJumpBottom(false)
    const restoreRejectedInput = () => {
      setInput((current) => {
        const restored = text && current ? `${text}\n${current}` : text || current
        inputRef.current = restored
        return restored
      })
      restoreImageDrafts(sentImageDrafts)
      restorePdfDrafts(sentPdfDrafts)
      mergeRestoredSkills(sentSkills)
      setBtwMode(sentBtwMode)
      setRestoredInputIds((current) => [
        ...new Set([...sentRestoredInputIds, ...current]),
      ])
    }
    void (async () => {
      try {
        const attachments = await prepareImageDrafts(sentImageDrafts)
        const pdfAttachments = preparePdfDrafts(sentPdfDrafts)
        const result = await window.whycode.sendCommand(
          targetRuntimeId,
          sentBtwMode
            ? {
                type: 'btw-message',
                mode: sentBtwMode,
                text,
                ...(attachments.length ? { attachments } : {}),
              }
            : {
                type: 'user-message',
                text,
                urgent,
                ...(attachments.length ? { attachments } : {}),
                ...(pdfAttachments.length ? { pdfAttachments } : {}),
                ...(sentSkills.length
                  ? { skills: sentSkills.map(({ id, path }) => ({ id, path })) }
                  : {}),
                ...(sentRestoredInputIds.length
                  ? { restoredInputIds: sentRestoredInputIds }
                  : {}),
              },
        )
        if (result?.workspace && runtimeIdRef.current === targetRuntimeId) {
          setWorkspace(result.workspace)
        }
        if (result?.ok) {
          releaseImageDrafts(sentImageDrafts)
          return
        }
        restoreRejectedInput()
      } catch {
        restoreRejectedInput()
        addError(sentImageDrafts.length || sentPdfDrafts.length
          ? '附件读取或消息发送失败，内容已恢复到输入框'
          : '消息发送失败，内容已恢复到输入框')
      } finally {
        if (preparingWorktree && runtimeIdRef.current === targetRuntimeId) {
          setWorktreePreparation(null)
        }
        setAttachmentSubmissionPending(false)
        if (sentRestoredInputIds.length > 0) setRestoredSubmissionPending(false)
      }
    })()
  }, [
    addError,
    attachmentSubmissionPending,
    captureSkills,
    checkpointRestoreToolUseId,
    clearSkills,
    conversationStarted,
    deletionBlocksRuntime,
    detachImageDrafts,
    detachPdfDrafts,
    imageDrafts.length,
    input,
    mergeRestoredSkills,
    pdfDrafts.length,
    restoredInputIds,
    restoreImageDrafts,
    restorePdfDrafts,
    resumingSessionId,
    sessionTransitionPending,
    stopping,
    setBtwMode,
    workspace,
  ])

  const answerQuestion = useCallback((answers: string[]) => {
    const question = view.pendingQuestion
    if (!question || interactionBusy || stopping || questionSubmittingRef.current) return
    const text = formatUserQuestionAnswer(question, answers)
    questionSubmittingRef.current = true
    setQuestionSubmitting(true)
    stickToBottom.current = true
    setShowJumpBottom(false)
    void sendRuntimeCommand({ type: 'user-message', text }).finally(() => {
      questionSubmittingRef.current = false
      setQuestionSubmitting(false)
    })
  }, [interactionBusy, sendRuntimeCommand, stopping, view.pendingQuestion])

  const editUserMessage = useCallback(async (
    block: Extract<Block, { kind: 'user' }>,
    text: string,
  ) => {
    if (interactionBusy || stopping) return false
    const target = block.btw && block.inputId
      ? { kind: 'btw' as const, inputId: block.inputId }
      : block.turnId
        ? { kind: 'main' as const, turnId: block.turnId }
        : null
    if (!target) return false
    stickToBottom.current = true
    setShowJumpBottom(false)
    try {
      const result = await sendRuntimeCommand({ type: 'edit-user-message', target, text })
      return Boolean(result?.ok)
    } catch {
      return false
    }
  }, [interactionBusy, sendRuntimeCommand, stopping])

  const respondApproval = useCallback((approved: boolean, remember = false) => {
    if (!approval) return
    void sendRuntimeCommand({
      type: 'approval-response',
      requestId: approval.requestId,
      approved,
      remember,
    })
    setApproval(null)
  }, [approval, sendRuntimeCommand])

  const toggle = useCallback((id: string) => {
    const shouldExpand = !expandedIdsRef.current.has(id)
    const nextExpanded = new Set(expandedIdsRef.current)
    shouldExpand ? nextExpanded.add(id) : nextExpanded.delete(id)
    expandedIdsRef.current = nextExpanded
    const key = composerKey(runtimeIdRef.current, sessionIdRef.current)
    conversationPresentationsRef.current.setExpanded(key, id, shouldExpand)
    setView((current) => current.expanded.has(id) === shouldExpand
      ? current
      : toggleExpanded(current, id))
  }, [])

  const selectedModel = models.find((model) => model.id === modelId)
  const canAttachImages = Boolean(
    selectedModel?.available
      && (btwMode ? selectedModel.imageInputMode === 'native' : selectedModel.imageInputMode !== 'none'),
  )
  const canAttachPdfs = Boolean(selectedModel?.available && !btwMode)
  const pasteAttachments = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = collectPastedImageFiles(event.clipboardData)
    const pdfFiles = collectPastedPdfFiles(event.clipboardData)
    if (imageFiles.length === 0 && pdfFiles.length === 0) return
    event.preventDefault()
    if (attachmentLocked) {
      addError('当前操作暂时锁定附件，请稍后重试')
      return
    }
    if (imageFiles.length > 0) {
      if (canAttachImages) addImageFiles(imageFiles)
      else addError('当前模型没有可用的原生或辅助识图能力；PDF 仍可添加')
    }
    if (pdfFiles.length > 0) {
      if (canAttachPdfs) addPdfFiles(pdfFiles)
      else addError('当前没有可用模型，无法添加 PDF')
    }
  }, [
    addError,
    addImageFiles,
    addPdfFiles,
    attachmentLocked,
    canAttachImages,
    canAttachPdfs,
  ])
  const attachmentDrop = useAttachmentDropTarget({
    canAttachImages,
    canAttachPdfs,
    interactionBusy: attachmentLocked,
    onImageFiles: addImageFiles,
    onPdfFiles: addPdfFiles,
    onError: addError,
  })
  const currentSession = sessions.find((session) => session.isCurrent)
  const taskTitle = currentSession?.title
    || (blocks.length > 0 ? '当前会话' : '新会话')
  const composerDisabled = stopping
    || sessionTransitionPending
    || deletionBlocksRuntime
    || resumingSessionId !== null
    || checkpointRestoreToolUseId !== null
  const messageEmpty = !input.trim()
    && imageDrafts.length === 0
    && pdfDrafts.length === 0
    && selectedSkills.length === 0
  const sendDisabled = composerDisabled
    || attachmentSubmissionPending
    || messageEmpty
  const primaryAction = composerPrimaryAction({ busy, hasDraft: !messageEmpty })
  const contextBaseRef = workspace.mode === 'pending-worktree'
    ? workspace.baseRef
    : workspace.mode === 'worktree'
      ? workspace.baseRef
      : null

  return (
    <div
      className="relative flex h-screen gap-1 overflow-hidden bg-[var(--wc-canvas)] p-1 text-[var(--wc-ink)]"
      {...attachmentDrop.handlers}
    >
      {attachmentDrop.active && (
        <div className="pointer-events-none fixed inset-3 z-[70] flex items-center justify-center rounded-[24px_20px_25px_21px] border-2 border-dashed border-[#8d9a8f] bg-[var(--wc-sage)]/90 text-sm font-medium text-[var(--wc-sage-ink)] shadow-lg backdrop-blur-sm">
          {attachmentLocked
            ? '当前操作暂时锁定附件'
            : !canAttachPdfs
              ? '当前没有可用模型'
              : canAttachImages
                ? '松开以添加图片或 PDF'
                : '松开以添加 PDF；当前模型没有可用识图能力'}
        </div>
      )}

      <AppSidebar
        collapsed={sidebarCollapsed}
        sessions={sessions}
        error={sessionListError}
        actionError={sessionActionError}
        busy={sessionChangeLocked}
        deletingSessionId={deletingSessionId}
        onCollapsedChange={setSidebarCollapsed}
        onNewSession={startNewSession}
        onResume={resumeSession}
        onPinnedChange={setSessionPinned}
        onDelete={deleteSession}
        onOpenSettings={openConnectionSettings}
      />

      <section className="wc-shell-panel flex min-w-0 flex-1 flex-col bg-[var(--wc-surface)]">
        <TaskHeader
          title={taskTitle}
          projectDir={workspace.mode === 'pending-managed' ? null : projectDir}
          workspaceMode={workspace.mode}
          backgroundTasks={backgroundTasks}
          subagentPanelOpen={subagentPanelOpen}
          onOpenWorkspaceFolder={openCurrentWorkspaceFolder}
          onToggleSubagentPanel={() => setSubagentPanelOpen((open) => !open)}
        />

        <div className="relative flex min-h-0 flex-1">
          <ConversationNavigator
            key={runtimeId}
            sections={sections}
            navigationTargetIds={btwPresentation.navigationTargetIds}
            scrollRef={scrollRef}
            onNavigate={navigateConversation}
          />
          <section className="flex min-w-0 flex-1 flex-col">
            <main
              ref={scrollRef}
              onScroll={onScroll}
              className="wc-scrollbar relative min-h-0 flex-1 overflow-y-auto px-5 py-5"
            >
              <div
                ref={conversationContentRef}
                className="wc-conversation-balanced-content mx-auto w-full max-w-4xl"
              >
                {!conversationStarted && worktreePreparation && (
                  <WorktreePreparation
                    message={worktreePreparation.message}
                    baseRef={worktreePreparation.baseRef}
                  />
                )}
                {!conversationStarted && !worktreePreparation && (
                  <div className="mx-auto mt-[18vh] max-w-md text-center">
                    <h2 className="text-lg font-semibold tracking-tight">想一起做点什么？</h2>
                    <p className="mt-1.5 text-sm leading-6 text-[var(--wc-muted)]">
                      {explicitProjectSelected
                        ? '描述目标，WhyCode 会在当前工作区中读取、修改和验证。'
                        : '先选择一个项目，或直接在默认工作区中开始。'}
                    </p>
                  </div>
                )}
                <ConversationView
                  runtimeId={runtimeId}
                  items={btwPresentation.items}
                  latestBtwConversationId={btwPresentation.latestBtwConversationId}
                  expandedIds={view.expanded}
                  editableBlockId={editableBlockId}
                  busy={interactionBusy}
                  checkpointRestoreAnchorIds={checkpointRestoreAnchors}
                  checkpointRestoreToolUseId={checkpointRestoreToolUseId}
                  showThinkingGap={thinkingGapVisible}
                  forkSourceTurnId={forkOrigin?.sourceTurnId ?? null}
                  forkPendingTurnId={forkPendingTurnId}
                  skills={skillCatalog.skills}
                  projectDir={projectDir}
                  onCheckpointRestoreChange={changeCheckpointRestore}
                  onEdit={editUserMessage}
                  onFork={forkConversation}
                  onToggle={toggle}
                />
              </div>
            </main>

            <div className="relative shrink-0 px-4 pb-4 pt-1">
              <div className="wc-conversation-balanced-content mx-auto w-full max-w-4xl">
                {composerProcessingTimeVisible && workStartedAt !== null && (
                  <div className="mb-1.5 px-2 text-xs text-[var(--wc-faint)]">
                    <ProcessingTime startedAt={workStartedAt} />
                  </div>
                )}

                {showJumpBottom && (
                  <button
                    type="button"
                    className="wc-focus-ring absolute -top-9 left-1/2 -translate-x-1/2 rounded-full border border-[var(--wc-line)] bg-white px-3 py-1.5 text-xs text-[var(--wc-muted)] shadow-sm hover:border-[var(--wc-line-strong)]"
                    onClick={jumpToBottom}
                    title="回到底部并恢复自动跟随"
                  >
                    ↓ 回到底部
                  </button>
                )}

                {approval && (
                  <div className="mb-2">
                    <ApprovalCard approval={approval} onRespond={respondApproval} />
                  </div>
                )}

                {negoStatus && (
                  <div className="mb-2 rounded-xl bg-[var(--wc-sage)] px-3 py-2 text-xs text-[var(--wc-sage-ink)]">
                    {negoStatus}
                  </div>
                )}

                {queued.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {queued.map((queuedMessage) => (
                      <div key={queuedMessage.id} className="rounded-xl bg-black/[0.04] px-3 py-1.5 text-xs text-[var(--wc-muted)]">
                        <div className="truncate">已排队 · {queuedMessage.text}</div>
                        <SkillBadges skills={queuedMessage.skills} />
                        <QueuedImageStrip attachments={queuedMessage.attachments} />
                        <QueuedPdfStrip attachments={queuedMessage.pdfAttachments} />
                      </div>
                    ))}
                  </div>
                )}

                {restoredQueue.length > 0 && (
                  <div className="mb-2 rounded-xl bg-[var(--wc-sand)] px-3 py-2 text-xs text-[var(--wc-sand-ink)]">
                    另有 {restoredQueue.length} 条中断输入已安全保留；当前恢复输入提交后会按原顺序继续恢复。
                  </div>
                )}

                <footer className={`wc-composer relative p-2.5 ${btwMode ? 'wc-composer-btw' : ''}`}>
                  {view.pendingQuestion ? (
                    <QuestionCard
                      key={view.pendingQuestion.id}
                      question={view.pendingQuestion}
                      disabled={interactionBusy || stopping || questionSubmitting}
                      onAnswer={answerQuestion}
                    />
                  ) : (
                    <>
                      {skillTrigger && !attachmentLocked && (
                        <ComposerSlashMenu
                          items={composerMenuItems}
                          activeIndex={Math.min(skillActiveIndex, Math.max(0, composerMenuItems.length - 1))}
                          diagnostics={skillCatalog.diagnostics}
                          limitReached={skillLimitReached}
                          onSelect={selectComposerMenuItem}
                          onActivate={setSkillActiveIndex}
                        />
                      )}

                      {!conversationStarted && !worktreePreparation && (
                        <WorkspaceContextBar
                          workspace={workspace}
                          candidate={workspaceCandidate}
                          projectDir={projectDir}
                          baseRef={contextBaseRef}
                          busy={sessionChangeLocked}
                          onPickProject={pickProject}
                          onClearProject={startNewSession}
                          onStart={startWorkspaceSession}
                        />
                      )}

                      <ImageDraftStrip drafts={imageDrafts} onRemove={removeImageDraft} />
                      <PdfDraftStrip drafts={pdfDrafts} onRemove={removePdfDraft} />
                      <SkillChips
                        skills={selectedSkills}
                        disabled={attachmentLocked}
                        onRemove={removeSelectedSkill}
                      />

                      {btwMode && (
                        <div className="mb-1 flex items-center px-1.5">
                          <span className="inline-flex items-center gap-1 rounded-lg bg-black/[0.045] px-2 py-1 text-xs text-[var(--wc-muted)]">
                            {btwMode.toUpperCase()} · 临时侧对话
                            <button
                              type="button"
                              className="wc-focus-ring rounded px-0.5 text-[var(--wc-faint)] hover:text-[var(--wc-ink)]"
                              onClick={() => setBtwMode(null)}
                              aria-label="退出临时侧对话模式"
                              title="退出临时侧对话模式"
                            >
                              ×
                            </button>
                          </span>
                        </div>
                      )}

                      <textarea
                        ref={composerTextareaRef}
                        rows={2}
                        className="wc-scrollbar max-h-40 min-h-[66px] w-full resize-none overflow-y-auto bg-transparent px-1.5 py-1 text-base leading-6 text-[var(--wc-ink)] caret-[var(--wc-ink)] outline-none [field-sizing:content] placeholder:text-[var(--wc-faint)]"
                        value={input}
                        onChange={(event) => {
                          const text = event.target.value
                          inputRef.current = text
                          setInput(text)
                          updateSkillMenu(text, event.target.selectionStart)
                        }}
                        onSelect={(event) => updateSkillMenu(inputRef.current, event.currentTarget.selectionStart)}
                        onBlur={closeSkillMenu}
                        onPaste={pasteAttachments}
                        disabled={composerDisabled}
                        onKeyDown={(event) => {
                          if (handlePickerKeyDown(event)) return
                          if (event.key === 'Escape' && btwMode) {
                            event.preventDefault()
                            setBtwMode(null)
                            return
                          }
                          const action = composerKeyAction({
                            key: event.key,
                            shiftKey: event.shiftKey,
                            ctrlKey: event.ctrlKey,
                            isComposing: event.nativeEvent.isComposing,
                          })
                          if (action === 'ignore' || action === 'newline') return
                          event.preventDefault()
                          send(action === 'send-immediately')
                        }}
                        placeholder={
                          stopping
                            ? '正在停止当前任务并清理子进程…'
                            : worktreePreparation
                              ? '正在创建 Worktree 并检出文件…'
                            : sessionTransitionPending
                              ? '正在切换会话…'
                              : deletionBlocksRuntime
                                ? '正在删除当前会话及其关联数据…'
                                : resumingSessionId
                                  ? '输入消息…'
                                  : checkpointRestoreToolUseId
                                    ? '正在安全回滚文件，请等待完成…'
                                    : status === 'waiting-approval'
                                      ? 'Agent 在等你审批上方的请求…'
                                        : btwMode
                                          ? `${btwMode.toUpperCase()}：本次问答不会写入主上下文`
                                        : busy
                                        ? '工作中——Enter 排队，Ctrl+Enter 立即插话，/ 选择功能或 Skill'
                                        : '输入消息…（/ 选择功能或 Skill，Shift+Enter 换行）'
                        }
                      />

                      <ComposerToolbar
                        canAttachImages={canAttachImages}
                        canAttachPdfs={canAttachPdfs}
                        attachmentLocked={attachmentLocked}
                        configurationLocked={attachmentLocked}
                        permissionLocked={
                          sessionTransitionPending
                          || deletionBlocksRuntime
                          || resumingSessionId !== null
                        }
                        permMode={permMode}
                        consensus={consensus}
                        models={models}
                        modelId={modelId}
                        reasoningEffort={reasoningEffort}
                        contextUsage={contextUsage}
                        primaryAction={primaryAction}
                        stopping={stopping}
                        stopDisabled={
                          stopping
                          || sessionTransitionPending
                          || deletionBlocksRuntime
                          || resumingSessionId !== null
                          || checkpointRestoreToolUseId !== null
                        }
                        sendDisabled={sendDisabled}
                        onImageFiles={addImageFiles}
                        onPdfFiles={addPdfFiles}
                        onPermissionChange={changePermission}
                        onToggleConsensus={toggleConsensus}
                        onModelChange={changeModel}
                        onReasoningEffortChange={changeReasoningEffort}
                        onSend={() => send(false)}
                        onStop={stop}
                      />
                    </>
                  )}
                </footer>
              </div>
            </div>
          </section>

          <div
            className={`relative h-full shrink-0 overflow-hidden bg-[var(--wc-surface)] transition-[width,margin-left] duration-200 ease-out ${
              subagentPanelOpen
                ? 'ml-0 w-[40vw]'
                : 'ml-3 w-[348px] max-[1440px]:ml-0 max-[1440px]:w-0 max-[1440px]:pointer-events-none'
            }`}
          >
            <div
              className={`absolute inset-y-0 left-0 w-[348px] transition-[opacity,transform] duration-200 ease-out ${
                subagentPanelOpen
                  ? 'pointer-events-none -translate-x-3 opacity-0'
                  : 'translate-x-0 opacity-100 max-[1440px]:opacity-0'
              }`}
              aria-hidden={subagentPanelOpen}
              inert={subagentPanelOpen}
            >
              <TaskInspector
                runtimeId={runtimeId}
                workspace={workspace}
                plan={view.taskPlan}
                subagents={subagents}
                busy={interactionBusy}
                worktreeStatusRevision={worktreeStatusRevision}
                onPrepareCommitPrompt={prepareCommitPrompt}
                onOpenSubagents={() => {
                  setSubagentPanelPage({ kind: 'overview' })
                  setSubagentPanelOpen(true)
                }}
              />
            </div>
            <div
              className={`absolute inset-y-0 right-0 w-[40vw] transition-[opacity,transform] duration-200 ease-out ${
                subagentPanelOpen
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none translate-x-8 opacity-0'
              }`}
              aria-hidden={!subagentPanelOpen}
              inert={!subagentPanelOpen}
              onTransitionEnd={(event) => {
                if (
                  event.target === event.currentTarget
                  && event.propertyName === 'opacity'
                  && !subagentPanelOpen
                ) setSubagentPanelRetained(false)
              }}
            >
              <SubagentPanel
                active={subagentPanelOpen || subagentPanelRetained}
                runtimeId={runtimeId}
                parentSessionId={sessionIdRef.current}
                subagents={subagents}
                skills={skillCatalog.skills}
                projectDir={projectDir}
                page={subagentPanelPage}
                onSelect={(subagentId) => setSubagentPanelPage({
                  kind: 'transcript',
                  subagentId,
                })}
                onBack={() => setSubagentPanelPage({ kind: 'overview' })}
                onClearPage={() => setSubagentPanelPage(null)}
              />
            </div>
          </div>
        </div>
      </section>

      {showConnectionSettings && connectionSettings && (
        <ConnectionSettingsPanel
          snapshot={connectionSettings}
          onClose={() => setShowConnectionSettings(false)}
          onChanged={applyConnectionSettings}
        />
      )}
    </div>
  )
}

function composerKey(runtimeId: string, sessionId: string | null): string {
  return sessionId ?? `runtime:${runtimeId}`
}

function sameSessionList(
  current: readonly SessionListItem[],
  next: readonly SessionListItem[],
): boolean {
  if (current.length !== next.length) return false
  return current.every((item, index) => JSON.stringify(item) === JSON.stringify(next[index]))
}
