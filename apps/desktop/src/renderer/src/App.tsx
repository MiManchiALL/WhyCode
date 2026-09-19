import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
  type ToolFileChange,
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
  checkpointRestoreAnchorIds,
  createConversationState,
  editableUserBlockId,
  runtimeEventsAfterSnapshot,
  resumeTargetCommitted,
  toggleExpanded,
  voteLabel,
  type Block,
} from '../../shared/conversation-state.ts'
import {
  isCurrentSessionDeletion,
  preserveDeletionTarget,
} from './session-deletion-state.ts'
import { QuestionCard } from './question-card.tsx'
import { ProcessingTime } from './processing-time.ts'
import { ConversationView } from './conversation-view.tsx'
import { prependConversationHistory, restoreConversationSnapshot } from '../../shared/conversation-history.ts'
import { useConversationHistory } from './use-conversation-history.ts'
import { ConversationNavigator } from './conversation-navigator.tsx'
import { presentBtwConversations } from './conversation-btw-groups.ts'
import {
  conversationSections,
  findLatestForkTurnId,
} from '../../shared/conversation-sections.ts'
import { thinkingGapRevealDelay } from './thinking-gap.ts'
import { ConnectionSettingsPanel } from './connection-settings-panel.tsx'
import { RetainedWorkspaceCleanup } from './retained-workspace-cleanup.ts'
import {
  ImageDraftStrip,
  useImageDrafts,
} from './image-attachments.tsx'
import {
  prepareImageDrafts,
  releaseImageDrafts,
  restoredImageDrafts,
} from './image-draft.ts'
import { collectPastedImageFiles, collectPastedPdfFiles } from './image-paste.ts'
import { useAttachmentDropTarget } from './image-drop.ts'
import {
  PdfDraftStrip,
  usePdfDrafts,
} from './pdf-attachments.tsx'
import {
  preparePdfDrafts,
  restoredPdfDrafts,
} from './pdf-draft.ts'
import { composerKeyAction, composerPrimaryAction } from './composer-key.ts'
import { ComposerDraftStore, composerDraftKey } from './composer-drafts.ts'
import { ComposerSubmissions, prependComposerDraft, type ComposerSubmission } from './composer-submissions.ts'
import type { WorkspaceStartChoice } from './workspace-start-controls.tsx'
import { WorkspaceContextBar } from './workspace-context-bar.tsx'
import { canChangeSessionWorkspace } from './workspace-selection.ts'
import { SkillChips, ComposerSlashMenu } from './skill-picker.tsx'
import { useSkillComposer } from './use-skill-composer.ts'
import type { ComposerCommandId } from './skill-trigger.ts'
import { AppSidebar } from './app-sidebar.tsx'
import { TaskHeader } from './task-header.tsx'
import { ComposerToolbar } from './composer-toolbar.tsx'
import { TaskInspector } from './task-inspector.tsx'
import { ComposerMcpStatus } from './composer-mcp-status.tsx'
import { RightPanel } from './right-panel.tsx'
import { disposeTerminalView, loadTerminalViews } from './terminal-panel.tsx'
import { RightPanelResizeHandle } from './right-panel-resize-handle.tsx'
import {
  loadRightPanelWidthPreference,
  normalizeRightPanelWidthRatio,
  persistRightPanelWidthRatio,
  rightPanelWidthExpression,
} from './right-panel-layout.ts'
import { WorktreePreparation } from './worktree-preparation.tsx'
import {
  closeRightPanelTab,
  openRightPanelPage as openRightPanelPageState,
  RightPanelSessionStore,
  rightPanelSessionKey,
  selectRightPanelTab as selectRightPanelTabState,
  type RightPanelPage,
  type RightPanelSessionState,
} from './right-panel-state.ts'
import { ComposerFileChanges } from './composer-file-changes.tsx'
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
import {
  QueuedMessageCard,
  type QueuedMessageAction,
} from './queued-message-card.tsx'
import {
  ConversationFeedbackToast,
} from './conversation-feedback.tsx'
import { conversationEventFeedback, type ConversationFeedback } from './conversation-feedback-state.ts'
import type { CheckpointRestoreRequest } from './checkpoint-restore-controls.ts'

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
  const [composerSubmissions] = useState(() => new ComposerSubmissions())
  const pendingSubmissions = useSyncExternalStore(composerSubmissions.subscribe, composerSubmissions.getSnapshot)
  const activeSubmission = pendingSubmissions.get(runtimeId)
  const submissionPending = Boolean(activeSubmission)
  const restoredSubmissionPending = Boolean(activeSubmission?.draft.restoredInputIds.length)
  const worktreePreparation = activeSubmission?.worktreeBaseRef !== undefined
    ? { message: activeSubmission.draft.text, baseRef: activeSubmission.worktreeBaseRef }
    : null
  const [models, setModels] = useState<ModelListItem[]>([])
  const [modelId, setModelId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortSelection>('default')
  const [contextUsage, setContextUsage] = useState<ContextUsageInfo | null>(null)
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskSummary[]>([])
  const [worktreeStatusRevision, setWorktreeStatusRevision] = useState(0)
  const [filePreviewInteractionRevision, setFilePreviewInteractionRevision] = useState(0)
  const [subagents, setSubagents] = useState<SubagentSummary[]>([])
  const [activeSkills, setActiveSkills] = useState<SkillSummary[]>([])
  const [currentFileChanges, setCurrentFileChanges] = useState<ToolFileChange[]>([])
  const [showMcpStatus, setShowMcpStatus] = useState(false)
  const [rightPanelState, setRightPanelState] = useState<RightPanelSessionState>({
    open: false,
    tabs: [],
    activeTabId: null,
    inspectorView: 'plan',
  })
  const [rightPanelFullscreen, setRightPanelFullscreen] = useState(false)
  const panelFullscreen = rightPanelFullscreen && rightPanelState.open
  const [terminalOpening, setTerminalOpening] = useState(false)
  const [rightPanelResizeActive, setRightPanelResizeActive] = useState(false)
  const [rightPanelWidthPreference, setRightPanelWidthPreference] = useState(
    loadRightPanelWidthPreference,
  )
  const [showConnectionSettings, setShowConnectionSettings] = useState(false)
  const [connectionSettings, setConnectionSettings] =
    useState<ConnectionSettingsSnapshot | null>(null)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [workspace, setWorkspace] = useState<RuntimeWorkspace>({ mode: 'none' })
  const [queued, setQueued] = useState<QueuedUserMessage[]>([])
  const [queuedActionPending, setQueuedActionPending] = useState<
    Partial<Record<string, QueuedMessageAction>>
  >({})
  const [restoredInputIds, setRestoredInputIds] = useState<string[]>([])
  const [restoredQueue, setRestoredQueue] = useState<QueuedUserMessage[]>([])
  const [permMode, setPermMode] = useState<PermissionMode>('default')
  const [consensus, setConsensus] = useState<{ ready: boolean; reason: string | null; enabled: boolean }>({ ready: false, reason: null, enabled: false })
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [sessionListError, setSessionListError] = useState<string | null>(null)
  const [workspaceCandidate, setWorkspaceCandidate] = useState<WorkspaceCandidate | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [deletionBlocksRuntime, setDeletionBlocksRuntimeState] = useState(false)
  const [resumingSessionId, setResumingSessionIdState] = useState<string | null>(null)
  const [checkpointRestoreToolUseId, setCheckpointRestoreToolUseId] = useState<string | null>(null)
  const [conversationFeedback, setConversationFeedback] =
    useState<ConversationFeedback | null>(null)
  const [forkOrigin, setForkOrigin] = useState<SessionForkOrigin | null>(null)
  const [forkPendingTurnId, setForkPendingTurnId] = useState<string | null>(null)
  /** 协商进行中的状态条文案（null = 无协商） */
  const [negoStatus, setNegoStatus] = useState<string | null>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const conversationContentRef = useRef<HTMLDivElement>(null)
  const rightPanelRef = useRef<HTMLDivElement>(null)
  const rightPanelStateRef = useRef(rightPanelState)
  const rightPanelSessionStoreRef = useRef<RightPanelSessionStore | null>(null)
  if (!rightPanelSessionStoreRef.current) {
    rightPanelSessionStoreRef.current = new RightPanelSessionStore()
  }
  const questionSubmittingRef = useRef(false)
  const sessionTransitionPendingRef = useRef(false)
  const resumingSessionIdRef = useRef<string | null>(null)
  const resumeRequestRef = useRef<object | null>(null)
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
  const restoredInputIdsRef = useRef(restoredInputIds)
  restoredInputIdsRef.current = restoredInputIds
  const composerDraftsRef = useRef(new ComposerDraftStore())
  const conversationPresentationsRef = useRef(new ConversationPresentationCache())
  const pendingScrollRestoreRef = useRef<ConversationScrollPosition | null>(null)
  const conversationScrollReleaseRef = useRef<(() => void) | null>(null)
  const expandedIdsRef = useRef(view.expanded)
  const conversationFeedbackIdRef = useRef(0)
  rightPanelStateRef.current = rightPanelState
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
  useEffect(() => releaseConversationScroll, [releaseConversationScroll])
  const scrollToConversation = useCallback((targetId: string) => {
    const scroller = scrollRef.current
    if (!scroller) return false
    releaseConversationScroll()
    const navigation = scrollConversationToTarget(scroller, targetId)
    if (!navigation) return false
    conversationScrollReleaseRef.current = navigation.release
    stickToBottom.current = false
    setShowJumpBottom(true)
    return true
  }, [releaseConversationScroll])
  const history = useConversationHistory({
    prepend: (pages, isCurrent) => {
      if (!isCurrent()) return
      const scroller = scrollRef.current
      if (scroller) pendingScrollRestoreRef.current = captureConversationScrollPosition(scroller)
      setView((current) => isCurrent() ? pages.reduce(prependConversationHistory, current) : current)
    },
    onError: (message) => showError(message),
  })
  const navigateConversation = useCallback((targetId: string) => {
    history.cancel()
    pendingScrollRestoreRef.current = null
    if (!scrollToConversation(targetId)) void history.loadOlder(targetId)
  }, [history.cancel, history.loadOlder, scrollToConversation])
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
  const showConversationFeedback = useCallback((
    tone: ConversationFeedback['tone'],
    message: string,
  ) => {
    setConversationFeedback({
      id: ++conversationFeedbackIdRef.current,
      tone,
      message,
    })
  }, [])
  const dismissConversationFeedback = useCallback((id: number) => {
    setConversationFeedback((current) => current?.id === id ? null : current)
  }, [])
  const showError = useCallback((text: string) => {
    showConversationFeedback('error', text)
  }, [showConversationFeedback])
  const [workspaceCleanup] = useState(() => new RetainedWorkspaceCleanup(async workspace => {
    const result = await window.whycode.deleteRetainedWorkspace(workspace)
    if (!result.ok) throw new Error(result.error)
  }, showError))
  const {
    drafts: imageDrafts,
    addFiles: addImageFiles,
    remove: removeImageDraft,
    clear: clearImageDrafts,
    detach: detachImageDrafts,
    restore: restoreImageDrafts,
  } = useImageDrafts(showError)
  const {
    drafts: pdfDrafts,
    addFiles: addPdfFiles,
    remove: removePdfDraft,
    clear: clearPdfDrafts,
    detach: detachPdfDrafts,
    restore: restorePdfDrafts,
  } = usePdfDrafts(showError)


  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => () => {
    conversationEventBufferRef.current?.clear()
    composerDraftsRef.current.dispose()
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
    const draft = {
      text, images, pdfs, skills, btwMode: currentBtwMode, restoredInputIds: restoredInputIdsRef.current,
    }
    const pending = composerSubmissions.getSnapshot().get(currentRuntimeId)
    if (pending) pending.remainder = draft
    else composerDraftsRef.current.cache(composerDraftKey(currentRuntimeId, currentSessionId), draft)
  }, [captureSkills, composerSubmissions, detachImageDrafts, detachPdfDrafts])

  const draftStorageError = useCallback((error: unknown) => {
    showError(`输入草稿保存或恢复失败：${error instanceof Error ? error.message : String(error)}`)
  }, [showError])

  const persistComposer = useCallback(async () => {
    if (!runtimeId || runtimeId !== runtimeIdRef.current) return
    const draft = {
      text: inputRef.current, images: imageDrafts, pdfs: pdfDrafts, skills: selectedSkills,
      btwMode, restoredInputIds,
    }
    const pending = composerSubmissions.getSnapshot().get(runtimeId)
    await composerDraftsRef.current.save(composerDraftKey(runtimeId, sessionIdRef.current),
      pending ? prependComposerDraft(pending.draft, draft) : draft)
  }, [runtimeId, input, imageDrafts, pdfDrafts, selectedSkills, btwMode, restoredInputIds,
    submissionPending, composerSubmissions])
  const persistComposerRef = useRef(persistComposer)
  persistComposerRef.current = persistComposer

  useEffect(() => { void persistComposer().catch(draftStorageError) }, [persistComposer, draftStorageError])
  useEffect(() => window.whycode.onBeforeClose(async () => {
    try {
      await persistComposerRef.current()
      await composerDraftsRef.current.flush()
    } catch (error) {
      draftStorageError(error)
      throw error
    }
  }), [draftStorageError])

  const bindComposerSession = useCallback((ownerRuntimeId: string, sessionId: string | null) => {
    if (!sessionId) return
    const pending = composerSubmissions.getSnapshot().get(ownerRuntimeId)
    const promoted = pending
      ? composerSubmissions.bindSession(ownerRuntimeId, sessionId)
      : ownerRuntimeId === runtimeIdRef.current && sessionIdRef.current === null
    if (promoted) return composerDraftsRef.current.moveToSession(ownerRuntimeId, sessionId)
  }, [composerSubmissions])

  const prepareComposer = useCallback(async (snapshot: RuntimeSnapshot) => {
    await bindComposerSession(snapshot.runtimeId, snapshot.sessionId)
    const key = composerDraftKey(snapshot.runtimeId, snapshot.sessionId)
    if (runtimeIdRef.current && key === composerDraftKey(runtimeIdRef.current, sessionIdRef.current)) return
    // 待确认输入只在磁盘中用于崩溃恢复；切回时输入框仍展示提交之后新写的草稿。
    if (!composerSubmissions.getSnapshot().has(snapshot.runtimeId)) await composerDraftsRef.current.load(key)
  }, [bindComposerSession, composerSubmissions])

  const setComposerSessionId = useCallback((sessionId: string | null) => {
    void bindComposerSession(runtimeIdRef.current, sessionId)?.catch(draftStorageError)
    sessionIdRef.current = sessionId
  }, [bindComposerSession, draftStorageError])

  const stashActivePresentation = useCallback(() => {
    const currentRuntimeId = runtimeIdRef.current
    const scrollElement = scrollRef.current
    if (!currentRuntimeId || !scrollElement || pendingScrollRestoreRef.current) return
    const key = composerKey(currentRuntimeId, sessionIdRef.current)
    conversationPresentationsRef.current.saveScroll(
      key,
      stickToBottom.current
        ? { atBottom: true, scrollTop: 0 }
        : captureConversationScrollPosition(scrollElement),
      scrollElement.querySelector<HTMLElement>('[data-conversation-scroll-block]')?.dataset.conversationScrollBlock,
    )
  }, [])

  const resetActiveComposer = useCallback(() => {
    const currentRuntimeId = runtimeIdRef.current
    const currentSessionId = sessionIdRef.current
    void composerDraftsRef.current.delete(composerDraftKey(currentRuntimeId, currentSessionId)).catch(draftStorageError)
    backgroundEventsRef.current.delete(currentRuntimeId)
    inputRef.current = ''
    setInput('')
    clearSkills()
    clearImageDrafts()
    clearPdfDrafts()
    setBtwMode(null)
  }, [clearImageDrafts, clearPdfDrafts, clearSkills, setBtwMode, draftStorageError])

  const setResumingSessionId = useCallback((sessionId: string | null) => {
    if (sessionId) history.cancel()
    resumingSessionIdRef.current = sessionId
    setResumingSessionIdState(sessionId)
  }, [history.cancel])

  const setDeletionBlocksRuntime = useCallback((blocked: boolean) => {
    if (blocked) history.cancel()
    deletionBlocksRuntimeRef.current = blocked
    setDeletionBlocksRuntimeState(blocked)
  }, [history.cancel])

  const setDeletingSession = useCallback((sessionId: string | null) => {
    deletingSessionIdRef.current = sessionId
    setDeletingSessionId(sessionId)
  }, [])

  const beginSessionTransition = useCallback(() => {
    if (sessionTransitionPendingRef.current) return false
    history.cancel()
    sessionTransitionPendingRef.current = true
    setSessionTransitionPending(true)
    return true
  }, [history.cancel])

  const endSessionTransition = useCallback(() => {
    sessionTransitionPendingRef.current = false
    setSessionTransitionPending(false)
  }, [])

  const sendRuntimeCommand = useCallback((command: CoreCommand) => {
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId) return Promise.resolve({ ok: false, error: '当前没有可操作的会话' })
    return window.whycode.sendCommand(targetRuntimeId, command)
  }, [])

  const actOnQueuedMessage = useCallback(async (
    id: string,
    action: QueuedMessageAction,
  ) => {
    setQueuedActionPending((current) => ({ ...current, [id]: action }))
    try {
      const result = await sendRuntimeCommand({ type: 'queued-message-action', id, action })
      if (result?.ok) {
        if (action !== 'send-now') {
          setQueuedActionPending((current) => withoutQueuedAction(current, id))
        }
        return
      }
      setQueuedActionPending((current) => withoutQueuedAction(current, id))
    } catch {
      setQueuedActionPending((current) => withoutQueuedAction(current, id))
      showError('排队消息操作失败，请重试')
    }
  }, [showError, sendRuntimeCommand])

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

  const updateRightPanelState = useCallback((
    update: RightPanelSessionState
      | ((current: RightPanelSessionState) => RightPanelSessionState),
  ) => {
    const current = rightPanelStateRef.current
    const next = typeof update === 'function' ? update(current) : update
    rightPanelStateRef.current = next
    setRightPanelState(next)
    const currentRuntimeId = runtimeIdRef.current
    if (currentRuntimeId) {
      rightPanelSessionStoreRef.current!.set(
        rightPanelSessionKey(currentRuntimeId, sessionIdRef.current),
        next,
      )
    }
  }, [])

  const applyRuntimeSnapshot = useCallback((snapshot: RuntimeSnapshot) => {
    const previousRuntimeId = runtimeIdRef.current
    const previousSessionId = sessionIdRef.current
    const changingRuntime = previousRuntimeId !== snapshot.runtimeId
    const changingSession = previousSessionId !== snapshot.sessionId
    if (changingRuntime) {
      stashActiveComposer()
      if (!resumingSessionIdRef.current) stashActivePresentation()
    }
    if (changingRuntime) hydratingRuntimeIdRef.current = snapshot.runtimeId
    if (changingRuntime || changingSession) {
      const store = rightPanelSessionStoreRef.current!
      if (previousRuntimeId) {
        store.set(
          rightPanelSessionKey(previousRuntimeId, previousSessionId),
          rightPanelStateRef.current,
        )
      }
      const targetKey = rightPanelSessionKey(snapshot.runtimeId, snapshot.sessionId)
      const next = !changingRuntime && previousSessionId === null && snapshot.sessionId
        ? store.move(rightPanelSessionKey(previousRuntimeId, null), targetKey)
        : store.get(targetKey)
      rightPanelStateRef.current = next
      setRightPanelState(next)
    }
    runtimeIdRef.current = snapshot.runtimeId
    if (!changingRuntime) setComposerSessionId(snapshot.sessionId)
    else sessionIdRef.current = snapshot.sessionId
    if (changingSession) {
      backgroundTaskRevisionRef.current = -1
      setBackgroundTasks([])
      subagentRevisionRef.current = -1
      setSubagents([])
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
    const validRestoredIds = new Set(snapshot.restoredInputs.map((item) => item.id))
    let restoredIds = restoredInputIdsRef.current.filter((id) => validRestoredIds.has(id))
    if (changingRuntime) {
      resetSkillCatalog()
      const pending = composerSubmissions.getSnapshot().get(snapshot.runtimeId)
      const draft = pending
        ? pending.remainder
        : composerDraftsRef.current.take(composerDraftKey(snapshot.runtimeId, snapshot.sessionId))
      if (pending) pending.remainder = undefined
      inputRef.current = draft?.text ?? ''
      setInput(draft?.text ?? '')
      restoredIds = (draft?.restoredInputIds ?? []).filter((id) => validRestoredIds.has(id))
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
    const replayedView = restoreConversationSnapshot(snapshot.history.view)
    history.reset(snapshot.runtimeId, snapshot.history)
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
      setConversationFeedback(null)
    }
    setWorkspace(snapshot.workspace)
    setPermMode(snapshot.permissionMode)
    setContextUsage(snapshot.contextUsage)
    setActiveSkills(snapshot.activeSkills)
    setCurrentFileChanges(snapshot.turnFileChanges)
    if (changingRuntime) setShowMcpStatus(false)
    setWorkStartedAt(snapshot.workStartedAt)
    setStatus(snapshot.status)
    setDeletingSession(preserveDeletionTarget(
      deletingSessionIdRef.current,
      snapshot.deletingSessionId,
    ))
    setDeletionBlocksRuntime(Boolean(snapshot.deletingSessionId))
    setResumingSessionId(snapshot.resumingSessionId)
    setCheckpointRestoreToolUseId(snapshot.checkpointRestoreToolUseId)
    setStopping(false)
    setQueued(snapshot.queuedInputs)
    setQueuedActionPending({})
    setRestoredInputIds(restoredIds)
    setRestoredQueue(snapshot.restoredInputs.filter((item) => !restoredIds.includes(item.id)))
    setApproval(snapshot.approval)
    setModelId(snapshot.modelId ?? '')
    setReasoningEffort(snapshot.reasoningEffort)
    setForkOrigin(snapshot.forkOrigin)
    setForkPendingTurnId(null)
  }, [
    setComposerSessionId,
    composerSubmissions,
    applyBackgroundTaskState,
    applySubagentState,
    restoreImageDrafts,
    restorePdfDrafts,
    replaceSkills,
    resetSkillCatalog,
    setBtwMode,
    setDeletingSession,
    setDeletionBlocksRuntime,
    setResumingSessionId,
    stashActiveComposer,
    stashActivePresentation,
    history.reset,
  ])

  const synchronizeUnownedResume = useCallback(async () => {
    const targetSessionId = resumingSessionIdRef.current
    if (!targetSessionId || resumeRequestRef.current) return
    try {
      const snapshot = await window.whycode.runtimeSnapshot()
      if (resumeRequestRef.current || resumingSessionIdRef.current !== targetSessionId) return
      if (resumeTargetCommitted(snapshot, targetSessionId)) {
        await prepareComposer(snapshot)
        if (resumeRequestRef.current || resumingSessionIdRef.current !== targetSessionId) return
        applyRuntimeSnapshot(snapshot)
        void window.whycode.consensusStatus().then(setConsensus)
        void refreshSessions()
        void refreshModelCatalog()
        return
      }
      if (snapshot.resumingSessionId) return
      setResumingSessionId(null)
      setStatus(snapshot.status)
      showError('会话恢复失败，当前会话未更改')
    } catch (error) {
      if (resumeRequestRef.current || resumingSessionIdRef.current !== targetSessionId) return
      setResumingSessionId(null)
      const message = `恢复完成后的运行态同步失败：${error instanceof Error ? error.message : String(error)}`
      showError(message)
    }
  }, [
    showError,
    applyRuntimeSnapshot,
    prepareComposer,
    refreshModelCatalog,
    refreshSessions,
    setResumingSessionId,
  ])

  const consumeEvent = useCallback((event: CoreEvent, occurredAt?: string) => {
    const feedback = conversationEventFeedback(event)
    if (feedback) showConversationFeedback(feedback.tone, feedback.message)
    if (event.type === 'user-message-edited' || event.type === 'btw-message-edited'
      || (event.type === 'checkpoint-restored' && event.ok)) history.cancel()
    applyConversationEvent(event, occurredAt)
    switch (event.type) {
      case 'work-started':
        setWorkStartedAt(event.startedAt)
        void refreshSessions()
        break
      case 'turn-start':
        setCurrentFileChanges([])
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
        break
      case 'turn-file-changes':
        setCurrentFileChanges(event.changes)
        break
      case 'turn-end':
        setCurrentFileChanges([])
        void refreshSessions()
        break
      case 'active-skills-changed':
        setActiveSkills(event.skills)
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
        setQueued((prev) => {
          const item = {
            id: event.id,
            text: event.text,
            ...(event.attachments?.length ? { attachments: event.attachments } : {}),
            ...(event.pdfAttachments?.length ? { pdfAttachments: event.pdfAttachments } : {}),
            ...(event.skills?.length ? { skills: event.skills } : {}),
          }
          const index = prev.findIndex((queuedMessage) => queuedMessage.id === event.id)
          if (index < 0) return [...prev, item]
          const next = [...prev]
          next[index] = item
          return next
        })
        break
      case 'message-injected':
      case 'message-dequeued':
        setQueued((prev) => prev.filter((q) => q.id !== event.id))
        setQueuedActionPending((current) => withoutQueuedAction(current, event.id))
        break
      case 'queue-restored':
        if (event.items?.length) {
          const restoredIds = new Set(event.items.map((item) => item.id))
          setQueued((previous) => previous.filter((item) => !restoredIds.has(item.id)))
          setQueuedActionPending((current) => {
            let next = current
            for (const id of restoredIds) next = withoutQueuedAction(next, id)
            return next
          })
        } else {
          setQueued([])
          setQueuedActionPending({})
        }
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
    showConversationFeedback,
    history.cancel,
  ])

  useEffect(() => {
    if (!runtimeId) return
    const buffered = (backgroundEventsRef.current.get(runtimeId) ?? [])
      .sort((left, right) => left.sequence - right.sequence)
    backgroundEventsRef.current.delete(runtimeId)
    for (const entry of buffered) {
      if (entry.sequence <= activeSnapshotSequenceRef.current) continue
      setComposerSessionId(entry.sessionId)
      consumeEvent(entry.event, entry.occurredAt)
    }
    if (hydratingRuntimeIdRef.current === runtimeId) {
      hydratingRuntimeIdRef.current = null
    }
  }, [consumeEvent, runtimeId, setComposerSessionId])

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
      showError(`会话删除未完成：${state.error}`)
    } else if (state.warning) {
      showConversationFeedback('info', `会话已删除；${state.warning}`)
    }
    void refreshSessions()
  }), [refreshSessions, setDeletingSession, setDeletionBlocksRuntime, showError, showConversationFeedback])

  useEffect(() => {
    if (!rightPanelState.open) setRightPanelFullscreen(false)
    if (!panelFullscreen) return
    const exit = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setRightPanelFullscreen(false)
    }
    window.addEventListener('keydown', exit)
    return () => window.removeEventListener('keydown', exit)
  }, [panelFullscreen, rightPanelState.open])

  const updateRightPanelWidthRatio = useCallback((ratio: number) => {
    const normalized = Math.min(
      normalizeRightPanelWidthRatio(ratio),
      rightPanelWidthPreference.maximumRatio,
    )
    setRightPanelWidthPreference((current) => current.ratio === normalized
      ? current
      : { ...current, ratio: normalized })
    persistRightPanelWidthRatio(normalized)
  }, [rightPanelWidthPreference.maximumRatio])

  const collapseRightPanel = useCallback(() => {
    setRightPanelFullscreen(false)
    updateRightPanelState((current) => ({ ...current, open: false }))
  }, [updateRightPanelState])

  const previewRightPanelExpand = useCallback((ratio: number) => {
    setRightPanelWidthPreference((current) => {
      const normalized = Math.min(
        normalizeRightPanelWidthRatio(ratio),
        current.maximumRatio,
      )
      return current.ratio === normalized
        ? current
        : { ...current, ratio: normalized }
    })
    updateRightPanelState((current) => ({ ...current, open: true }))
  }, [updateRightPanelState])

  const showRightPanelPage = useCallback((page: RightPanelPage) => {
    updateRightPanelState((current) => openRightPanelPageState(current, page))
  }, [updateRightPanelState])

  const openFilePreview = useCallback((
    page: Extract<RightPanelPage, { kind: 'file' }>,
  ) => {
    // 同一路径复用标签时页面身份不会变化；点击文件名仍应成为一次显式重检。
    setFilePreviewInteractionRevision((current) => current + 1)
    showRightPanelPage(page)
  }, [showRightPanelPage])

  const selectRightPanelTab = useCallback((tabId: string) => {
    updateRightPanelState((current) => selectRightPanelTabState(current, tabId))
  }, [updateRightPanelState])

  const closeRightPanelPage = useCallback((tabId: string) => {
    const tab = rightPanelStateRef.current.tabs.find((candidate) => candidate.id === tabId)
    if (tab?.page.kind === 'terminal') {
      void window.whycode.closeTerminal(tab.page.terminal.id)
        .catch((error: unknown) => showConversationFeedback('error', String(error)))
      return
    }
    updateRightPanelState((current) => closeRightPanelTab(current, tabId))
  }, [updateRightPanelState, showConversationFeedback])

  useEffect(() => window.whycode.onTerminalClosed((terminalId) => {
    disposeTerminalView(terminalId)
    const store = rightPanelSessionStoreRef.current!
    store.removeTerminal(terminalId)
    const current = rightPanelStateRef.current
    const tab = current.tabs.find((item) => item.page.kind === 'terminal'
      && item.page.terminal.id === terminalId)
    if (!tab) return
    const next = closeRightPanelTab(current, tab.id)
    rightPanelStateRef.current = next
    setRightPanelState(next)
  }), [])

  const openRightPanelTerminal = useCallback(async () => {
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId || terminalOpening) return
    setTerminalOpening(true)
    try {
      await loadTerminalViews()
      if (runtimeIdRef.current !== targetRuntimeId) return
      const terminal = await window.whycode.createTerminal(targetRuntimeId)
      if (runtimeIdRef.current !== targetRuntimeId || !rightPanelStateRef.current.open) {
        await window.whycode.closeTerminal(terminal.id)
        return
      }
      showRightPanelPage({ kind: 'terminal', terminal })
    } catch (error) {
      showConversationFeedback('error', `无法打开终端：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setTerminalOpening(false)
    }
  }, [terminalOpening, showRightPanelPage, showConversationFeedback])

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
        setComposerSessionId(eventSessionId)
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
        void bindComposerSession(eventRuntimeId, eventSessionId)?.catch(draftStorageError)
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
        && resumingSessionIdRef.current
        && !resumeRequestRef.current
      ) {
        void synchronizeUnownedResume()
      }
    }
    const eventSubscription = subscribeRuntimeEventBatches((events) => {
      for (const event of events) acceptEvent(event)
    })
    void eventSubscription.ready.then(() => window.whycode.runtimeSnapshot()).then(async (snapshot) => {
      await prepareComposer(snapshot)
      if (disposed) return
      applyRuntimeSnapshot(snapshot)
      hydrated = true
      const pendingEvents = runtimeEventsAfterSnapshot(
        buffered.splice(0),
        snapshot,
      )
      for (const entry of pendingEvents) acceptEvent(entry)
      void refreshSessions()
      void refreshModelCatalog()
    }).catch(() => {
      if (disposed) return
      hydrated = true
      for (const bufferedEvent of buffered.splice(0)) acceptEvent(bufferedEvent)
    })
    return () => {
      disposed = true
      eventSubscription.unsubscribe()
    }
  }, [
    applyRuntimeSnapshot,
    bindComposerSession,
    draftStorageError,
    prepareComposer,
    setComposerSessionId,
    consumeEvent,
    refreshModelCatalog,
    refreshSessions,
    synchronizeUnownedResume,
  ])

  const restoreConversationAfterRender = useCallback(() => {
    const pending = pendingScrollRestoreRef.current
    const scrollElement = scrollRef.current
    if (resumingSessionIdRef.current || !scrollElement) return
    const loaded = history.completeRender(blocks[0]?.id)
    if (!loaded) return
    if (pending) {
      pendingScrollRestoreRef.current = null
      releaseConversationScroll()
      const restoration = restoreConversationScrollPosition(pending, scrollElement)
      conversationScrollReleaseRef.current = restoration.release
      stickToBottom.current = restoration.position.atBottom
      setShowJumpBottom(!restoration.position.atBottom)
    }
    const target = loaded.targetId
    if (target) scrollToConversation(btwPresentation.navigationTargetIds.get(target) ?? target)
  }, [blocks, releaseConversationScroll, history.completeRender, scrollToConversation, btwPresentation.navigationTargetIds])

  useEffect(() => {
    const scrollElement = scrollRef.current
    const contentElement = conversationContentRef.current
    if (resumingSessionId || !scrollElement || !contentElement) return
    // Markdown/公式与离屏段变为真实高度后，贴底语义仍应指向新的真实底部。
    const observer = new ResizeObserver(() => {
      if (pendingScrollRestoreRef.current || !stickToBottom.current) return
      scrollElement.scrollTop = scrollElement.scrollHeight
      setShowJumpBottom(false)
    })
    observer.observe(contentElement)
    return () => observer.disconnect()
  }, [resumingSessionId])

  useEffect(() => {
    if (!resumingSessionId && !pendingScrollRestoreRef.current && stickToBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }
  }, [blocks, approval, thinkingGapVisible, resumingSessionId])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || resumingSessionIdRef.current) return
    if (pendingScrollRestoreRef.current) {
      pendingScrollRestoreRef.current = captureConversationScrollPosition(el)
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    stickToBottom.current = nearBottom
    setShowJumpBottom(!nearBottom)
    if (!nearBottom && el.scrollTop <= el.clientHeight) void history.loadOlder()
  }, [history.loadOlder])

  const jumpToBottom = useCallback(() => {
    history.cancel()
    pendingScrollRestoreRef.current = null
    releaseConversationScroll()
    stickToBottom.current = true
    setShowJumpBottom(false)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [history.cancel, releaseConversationScroll])

  const busy = status !== 'idle' && status !== 'error'
  const interactionBusy = busy
    || sessionTransitionPending
    || submissionPending
    || deletionBlocksRuntime
    || resumingSessionId !== null
    || checkpointRestoreToolUseId !== null
  const editableBlockId = !interactionBusy && !stopping
    ? editableUserBlockId(blocks)
    : null
  const composerDisabled = !runtimeId || stopping
    || sessionTransitionPending
    || deletionBlocksRuntime
    || checkpointRestoreToolUseId !== null
  const composerControlsLocked = composerDisabled || submissionPending
  const attachmentLocked = composerControlsLocked || resumingSessionId !== null
  const sessionNavigationLocked = deletionBlocksRuntime
    || sessionTransitionPending
    || checkpointRestoreToolUseId !== null
  const sessionChangeLocked = sessionNavigationLocked
    || (submissionPending && sessionIdRef.current === null) || resumingSessionId !== null

  const requestCheckpointRestore = useCallback<CheckpointRestoreRequest>(async (
    toolUseId,
    scope,
    kind,
  ) => {
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId) return false
    if (kind === 'check') {
      try {
        const result = await window.whycode.sendCommand(targetRuntimeId, {
          type: 'check-checkpoint-restore',
          toolUseId,
          scope,
        })
        if (runtimeIdRef.current !== targetRuntimeId) return false
        if (result?.ok) return true
        showConversationFeedback(
          'error',
          `无法回滚：${result?.error ?? '当前检查点无法恢复'}`,
        )
      } catch (error) {
        if (runtimeIdRef.current !== targetRuntimeId) return false
        showConversationFeedback(
          'error',
          `回滚校验失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return false
    }

    setCheckpointRestoreToolUseId((current) => current ?? toolUseId)
    try {
      const result = await window.whycode.sendCommand(targetRuntimeId, {
        type: 'restore-checkpoint',
        toolUseId,
        scope,
      })
      if (runtimeIdRef.current !== targetRuntimeId) return false
      if (!result || result.ok) return true
      showConversationFeedback(
        'error',
        `回滚失败：${result.error ?? '回滚请求未能提交'}`,
      )
      return false
    } catch (error) {
      if (runtimeIdRef.current !== targetRuntimeId) return false
      showConversationFeedback(
        'error',
        `回滚失败：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    } finally {
      if (runtimeIdRef.current === targetRuntimeId) {
        setCheckpointRestoreToolUseId((current) =>
          current === toolUseId ? null : current,
        )
      }
    }
  }, [showConversationFeedback])

  const activateNewSession = useCallback(async (
    workspaceRequest?: StartWorkspaceRequest | null,
  ): Promise<boolean> => {
    const result = await window.whycode.newSession(
      workspaceRequest !== undefined ? { workspace: workspaceRequest } : undefined,
    )
    if (!result.ok) {
      setWorkspaceCandidate(null)
      showError(result.error ?? '新建会话失败')
      return false
    }
    await prepareComposer(result.snapshot)
    applyRuntimeSnapshot(result.snapshot)
    setWorkspaceCandidate(null)
    void window.whycode.consensusStatus().then(setConsensus)
    void refreshSessions()
    void refreshModelCatalog()
    return true
  }, [showError, applyRuntimeSnapshot, prepareComposer, refreshModelCatalog, refreshSessions])

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
      showError(`工作文件夹检查失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(endSessionTransition)
  }, [
    activateNewSession,
    showError,
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
      showError('停止请求发送失败，请重试')
    })
  }, [showError, sendRuntimeCommand, stopping])

  const startNewSession = useCallback((resetWorkspace = false) => {
    if (!resetWorkspace && runtimeIdRef.current && sessionIdRef.current === null && !resumingSessionIdRef.current) return
    if (!beginSessionTransition()) return
    setWorkspaceCandidate(null)
    void activateNewSession(resetWorkspace ? null : undefined)
      .catch((error) => {
        showError(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(endSessionTransition)
  }, [activateNewSession, showError, beginSessionTransition, endSessionTransition])

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
      showError(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(endSessionTransition)
  }, [
    showError,
    activateNewSession,
    beginSessionTransition,
    endSessionTransition,
    workspaceCandidate,
  ])

  const resumeSession = useCallback((sessionId: string) => {
    if (sessionTransitionPendingRef.current) return
    if (!resumingSessionIdRef.current) {
      stashActivePresentation()
      pendingScrollRestoreRef.current = conversationPresentationsRef.current.get(
        composerKey(runtimeIdRef.current, sessionIdRef.current),
      )?.scroll ?? null
    }
    const request = {}
    resumeRequestRef.current = request
    setResumingSessionId(sessionId)
    const presentation = conversationPresentationsRef.current.get(sessionId)
    const historyStart = presentation?.scroll?.atBottom === false ? presentation.historyStart : undefined
    void window.whycode.resumeSession(sessionId, historyStart).then(async (result) => {
      if (resumeRequestRef.current !== request) return
      if (!result.ok) {
        showError(result.error)
        return
      }
      await prepareComposer(result.snapshot)
      if (resumeRequestRef.current !== request) return
      applyRuntimeSnapshot(result.snapshot)
      void window.whycode.consensusStatus().then(setConsensus)
      void refreshSessions()
      void refreshModelCatalog()
    }).catch((error) => {
      if (resumeRequestRef.current !== request) return
      const message = `会话恢复请求失败：${error instanceof Error ? error.message : String(error)}`
      showError(message)
    }).finally(() => {
      if (resumeRequestRef.current !== request) return
      resumeRequestRef.current = null
      setResumingSessionId(null)
    })
  }, [
    showError,
    applyRuntimeSnapshot,
    prepareComposer,
    refreshModelCatalog,
    refreshSessions,
    setResumingSessionId,
    stashActivePresentation,
  ])

  const deleteSession = useCallback((sessionId: string, deleteDirectory: boolean) => {
    if (
      deletingSessionIdRef.current
      || resumingSessionIdRef.current
      || sessionTransitionPendingRef.current
    ) return
    setDeletingSession(sessionId)
    // 同步关闭删除当前会话与切换之间的点击竞态；Main 接管后立即切到替代会话。
    setDeletionBlocksRuntime(isCurrentSessionDeletion(sessionIdRef.current, sessionId))
    let cleanupPending = false
    void window.whycode.deleteSession(sessionId, deleteDirectory).then(async (result) => {
      cleanupPending = result.ok && result.cleanupPending
      if (result.ok || result.deletedCurrent) {
        void composerDraftsRef.current.delete(sessionId).catch(draftStorageError)
        conversationPresentationsRef.current.delete(sessionId)
        rightPanelSessionStoreRef.current!.delete(sessionId)
        for (const [eventRuntimeId, events] of backgroundEventsRef.current) {
          if (events.some((entry) => entry.sessionId === sessionId)) {
            backgroundEventsRef.current.delete(eventRuntimeId)
          }
        }
      }
      if (result.deletedCurrent) {
        resetActiveComposer()
        if (result.snapshot) {
          await prepareComposer(result.snapshot)
          applyRuntimeSnapshot(result.snapshot)
        }
        conversationPresentationsRef.current.delete(sessionId)
        void window.whycode.consensusStatus().then(setConsensus)
      }
      if (!result.ok) showError(result.error ?? '删除会话失败')
    }).catch(() => {
      showError('删除会话失败，请重试')
    }).finally(() => {
      if (!cleanupPending) {
        setDeletingSession(null)
        setDeletionBlocksRuntime(false)
      }
      void refreshSessions()
    })
  }, [
    applyRuntimeSnapshot,
    prepareComposer,
    draftStorageError,
    refreshSessions,
    resetActiveComposer,
    setDeletionBlocksRuntime,
    setDeletingSession,
    showError,
  ])

  const setSessionPinned = useCallback((sessionId: string, pinned: boolean) => {
    void window.whycode.setSessionPinned({ sessionId, pinned }).then((result) => {
      if (!result.ok) {
        showError(result.error)
        return
      }
      void refreshSessions()
    }).catch((error) => {
      showError(
        `更新会话置顶状态失败：${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }, [refreshSessions, showError])

  const compact = useCallback(() => {
    if (status !== 'idle' && status !== 'error') return
    showConversationFeedback('info', '正在压缩上下文，可点停止取消。')
    void sendRuntimeCommand({ type: 'compact' })
  }, [sendRuntimeCommand, showConversationFeedback, status])
  const forkConversation = useCallback((sourceTurnId: string) => {
    if (status !== 'idle' && status !== 'error') return
    const sourceSessionId = sessionIdRef.current
    if (!sourceSessionId || !beginSessionTransition()) return
    setForkPendingTurnId(sourceTurnId)
    void window.whycode.forkSession({ sourceSessionId, sourceTurnId }).then(async (result) => {
      if (!result.ok) {
        showError(result.error)
        return
      }
      await prepareComposer(result.snapshot)
      applyRuntimeSnapshot(result.snapshot)
      void window.whycode.consensusStatus().then(setConsensus)
      void refreshSessions()
      void refreshModelCatalog()
    }).catch((error) => {
      const message = `创建会话分支失败：${error instanceof Error ? error.message : String(error)}`
      showError(message)
    }).finally(() => {
      setForkPendingTurnId(null)
      endSessionTransition()
    })
  }, [
    showError,
    applyRuntimeSnapshot,
    prepareComposer,
    beginSessionTransition,
    endSessionTransition,
    refreshModelCatalog,
    refreshSessions,
    status,
  ])
  slashCommandRef.current = (command) => {
    setShowMcpStatus(command === 'mcp')
    if (command === 'compact') compact()
    if (command === 'fork' && latestForkTurnId) forkConversation(latestForkTurnId)
    if (command === 'btw' || command === 'bbtw') {
      if (status !== 'idle' && status !== 'error') return
      if (command === 'bbtw' && !view.btwContinuation) {
        showError('当前没有可续接的 BTW 对话')
        return
      }
      if (pdfDrafts.length > 0 || selectedSkills.length > 0 || restoredInputIds.length > 0) {
        showError('BTW 不使用 PDF、Skill 或恢复队列输入；请先移除这些内容')
        return
      }
      const currentModel = models.find((model) => model.id === modelId)
      if (imageDrafts.length > 0 && currentModel?.imageInputMode !== 'native') {
        showError('BTW 图片必须由当前模型原生读取')
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
      showError(nextModel?.unavailableReason ?? '该模型连接当前不可用')
      return
    }
    if (
      imageDrafts.length > 0
      && (btwMode ? nextModel.imageInputMode !== 'native' : nextModel.imageInputMode === 'none')
    ) {
      showError(btwMode
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
  }, [showError, btwMode, imageDrafts.length, modelId, models, reasoningEffort, sendRuntimeCommand])

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
      showError(`连接设置读取失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [showError])

  const openCurrentWorkspaceFolder = useCallback(() => {
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId) return
    void window.whycode.openWorkspaceFolder(targetRuntimeId).then((result) => {
      if (!result.ok) showError(result.error)
    }).catch((error) => {
      showError(`打开工作文件夹失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [showError])

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
      showError(`模型列表刷新失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [showError, refreshModelCatalog])

  const send = useCallback((urgent = false) => {
    if (
      stopping
      || sessionTransitionPending
      || deletionBlocksRuntime
      || resumingSessionId
      || checkpointRestoreToolUseId
      || submissionPending
    ) return
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId || composerSubmissions.getSnapshot().has(targetRuntimeId)) return
    const sentBtwMode = btwModeRef.current
    const sentSkills = captureSkills()
    if (
      sentBtwMode
      && (pdfDrafts.length > 0 || sentSkills.length > 0 || restoredInputIds.length > 0)
    ) {
      showError('BTW 不使用 PDF、Skill 或恢复队列输入')
      return
    }
    const text = input.trim()
      || attachmentFallbackText(imageDrafts.length, sentBtwMode ? 0 : pdfDrafts.length)
      || (imageDrafts.length === 0 && sentSkills.length ? '请按所选 Skill 执行。' : '')
    if (!text && imageDrafts.length === 0) return
    const sentImageDrafts = detachImageDrafts()
    const sentPdfDrafts = detachPdfDrafts()
    const sentRestoredInputIds = restoredInputIds
    const submission: ComposerSubmission = {
      runtimeId: targetRuntimeId,
      sessionId: sessionIdRef.current,
      draft: {
        text, images: sentImageDrafts, pdfs: sentPdfDrafts, skills: sentSkills,
        btwMode: sentBtwMode, restoredInputIds: sentRestoredInputIds,
      },
      ...(!conversationStarted && workspace.mode === 'pending-worktree'
        ? { worktreeBaseRef: workspace.baseRef } : {}),
    }
    composerSubmissions.start(submission)
    setRestoredInputIds([])
    setInput('')
    inputRef.current = ''
    clearSkills()
    setBtwMode(null)
    // 沿用发送前的浏览位置；只有原本贴底时，既有内容跟随才会继续滚动。
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
      let accepted = false
      try {
        await composerDraftsRef.current.save(
          composerDraftKey(targetRuntimeId, submission.sessionId), submission.draft,
        )
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
          accepted = true
        }
      } catch {
        if (runtimeIdRef.current === targetRuntimeId) {
          showError(sentImageDrafts.length || sentPdfDrafts.length
            ? '附件读取或消息发送失败，内容已恢复到输入框'
            : '消息发送失败，内容已恢复到输入框')
        }
      } finally {
        // IPC 确认与事件端口独立到达；首次提交须先取得正式身份，再移交后台草稿。
        if (submission.sessionId === null) {
          try {
            const snapshot = await window.whycode.runtimeSnapshot(targetRuntimeId)
            await bindComposerSession(targetRuntimeId, snapshot.sessionId)
            if (runtimeIdRef.current === targetRuntimeId) sessionIdRef.current = snapshot.sessionId
          } catch (error) {
            draftStorageError(error)
          }
        }
        // 先完成所属运行时的内存移交，再等待磁盘；切回时不会再次合并已经恢复的输入。
        let saved: Promise<void> | undefined
        try {
          if (accepted) releaseImageDrafts(sentImageDrafts)
          if (runtimeIdRef.current === targetRuntimeId) {
            if (!accepted) restoreRejectedInput()
          } else {
            const key = composerDraftKey(targetRuntimeId, submission.sessionId)
            const draft = accepted
              ? submission.remainder ?? { text: '', images: [], pdfs: [], skills: [], btwMode: null, restoredInputIds: [] }
              : prependComposerDraft(submission.draft, submission.remainder)
            composerDraftsRef.current.cache(key, draft)
            saved = composerDraftsRef.current.save(key, draft)
            if (!accepted) showError('消息未能发送，内容已恢复到原会话的输入框')
          }
        } finally {
          composerSubmissions.finish(submission)
        }
        await saved?.catch(draftStorageError)
      }
    })()
  }, [
    showError,
    submissionPending,
    bindComposerSession,
    composerSubmissions,
    draftStorageError,
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
    restoreFiles: boolean,
  ) => {
    if (interactionBusy || stopping) return false
    const target = block.btw && block.inputId
      ? { kind: 'btw' as const, inputId: block.inputId }
      : block.turnId
        ? { kind: 'main' as const, turnId: block.turnId, restoreFiles }
        : null
    if (!target) return false
    stickToBottom.current = true
    setShowJumpBottom(false)
    const result = await sendRuntimeCommand({ type: 'edit-user-message', target, text })
    if (!result?.ok) throw new Error(result?.error ?? '重新发送失败，请重试')
    return true
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
  const modelNeedsRefresh = Boolean(selectedModel?.hasKey && !selectedModel.available && !selectedModel.retired)
  useEffect(() => {
    if (!modelNeedsRefresh) return
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      // 代理启动时可能先返回部分目录；可用后由依赖变化撤销重查。
      void refreshModelCatalog().catch(() => {})
    }
    const timer = window.setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [modelNeedsRefresh, refreshModelCatalog])
  const modelUnavailableReason = selectedModel?.available
    ? null
    : selectedModel?.unavailableReason ?? '当前没有可用模型'
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
      showError('当前操作暂时锁定附件，请稍后重试')
      return
    }
    if (imageFiles.length > 0) {
      if (canAttachImages) addImageFiles(imageFiles)
      else showError(modelUnavailableReason ?? '当前模型没有可用的原生或辅助识图能力；PDF 仍可添加')
    }
    if (pdfFiles.length > 0) {
      if (canAttachPdfs) addPdfFiles(pdfFiles)
      else showError(modelUnavailableReason ?? '当前对话模式不支持添加 PDF')
    }
  }, [
    showError,
    addImageFiles,
    addPdfFiles,
    attachmentLocked,
    canAttachImages,
    canAttachPdfs,
    modelUnavailableReason,
  ])
  const attachmentDrop = useAttachmentDropTarget({
    canAttachImages,
    canAttachPdfs,
    modelUnavailableReason,
    interactionBusy: attachmentLocked,
    onImageFiles: addImageFiles,
    onPdfFiles: addPdfFiles,
    onError: showError,
  })
  const currentSession = sessions.find((session) => session.sessionId === sessionIdRef.current)
  const taskTitle = currentSession?.title
    || (blocks.length > 0 ? '当前会话' : '新会话')
  const messageEmpty = !input.trim()
    && imageDrafts.length === 0
    && pdfDrafts.length === 0
    && selectedSkills.length === 0
  const sendDisabled = composerControlsLocked || messageEmpty
  const primaryAction = composerPrimaryAction({ busy, hasDraft: !messageEmpty })
  const contextBaseRef = workspace.mode === 'pending-worktree'
    ? workspace.baseRef
    : workspace.mode === 'worktree'
      ? workspace.baseRef
      : null

  const pendingSession = sessions.find((session) => session.sessionId === resumingSessionId)
  const loadingConversation = resumingSessionId !== null && resumingSessionId !== sessionIdRef.current
  const pendingDraft = loadingConversation
    ? [...pendingSubmissions.values()].find((submission) => submission.sessionId === resumingSessionId)?.remainder
      ?? composerDraftsRef.current.get(resumingSessionId)
    : undefined
  // 草稿仍由已确认的运行时持有；切换期间只展示目标草稿，避免旧请求改写输入。
  const composerDraft = loadingConversation
    ? {
        text: pendingDraft?.text ?? '',
        images: pendingDraft?.images ?? [],
        pdfs: pendingDraft?.pdfs ?? [],
        skills: pendingDraft?.skills ?? [],
        btwMode: pendingDraft?.btwMode ?? null,
      }
    : { text: input, images: imageDrafts, pdfs: pdfDrafts, skills: selectedSkills, btwMode }

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

      <div className="contents" inert={panelFullscreen}>
        <AppSidebar
          collapsed={sidebarCollapsed}
          sessions={sessions}
          selectedSessionId={resumingSessionId ?? sessionIdRef.current}
          navigationLocked={sessionNavigationLocked}
          error={sessionListError}
          busy={sessionChangeLocked}
          deletingSessionId={deletingSessionId}
          onCollapsedChange={setSidebarCollapsed}
          onNewSession={() => startNewSession()}
          onResume={resumeSession}
          onPinnedChange={setSessionPinned}
          onDelete={deleteSession}
          onError={showError}
          onOpenSettings={openConnectionSettings}
        />
      </div>

      <section className="wc-shell-panel flex min-w-0 flex-1 flex-col bg-[var(--wc-surface)]">
        <div className="contents" inert={panelFullscreen}>
          <TaskHeader
            title={loadingConversation ? pendingSession?.title || '未命名会话' : taskTitle}
            projectDir={loadingConversation
              ? pendingSession?.workspace ? workspaceDisplayDirectory(pendingSession.workspace) : null
              : workspace.mode === 'pending-managed' ? null : projectDir}
            workspaceMode={loadingConversation ? pendingSession?.workspace?.mode ?? 'pending-managed' : workspace.mode}
            backgroundTasks={loadingConversation ? [] : backgroundTasks}
            rightPanelOpen={rightPanelState.open}
            disabled={loadingConversation}
            onOpenWorkspaceFolder={openCurrentWorkspaceFolder}
            onToggleRightPanel={() => updateRightPanelState((current) => ({
              ...current,
              open: !current.open,
            }))}
          />
        </div>
        <div className="relative flex min-h-0 flex-1">
          <aside
            inert={panelFullscreen}
            className="wc-conversation-navigator"
            aria-label="会话定位"
            aria-hidden={loadingConversation}
          >
            {!loadingConversation && (
              <ConversationNavigator
                key={runtimeId}
                sections={sections}
                earlierEntries={history.earlierEntries}
                navigationTargetIds={btwPresentation.navigationTargetIds}
                scrollRef={scrollRef}
                onNavigate={navigateConversation}
              />
            )}
          </aside>
          <section className="relative flex min-w-0 flex-1 flex-col" inert={panelFullscreen}>
            {(!loadingConversation || showConnectionSettings) && conversationFeedback && (
              <ConversationFeedbackToast
                key={conversationFeedback.id}
                feedback={conversationFeedback}
                floating={showConnectionSettings}
                onDismiss={dismissConversationFeedback}
              />
            )}
            <div className="relative flex min-h-0 flex-1">
              <main
                ref={scrollRef}
                onScroll={onScroll}
                className="wc-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5"
              >
                <div
                  ref={conversationContentRef}
                  className="wc-conversation-balanced-content mx-auto w-full max-w-4xl"
                >
                  {!loadingConversation && !conversationStarted && worktreePreparation && (
                    <WorktreePreparation
                      message={worktreePreparation.message}
                      baseRef={worktreePreparation.baseRef}
                    />
                  )}
                  {!loadingConversation && !conversationStarted && !worktreePreparation && (
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
                    pendingSessionId={loadingConversation ? resumingSessionId : null}
                    onReady={restoreConversationAfterRender}
                    active={resumingSessionId === null}
                    items={btwPresentation.items}
                    latestBtwConversationId={btwPresentation.latestBtwConversationId}
                    expandedIds={view.expanded}
                    editableBlockId={editableBlockId}
                    busy={interactionBusy}
                    checkpointRestoreAnchorIds={checkpointRestoreAnchors}
                    checkpointRestoreToolUseId={checkpointRestoreToolUseId}
                    fileRollbackBoundaryTurnId={view.fileRollbackBoundaryTurnId}
                    showThinkingGap={thinkingGapVisible}
                    forkSourceTurnId={forkOrigin?.sourceTurnId ?? null}
                    forkPendingTurnId={forkPendingTurnId}
                    skills={skillCatalog.skills}
                    projectDir={projectDir}
                    onCheckpointRestoreRequest={requestCheckpointRestore}
                    onEdit={editUserMessage}
                    onFork={forkConversation}
                    onOpenFilePreview={openFilePreview}
                    onToggle={toggle}
                  />
                </div>
              </main>
            </div>

            <div className="relative shrink-0 px-4 pb-4 pt-1">
              <div className="wc-conversation-balanced-content mx-auto w-full max-w-4xl">
                <div hidden={loadingConversation}>
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
                        <QueuedMessageCard
                          key={queuedMessage.id}
                          message={queuedMessage}
                          pendingAction={queuedActionPending[queuedMessage.id]}
                          onAction={(id, action) => void actOnQueuedMessage(id, action)}
                        />
                      ))}
                    </div>
                  )}

                  {restoredQueue.length > 0 && (
                    <div className="mb-2 rounded-xl bg-[var(--wc-sand)] px-3 py-2 text-xs text-[var(--wc-sand-ink)]">
                      另有 {restoredQueue.length} 条中断输入已安全保留；当前恢复输入提交后会按原顺序继续恢复。
                    </div>
                  )}

                  {workStartedAt !== null && (
                    <div className="mb-1.5 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-3 px-2 text-xs">
                      <span className="whitespace-nowrap text-[var(--wc-faint)]">
                        <ProcessingTime startedAt={workStartedAt} />
                      </span>
                      <ComposerFileChanges changes={currentFileChanges} />
                    </div>
                  )}
                </div>

                <footer
                  className={`wc-composer relative p-2.5 ${composerDraft.btwMode ? 'wc-composer-btw' : ''}`}
                  aria-busy={resumingSessionId !== null}
                  inert={resumingSessionId !== null}
                >
                  <div hidden={loadingConversation}>
                    {view.pendingQuestion && (
                      <QuestionCard
                        key={view.pendingQuestion.id}
                        question={view.pendingQuestion}
                        disabled={interactionBusy || stopping || questionSubmitting}
                        onAnswer={answerQuestion}
                      />
                    )}
                  </div>
                  <div hidden={!loadingConversation && view.pendingQuestion !== null}>
                    {showMcpStatus && !skillTrigger && !attachmentLocked && (
                      <ComposerMcpStatus
                        key={runtimeId}
                        runtimeId={runtimeId}
                        composerRef={composerTextareaRef}
                        onClose={() => setShowMcpStatus(false)}
                      />
                    )}
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

                    {!loadingConversation && !conversationStarted && !worktreePreparation && (
                      <WorkspaceContextBar
                        workspace={workspace}
                        candidate={workspaceCandidate}
                        projectDir={projectDir}
                        baseRef={contextBaseRef}
                        busy={sessionChangeLocked}
                        canChangeWorkspace={canChangeSessionWorkspace(sessionIdRef.current)}
                        onPickProject={pickProject}
                        onClearProject={() => startNewSession(true)}
                        onStart={startWorkspaceSession}
                      />
                    )}

                    <ImageDraftStrip drafts={composerDraft.images} onRemove={removeImageDraft} />
                    <PdfDraftStrip drafts={composerDraft.pdfs} onRemove={removePdfDraft} />
                    <SkillChips
                      skills={composerDraft.skills}
                      disabled={composerControlsLocked}
                      onRemove={removeSelectedSkill}
                    />

                    {composerDraft.btwMode && (
                      <div className="mb-1 flex items-center px-1.5">
                        <span className="inline-flex items-center gap-1 rounded-lg bg-black/[0.045] px-2 py-1 text-xs text-[var(--wc-muted)]">
                          {composerDraft.btwMode.toUpperCase()} · 临时侧对话
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
                      value={composerDraft.text}
                      onChange={(event) => {
                        const text = event.target.value
                        setShowMcpStatus(false)
                        inputRef.current = text
                        setInput(text)
                        updateSkillMenu(text, event.target.selectionStart)
                      }}
                      onSelect={(event) => updateSkillMenu(inputRef.current, event.currentTarget.selectionStart)}
                      onBlur={closeSkillMenu}
                      onPaste={pasteAttachments}
                      disabled={composerDisabled || resumingSessionId !== null}
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
                        loadingConversation
                          ? '输入消息…（/ 选择功能或 Skill，Shift+Enter 换行）'
                          : stopping
                            ? '正在停止当前任务并清理子进程…'
                            : worktreePreparation
                              ? '正在创建 Worktree 并检出文件…'
                              : sessionTransitionPending
                                ? '正在切换会话…'
                                : deletionBlocksRuntime
                                  ? '正在删除当前会话及其关联数据…'
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
                      attachmentLocked={composerControlsLocked}
                      configurationLocked={composerControlsLocked}
                      permissionLocked={
                        sessionTransitionPending
                        || deletionBlocksRuntime
                      }
                      permMode={permMode}
                      consensus={consensus}
                      models={models}
                      modelId={modelId}
                      reasoningEffort={reasoningEffort}
                      contextUsage={conversationStarted ? contextUsage : null}
                      primaryAction={primaryAction}
                      stopping={stopping}
                      stopDisabled={
                        stopping
                        || sessionTransitionPending
                        || deletionBlocksRuntime
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
                  </div>
                </footer>
              </div>
            </div>
          </section>

          <div
            ref={rightPanelRef}
            data-fullscreen={panelFullscreen}
            data-panel-open={rightPanelState.open ? 'true' : 'false'}
            aria-busy={loadingConversation}
            inert={loadingConversation}
            className={`wc-right-panel-shell relative h-full shrink-0 overflow-clip bg-[var(--wc-surface)] transition-[width,margin-left] duration-200 ease-out ${
              rightPanelState.open
                ? 'ml-0'
                : 'ml-3 w-[348px] max-[1440px]:ml-0 max-[1440px]:w-0 max-[1440px]:pointer-events-none'
            }`}
            style={{
              width: rightPanelState.open
                ? rightPanelWidthExpression(
                    rightPanelWidthPreference.ratio,
                    rightPanelWidthPreference.maximumRatio,
                  )
                : undefined,
            }}
          >
            {!panelFullscreen && (rightPanelState.open || rightPanelResizeActive) && (
              <RightPanelResizeHandle
                panelRef={rightPanelRef}
                ratio={rightPanelWidthPreference.ratio}
                maximumRatio={rightPanelWidthPreference.maximumRatio}
                onRatioChange={updateRightPanelWidthRatio}
                onCollapse={collapseRightPanel}
                onPreviewExpand={previewRightPanelExpand}
                onResizeActiveChange={setRightPanelResizeActive}
              />
            )}
            <div
              className={`absolute inset-y-0 left-0 w-[348px] transition-[opacity,transform] duration-200 ease-out ${
                rightPanelState.open
                  ? 'pointer-events-none -translate-x-3 opacity-0'
                  : 'translate-x-0 opacity-100 max-[1440px]:opacity-0'
              }`}
              aria-hidden={rightPanelState.open}
              inert={rightPanelState.open}
            >
              <TaskInspector
                runtimeId={runtimeId}
                workspace={workspace}
                plan={view.taskPlan}
                activeSkills={activeSkills}
                view={rightPanelState.inspectorView}
                onViewChange={(inspectorView) => updateRightPanelState((current) => ({
                  ...current, inspectorView,
                }))}
                subagents={subagents}
                busy={interactionBusy}
                worktreeStatusRevision={worktreeStatusRevision}
                onPrepareCommitPrompt={prepareCommitPrompt}
                onOpenSubagents={() => {
                  showRightPanelPage({ kind: 'subagent-overview' })
                }}
              />
            </div>
            <div
              className={`absolute inset-y-0 right-0 w-full transition-[opacity,transform] duration-200 ease-out ${
                rightPanelState.open
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none translate-x-8 opacity-0'
              }`}
              aria-hidden={!rightPanelState.open}
              inert={!rightPanelState.open}

            >
              <RightPanel
                active={rightPanelState.open}
                runtimeId={runtimeId}
                refreshRevision={`${view.fileSystemRevision}:${filePreviewInteractionRevision}`}
                parentSessionId={sessionIdRef.current}
                subagents={subagents}
                skills={skillCatalog.skills}
                projectDir={projectDir}
                state={rightPanelState}
                workspacePath={workspaceDisplayDirectory(workspace)}
                fullscreen={panelFullscreen}
                onToggleFullscreen={() => setRightPanelFullscreen(value => !value)}
                onCollapse={collapseRightPanel}
                onOpenPage={showRightPanelPage}
                onSelectTab={selectRightPanelTab}
                onCloseTab={closeRightPanelPage}
                terminalOpening={terminalOpening}
                onOpenTerminal={() => { void openRightPanelTerminal() }}
              />
            </div>
          </div>
        </div>
      </section>

      {showConnectionSettings && connectionSettings && (
        <ConnectionSettingsPanel
          snapshot={connectionSettings}
          workspaceCleanup={workspaceCleanup}
          onClose={() => setShowConnectionSettings(false)}
          onChanged={applyConnectionSettings}
          onError={showError}
        />
      )}
    </div>
  )
}

function composerKey(runtimeId: string, sessionId: string | null): string {
  return sessionId ?? `runtime:${runtimeId}`
}

function withoutQueuedAction(
  current: Partial<Record<string, QueuedMessageAction>>,
  id: string,
): Partial<Record<string, QueuedMessageAction>> {
  if (!(id in current)) return current
  const next = { ...current }
  delete next[id]
  return next
}

function sameSessionList(
  current: readonly SessionListItem[],
  next: readonly SessionListItem[],
): boolean {
  if (current.length !== next.length) return false
  return current.every((item, index) => JSON.stringify(item) === JSON.stringify(next[index]))
}
