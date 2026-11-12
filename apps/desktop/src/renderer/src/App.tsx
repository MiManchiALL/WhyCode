import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { MessageCircleQuestionMark } from 'lucide-react'
import { ForkProgressDialog } from './session-loading.tsx'
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
  type QuestionSubmission,
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
  DeleteSessionOptions,
  DeleteSessionResult,
} from '../../shared/session.ts'
import type { ModelListItem } from '../../shared/settings.ts'
import { attachmentFallbackText } from '../../shared/user-message.ts'
import {
  workspaceDisplayDirectory,
  type RuntimeWorkspace,
  type StartWorkspaceRequest,
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
  updateDeletingSessions,
} from './session-deletion-state.ts'
import { reconcileQuestionDraft } from './question-progress.ts'
import { ComposerActionButton } from './composer-action-button.tsx'
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
import { ThinkingGapIndicator } from './thinking-gap-indicator.tsx'
import { useSshWorkspaceConnection } from './use-ssh-workspace-connection.ts'
import { ConnectionSettingsPanel } from './connection-settings-panel.tsx'
import { useConversationFontSize } from './conversation-font-size.ts'
import { useCompletionSound } from './use-completion-sound.ts'
import { RetainedWorkspaceCleanup } from './retained-workspace-cleanup.ts'
import { gitConnectionUnavailableReason, useGitSnapshot } from './git-data.ts'
import { defaultGitPage } from './right-panel-state.ts'
import { gitOverviewPage, useGitComparisonRecovery } from './git-comparison.ts'
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
import { ComposerInput } from './composer-input.tsx'
import { ComposerText, ComposerValue } from './composer-text.ts'
import { ComposerDraftStore, composerDraftKey, type QuestionDraft } from './composer-drafts.ts'
import { ComposerCodeReferences, codeReferenceMessage, draftCodeReference, splitCodeReferenceMessage } from './code-reference.ts'
import { CodeReferenceChips } from './code-reference-chips.tsx'
import type { CodeReview } from './code-review.tsx'
import {
  ComposerSubmissions,
  composerInputIds,
  composerSubmissionPreview,
  presentPendingInputs,
  prependComposerDraft,
  type ComposerSubmission,
} from './composer-submissions.ts'
import { PendingUserMessage } from './pending-user-message.tsx'
import { WorkspaceContextBar } from './workspace-context-bar.tsx'
import { MarkdownNavigation } from './markdown-content.tsx'
import { canChangeSessionWorkspace } from './workspace-selection.ts'
import { SkillChips, ComposerSlashMenu } from './skill-picker.tsx'
import { useScrollIntent } from './use-scroll-intent.ts'
import { useSkillComposer } from './use-skill-composer.ts'
import type { ComposerCommandId } from './skill-trigger.ts'
import { AppSidebar } from './app-sidebar.tsx'
import { pruneSidebarProjectCollapse } from './sidebar-collapse.ts'
import type { SidebarProject } from '../../shared/projects.ts'
import { TaskHeader } from './task-header.tsx'
import { normalizeSessionName } from '../../shared/session-name.ts'
import { ComposerToolbar } from './composer-toolbar.tsx'
import { isSubagentRunning } from './subagent-presentation.ts'
import { TaskInspector } from './task-inspector.tsx'
import { ComposerMcpStatus } from './composer-mcp-status.tsx'
import { RightPanel } from './right-panel.tsx'
import { guardBrowserAction, routeBrowserPage } from './browser-host-state.ts'
import { disposeTerminalView, loadTerminalViews } from './terminal-panel.tsx'
import { PanelResizeHandle } from './panel-resize-handle.tsx'
import { panelWidthExpression, type PanelSide } from './panel-layout.ts'
import { usePanelLayout } from './use-panel-layout.ts'
import { WorktreePreparation } from './worktree-preparation.tsx'
import {
  closeRightPanelTab,
  closeBrowserTabs,
  canAddRightPanelTab,
  moveRightPanelTab,
  updateRightPanelPage,
  browserReferencePage,
  openRightPanelPage as openRightPanelPageState,
  RightPanelSessionStore,
  rightPanelSessionKey,
  registerBrowserPage,
  selectRightPanelTab as selectRightPanelTabState,
  type RightPanelPage,
  type RightPanelSessionState,
} from './right-panel-state.ts'
import { watchBrowserData } from './browser-data-state.ts'
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
  type ConversationScrollAlignment,
} from './conversation-scroll.ts'
import { ConversationEventBuffer } from './conversation-event-buffer.ts'
import { subscribeRuntimeEventBatches } from './runtime-event-stream.ts'
import {
  QueuedMessageList,
  type QueuedMessageAction,
} from './queued-message-card.tsx'
import {
  ConversationFeedbackContext,
  ConversationFeedbackToast,
} from './conversation-feedback.tsx'
import { conversationEventFeedback, type ConversationFeedback } from './conversation-feedback-state.ts'
import type { CheckpointRestoreRequest } from './checkpoint-restore-controls.ts'

export function App() {
  const [runtimeId, setRuntimeId] = useState('')
  const [view, setView] = useState(() => createConversationState())
  const [input] = useState(() => new ComposerText())
  const [codeReferences] = useState(() => new ComposerCodeReferences())
  const codeItems = useSyncExternalStore(codeReferences.subscribe, codeReferences.getSnapshot)
  const setInput = input.set
  const inputEmpty = useSyncExternalStore(input.subscribe, input.isEmpty)
  const [btwMode, setBtwModeState] = useState<BtwMode | null>(null)
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [workStartedAt, setWorkStartedAt] = useState<number | null>(null)
  const [stopping, setStopping] = useState(false)
  const [sessionTransition, setSessionTransition] = useState<'workspace' | 'fork' | null>(null)
  const sessionTransitionPending = sessionTransition !== null
  const [questionInput] = useState(() => new ComposerValue<QuestionDraft | undefined>(undefined))
  const questionCollapsed = useSyncExternalStore(questionInput.subscribe, () => Boolean(questionInput.getSnapshot()?.collapsed))
  const [composerSubmissions] = useState(() => new ComposerSubmissions())
  const pendingSubmissions = useSyncExternalStore(composerSubmissions.subscribe, composerSubmissions.getSnapshot)
  const activeSubmission = pendingSubmissions.get(runtimeId)
  const submissionPending = Boolean(activeSubmission)
  const restoredSubmissionPending = Boolean(activeSubmission?.draft.restoredInputIds.length)
  const worktreePreparation = activeSubmission?.worktreeBaseRef !== undefined
    ? { baseRef: activeSubmission.worktreeBaseRef }
    : null
  const [models, setModels] = useState<ModelListItem[]>([])
  const [modelId, setModelId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortSelection>('default')
  const [contextUsage, setContextUsage] = useState<ContextUsageInfo | null>(null)
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskSummary[]>([])
  const [gitStatusRevision, setGitStatusRevision] = useState(0)
  const [filePreviewInteractionRevision, setFilePreviewInteractionRevision] = useState(0)
  const [subagents, setSubagents] = useState<SubagentSummary[]>([])
  const [activeSkills, setActiveSkills] = useState<SkillSummary[]>([])
  const [currentFileChanges, setCurrentFileChanges] = useState<ToolFileChange[]>([])
  const [showMcpStatus, setShowMcpStatus] = useState(false)
  const [committedRightPanelState, setRightPanelState] = useState<RightPanelSessionState>({
    open: false,
    tabs: [],
    activeTabId: null,
    inspectorView: 'plan',
  })
  const [rightPanelFullscreen, setRightPanelFullscreen] = useState(false)
  const [terminalOpening, setTerminalOpening] = useState(false)
  const [rightPanelResizeActive, setRightPanelResizeActive] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'general' | 'ssh' | null>(null)
  const showConnectionSettings = settingsSection !== null
  const [conversationFontSize, setConversationFontSize] = useConversationFontSize()
  const { enabled: completionSoundEnabled, setEnabled: setCompletionSoundEnabled, play: playCompletionSound } = useCompletionSound()
  const [approval, setApproval] = useState<Approval | null>(null)
  const [workspace, setWorkspace] = useState<RuntimeWorkspace>({ mode: 'none' })
  const [queued, setQueued] = useState<QueuedUserMessage[]>([])
  const [queuedMessagesCollapsed, setQueuedMessagesCollapsed] = useState(false)
  const [queuedActionPending, setQueuedActionPending] = useState<
    Partial<Record<string, QueuedMessageAction>>
  >({})
  const queueEditPending = Object.values(queuedActionPending).includes('edit')
  const [restoredInputIds, setRestoredInputIds] = useState<string[]>([])
  const [restoredQueue, setRestoredQueue] = useState<QueuedUserMessage[]>([])
  const [permMode, setPermMode] = useState<PermissionMode>('default')
  const [consensus, setConsensus] = useState<{ ready: boolean; reason: string | null; enabled: boolean }>({ ready: false, reason: null, enabled: false })
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [projects, setProjects] = useState<SidebarProject[]>([])
  const [sessionListError, setSessionListError] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [deletingSessionIds, setDeletingSessionIds] = useState<ReadonlySet<string>>(() => new Set())
  const [resumingSessionId, setResumingSessionIdState] = useState<string | null>(null)
  const [checkpointRestoreToolUseId, setCheckpointRestoreToolUseId] = useState<string | null>(null)
  const [conversationFeedback, setConversationFeedback] =
    useState<ConversationFeedback | null>(null)
  const [forkOrigin, setForkOrigin] = useState<SessionForkOrigin | null>(null)
  /** 协商进行中的状态条文案（null = 无协商） */
  const [negoStatus, setNegoStatus] = useState<string | null>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const conversationContentRef = useRef<HTMLDivElement>(null)
  const rightPanelStateRef = useRef(committedRightPanelState)
  const rightPanelSessionStoreRef = useRef<RightPanelSessionStore | null>(null)
  if (!rightPanelSessionStoreRef.current) {
    rightPanelSessionStoreRef.current = new RightPanelSessionStore()
  }
  const sessionTransitionPendingRef = useRef<{ promise: Promise<void>; finish: () => void } | null>(null)
  const resumingSessionIdRef = useRef<string | null>(null)
  const resumeRequestRef = useRef<Promise<void> | null>(null)
  const deletingSessionIdsRef = useRef(deletingSessionIds)
  const runtimeIdRef = useRef('')
  const sessionIdRef = useRef<string | null>(null)
  const activeEventSequenceRef = useRef(0)
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
  rightPanelStateRef.current = committedRightPanelState
  expandedIdsRef.current = view.expanded
  const loadingConversation = resumingSessionId !== null && resumingSessionId !== sessionIdRef.current
  // 描述符跟随导航展示；只有成功快照才能移交可写状态，失败时仍属于原会话。
  const rightPanelState = loadingConversation
    ? rightPanelSessionStoreRef.current.get(resumingSessionId)
    : committedRightPanelState
  const panelFullscreen = rightPanelFullscreen && rightPanelState.open
  // 记录上次跟随的底部坐标，区分正文重新排版和同一布局内的滚动。null 表示正在阅读正文。
  const followedBottom = useRef<number | null>(0)
  const scrollToEnd = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    followedBottom.current = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    scroller.scrollTop = followedBottom.current
  }, [])
  const [showJumpBottom, setShowJumpBottom] = useState(false)
  const recentlyScrolledAway = useScrollIntent(scrollRef, () => {
    followedBottom.current = null
    pendingScrollRestoreRef.current = null
  }, !loadingConversation)
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
  const submissionPreview = composerSubmissionPreview(activeSubmission, blocks, queued)
  const pendingMessage = submissionPreview?.location === 'conversation' ? submissionPreview.draft : null
  const pendingQueuedMessage = submissionPreview?.location === 'queue' ? submissionPreview.draft : null
  const projectDir = workspaceDisplayDirectory(workspace)
  const explicitProjectSelected = workspace.mode !== 'pending-managed' && Boolean(projectDir)
  const conversationStarted = blocks.some((block) => block.kind === 'user')
  const presentedInputs = useMemo(() => presentPendingInputs(blocks, queued, workStartedAt !== null), [blocks, queued, workStartedAt])
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
  const scrollToConversation = useCallback((targetId: string | HTMLElement, alignment: ConversationScrollAlignment = 'start') => {
    const scroller = scrollRef.current
    if (!scroller) return false
    releaseConversationScroll()
    const navigation = scrollConversationToTarget(scroller, targetId, alignment)
    if (!navigation) return false
    conversationScrollReleaseRef.current = navigation.release
    followedBottom.current = null
    setShowJumpBottom(true)
    return true
  }, [releaseConversationScroll])
  const history = useConversationHistory({
    prepend: (pages) => {
      const scroller = scrollRef.current
      if (scroller) pendingScrollRestoreRef.current = captureConversationScrollPosition(scroller)
      setView((current) => pages.reduce(prependConversationHistory, current))
    },
    onError: (message) => showError(message),
  })
  const navigateConversation = useCallback((targetId: string | HTMLElement, alignment: ConversationScrollAlignment = 'start') => {
    pendingScrollRestoreRef.current = null
    if (!scrollToConversation(targetId, alignment) && typeof targetId === 'string') {
      void history.loadOlder(targetId)
    } else {
      history.cancel()
    }
  }, [history.cancel, history.loadOlder, scrollToConversation])
  const latestForkTurnId = useMemo(() => findLatestForkTurnId(sections), [sections])
  const setBtwMode = useCallback((mode: BtwMode | null) => {
    btwModeRef.current = mode
    setBtwModeState(mode)
  }, [])
  const {
    menuId: composerMenuId,
    activeOptionId: composerActiveOptionId,
    catalog: skillCatalog,
    loading: skillCatalogLoading,
    selected: selectedSkills,
    trigger: skillTrigger,
    matches: composerMenuItems,
    activeIndex: skillActiveIndex,
    limitReached: skillLimitReached,
    editorRef: composerInputRef,
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
    forkDisabled: sessionTransitionPending,
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
    pendingMessage: pendingMessage !== null && worktreePreparation === null,
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
    floating = false,
  ) => {
    setConversationFeedback({
      id: ++conversationFeedbackIdRef.current,
      tone,
      message,
      floating,
    })
  }, [])
  const dismissConversationFeedback = useCallback((id: number) => {
    setConversationFeedback((current) => current?.id === id ? null : current)
  }, [])
  const showError = useCallback((text: string) => {
    showConversationFeedback('error', text)
  }, [showConversationFeedback])
  const sshConnection = useSshWorkspaceConnection(workspace.mode === 'ssh' ? workspace.target : null, showError)
  const sshConnecting = sshConnection.connection?.status === 'connecting'
  const sshSendUnavailableReason = sshConnection.sendUnavailableReason
  const gitPage = committedRightPanelState.tabs.find(tab => tab.page.kind === 'git')?.page
  const gitRevision = `${gitStatusRevision}:${sshConnection.connection?.status ?? ''}`
  const gitData = useGitSnapshot(runtimeId, { mode: 'branch', baseRef: gitPage?.kind === 'git' ? gitPage.baseRef : null },
    gitRevision, conversationStarted && !loadingConversation && !!runtimeId && !workspace.mode.startsWith('pending-') && workspace.mode !== 'none',
    workspace.mode === 'ssh' ? gitConnectionUnavailableReason(sshConnection.connection?.status, sshConnection.loading) : null)
  const [workspaceCleanup] = useState(() => new RetainedWorkspaceCleanup(async workspace => {
    const result = await window.whycode.deleteRetainedWorkspace(workspace)
    if (!result.ok) throw new Error(result.error)
  }, showError))
  const {
    drafts: imageDrafts,
    addFiles: addImageFiles,
    remove: removeImageDraft,
    detach: detachImageDrafts,
    restore: restoreImageDrafts,
    replaceAll: replaceImageDrafts,
    addReference: addBrowserReference,
  } = useImageDrafts(showError)
  const {
    drafts: pdfDrafts,
    addFiles: addPdfFiles,
    remove: removePdfDraft,
    detach: detachPdfDrafts,
    restore: restorePdfDrafts,
    replace: replacePdfDrafts,
  } = usePdfDrafts(showError)

  const messageEmpty = inputEmpty && imageDrafts.length === 0 && pdfDrafts.length === 0 && selectedSkills.length === 0 && codeItems.length === 0
  const hasComposerDraft = !messageEmpty || btwMode !== null
  const editRestoredInput = useCallback((item: QueuedUserMessage) => {
    const { text, references } = splitCodeReferenceMessage(item.text)
    setInput(text)
    codeReferences.replace(references.map(draftCodeReference))
    replaceImageDrafts(restoredImageDrafts([item]))
    replacePdfDrafts(restoredPdfDrafts([item]))
    replaceSkills(item.skills ?? [])
    closeSkillMenu()
    setBtwMode(null)
    setRestoredInputIds([item.id])
  }, [setInput, codeReferences, replaceImageDrafts, replacePdfDrafts, replaceSkills, closeSkillMenu, setBtwMode])

  useEffect(() => () => {
    conversationEventBufferRef.current?.clear()
    composerDraftsRef.current.dispose()
  }, [])

  const draftStorageError = useCallback((error: unknown) => {
    showError(`输入草稿保存或恢复失败：${error instanceof Error ? error.message : String(error)}`)
  }, [showError])

  const stashActiveComposer = useCallback(() => {
    const currentRuntimeId = runtimeIdRef.current
    if (!currentRuntimeId) return
    const currentSessionId = sessionIdRef.current
    const images = detachImageDrafts()
    const pdfs = detachPdfDrafts()
    const text = input.getSnapshot()
    const skills = captureSkills()
    const currentBtwMode = btwModeRef.current
    const draft = {
      question: questionInput.getSnapshot(), text, images, pdfs, skills, codeReferences: codeReferences.getSnapshot(),
      btwMode: currentBtwMode, restoredInputIds: restoredInputIdsRef.current,
    }
    const pending = composerSubmissions.getSnapshot().get(currentRuntimeId)
    // 切换前保存当前所有者的最新输入，不能等新会话接管后再执行自动保存。
    void composerDraftsRef.current.save(composerDraftKey(currentRuntimeId, currentSessionId),
      pending ? prependComposerDraft(pending.draft, draft) : draft).catch(draftStorageError)
    if (pending) pending.remainder = draft
    else composerDraftsRef.current.cache(composerDraftKey(currentRuntimeId, currentSessionId), draft)
  }, [input, captureSkills, codeReferences, questionInput, composerSubmissions, detachImageDrafts, detachPdfDrafts, draftStorageError])

  const persistComposer = useCallback(async () => {
    if (!runtimeId || runtimeId !== runtimeIdRef.current) return
    const draft = {
      question: questionInput.getSnapshot(), text: input.getSnapshot(), images: imageDrafts, pdfs: pdfDrafts, skills: selectedSkills,
      codeReferences: codeReferences.getSnapshot(), btwMode, restoredInputIds,
    }
    const pending = composerSubmissions.getSnapshot().get(runtimeId)
    await composerDraftsRef.current.save(composerDraftKey(runtimeId, sessionIdRef.current),
      pending ? prependComposerDraft(pending.draft, draft) : draft)
  }, [runtimeId, input, imageDrafts, pdfDrafts, selectedSkills, btwMode, restoredInputIds,
    submissionPending, composerSubmissions, questionInput, codeReferences])
  const persistComposerRef = useRef(persistComposer)
  persistComposerRef.current = persistComposer

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void persistComposer().catch(draftStorageError)
      }, 250)
    }
    schedule()
    const unsubscribe = input.subscribe(schedule)
    const unsubscribeQuestions = questionInput.subscribe(schedule)
    const unsubscribeCode = codeReferences.subscribe(schedule)
    return () => { unsubscribe(); unsubscribeQuestions(); unsubscribeCode(); clearTimeout(timer) }
  }, [input, persistComposer, questionInput, codeReferences, draftStorageError])
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
    if (promoted) return composerDraftsRef.current.move(composerDraftKey(ownerRuntimeId, null), sessionId)
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
      followedBottom.current !== null
        ? { atBottom: true, scrollTop: 0 }
        : captureConversationScrollPosition(scrollElement),
      scrollElement.querySelector<HTMLElement>('[data-conversation-scroll-block]')?.dataset.conversationScrollBlock,
    )
  }, [])

  const setResumingSessionId = useCallback((sessionId: string | null) => {
    if (sessionId) history.cancel()
    resumingSessionIdRef.current = sessionId
    setResumingSessionIdState(sessionId)
  }, [history.cancel])

  const setDeletingSession = useCallback((sessionId: string, deleting: boolean) => {
    const next = updateDeletingSessions(deletingSessionIdsRef.current, sessionId, deleting)
    deletingSessionIdsRef.current = next
    setDeletingSessionIds(next)
  }, [])

  const beginSessionTransition = useCallback((kind: 'workspace' | 'fork' = 'workspace') => {
    if (sessionTransitionPendingRef.current) return false
    history.cancel()
    let finish!: () => void
    const promise = new Promise<void>(resolve => { finish = resolve })
    sessionTransitionPendingRef.current = { promise, finish }
    setSessionTransition(kind)
    return true
  }, [history.cancel])

  const endSessionTransition = useCallback(() => {
    sessionTransitionPendingRef.current?.finish()
    sessionTransitionPendingRef.current = null
    setSessionTransition(null)
  }, [])

  const sendRuntimeCommand = useCallback((command: CoreCommand) => {
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId) return Promise.resolve({ ok: false, error: '当前没有可操作的会话' })
    return window.whycode.sendCommand(targetRuntimeId, command)
  }, [])

  const stopBackgroundTask = useCallback(async (task: BackgroundTaskSummary) => {
    if (sessionIdRef.current !== task.sessionId) throw new Error('会话已切换，请重新打开后台任务')
    const result = await sendRuntimeCommand({ type: 'stop-background-task', taskId: task.id })
    if (!result?.ok) throw new Error(result?.error || '停止后台任务失败，请重试')
  }, [sendRuntimeCommand])

  const actOnQueuedMessage = useCallback(async (
    id: string,
    action: QueuedMessageAction,
  ) => {
    const owner = runtimeIdRef.current
    if (action === 'edit' && (queueEditPending || composerSubmissions.getSnapshot().has(owner))) return
    setQueuedActionPending((current) => ({ ...current, [id]: action }))
    try {
      const oldIds = restoredInputIdsRef.current
      const result = await sendRuntimeCommand(action === 'edit'
        ? { type: 'queued-message-action', id, action, ...(oldIds.length ? { replacesRestoredInputIds: oldIds } : {}) }
        : { type: 'queued-message-action', id, action })
      if (owner !== runtimeIdRef.current || (result?.ok && action !== 'discard')) return
      setQueuedActionPending((current) => withoutQueuedAction(current, id))
      if (result?.error) showError(result.error)
    } catch {
      if (owner !== runtimeIdRef.current) return
      setQueuedActionPending((current) => withoutQueuedAction(current, id))
      showError('排队消息操作失败，请重试')
    }
  }, [composerSubmissions, queueEditPending, sendRuntimeCommand, showError])

  // 恢复此前已取回编辑的输入；实时取回仍由宿主确认后替换草稿。
  useEffect(() => {
    if (
      restoredQueue.length === 0
      || restoredInputIds.length > 0
      || restoredSubmissionPending
      || queueEditPending
      || hasComposerDraft
    ) return
    const next = restoredQueue[0]!
    setRestoredQueue((previous) => previous.filter((item) => item.id !== next.id))
    editRestoredInput(next)
  }, [
    editRestoredInput,
    hasComposerDraft,
    queueEditPending,
    restoredInputIds.length,
    restoredQueue,
    restoredSubmissionPending,
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
          const next = await window.whycode.listSessionSidebar()
          pruneSidebarProjectCollapse(next.projects)
          const orderedProjects = next.projects.toReversed().sort((a, b) => Number(Boolean(a.remote)) - Number(Boolean(b.remote)))
          setSessions((current) => sameSidebarItems(current, next.sessions) ? current : next.sessions)
          setProjects((current) => sameSidebarItems(current, orderedProjects) ? current : orderedProjects)
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
    try {
      const nextModels = await window.whycode.listModels(targetRuntimeId || undefined)
      if (runtimeIdRef.current !== targetRuntimeId) return
      setModels(nextModels)
    } catch (error) {
      if (runtimeIdRef.current === targetRuntimeId) {
        showError(error instanceof Error ? error.message : String(error))
      }
    }
  }, [showError])

  const applyBackgroundTaskState = useCallback((state: BackgroundTaskState) => {
    if (
      state.sessionId !== sessionIdRef.current
      || state.revision <= backgroundTaskRevisionRef.current
    ) return
    backgroundTaskRevisionRef.current = state.revision
    setBackgroundTasks(state.tasks)
    setGitStatusRevision((revision) => revision + 1)
  }, [])

  const applySubagentState = useCallback((state: SubagentState) => {
    if (
      state.parentSessionId !== sessionIdRef.current
      || state.revision <= subagentRevisionRef.current
    ) return
    subagentRevisionRef.current = state.revision
    setSubagents(state.subagents)
    setGitStatusRevision((revision) => revision + 1)
  }, [])

  const updateRightPanelState = useCallback((
    update: RightPanelSessionState
      | ((current: RightPanelSessionState) => RightPanelSessionState),
  ) => {
    const current = rightPanelStateRef.current
    const next = typeof update === 'function' ? update(current) : update
    if (next === current) return
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

  const changeRightPanelPage = useCallback((page: RightPanelPage) => {
    updateRightPanelState(current => updateRightPanelPage(current, page))
  }, [updateRightPanelState])
  useGitComparisonRecovery(!loadingConversation && gitPage?.kind === 'git' ? gitPage : undefined, gitData, changeRightPanelPage)

  const changePanelOpen = useCallback((side: PanelSide, open: boolean) => {
    if (side === 'left') setSidebarCollapsed(!open)
    else {
      if (!open) setRightPanelFullscreen(false)
      updateRightPanelState(current => ({ ...current, open }))
    }
  }, [updateRightPanelState])
  const panelLayout = usePanelLayout(rightPanelState.open, changePanelOpen)

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
    activeEventSequenceRef.current = snapshot.eventSequence
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
      questionInput.replace(reconcileQuestionDraft(draft?.question, snapshot.history.view.pendingQuestions))
      setInput(draft?.text ?? '')
      codeReferences.replace(draft?.codeReferences ?? [])
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
    setQueuedMessagesCollapsed(presentation?.queuedMessagesCollapsed ?? false)
    const replayedView = restoreConversationSnapshot(snapshot.history.view)
    composerSubmissions.receiveSnapshot(snapshot.runtimeId, replayedView.blocks, snapshot.queuedInputs)
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
      followedBottom.current = scroll.atBottom ? scroll.scrollTop : null
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
    if (snapshot.deletingSessionId) setDeletingSession(snapshot.deletingSessionId, true)
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
  }, [
    setComposerSessionId,
    setInput,
    composerSubmissions,
    applyBackgroundTaskState,
    applySubagentState,
    restoreImageDrafts,
    restorePdfDrafts,
    replaceSkills,
    resetSkillCatalog,
    setBtwMode,
    setDeletingSession,
    setResumingSessionId,
    stashActiveComposer, questionInput, codeReferences,
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
    composerSubmissions.receiveEvent(runtimeIdRef.current, event)
    switch (event.type) {
      case 'work-started':
        setWorkStartedAt(event.startedAt)
        void refreshSessions()
        break
      case 'user-question':
      case 'user-question-resolved':
        void refreshSessions()
        break
      case 'turn-start':
        setCurrentFileChanges([])
        // 后台唤醒先进入 work，再在回合起点写稳会话活动时间；这里确认最近顺序。
        void refreshSessions()
        break
      case 'work-finished':
        setWorkStartedAt(null)
        setGitStatusRevision((revision) => revision + 1)
        void refreshSessions()
        break
      case 'work-discarded':
        setWorkStartedAt(null)
        void refreshSessions()
        break
      case 'tool-end':
        setGitStatusRevision((revision) => revision + 1)
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
            ...(event.questionIds ? { questionIds: event.questionIds } : {}),
            ...(event.answerTurnId ? { answerTurnId: event.answerTurnId } : {}),
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
      case 'queued-message-edit-ready': {
        const { item } = event
        if (item.questionIds) void refreshSessions()
        setQueued(previous => previous.filter(message => message.id !== item.id))
        setQueuedActionPending(current => withoutQueuedAction(current, item.id))
        setRestoredQueue(previous => previous.filter(message => message.id !== item.id))
        editRestoredInput(item)
        const owner = runtimeIdRef.current
        requestAnimationFrame(() => { if (runtimeIdRef.current === owner) composerInputRef.current?.focus() })
        break
      }
      case 'message-injected':
      case 'message-dequeued':
        if (event.type === 'message-dequeued') void refreshSessions()
        setQueued((prev) => prev.filter((q) => q.id !== event.id))
        setQueuedActionPending((current) => withoutQueuedAction(current, event.id))
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
    composerSubmissions,
    composerInputRef,
    editRestoredInput,
    refreshSessions,
    showConversationFeedback,
    history.cancel,
  ])

  useEffect(() => {
    if (!runtimeId) return
    const buffered = (backgroundEventsRef.current.get(runtimeId) ?? [])
      .sort((left, right) => left.sequence - right.sequence)
    backgroundEventsRef.current.delete(runtimeId)
    for (const entry of buffered) {
      if (entry.sequence <= activeEventSequenceRef.current) continue
      activeEventSequenceRef.current = entry.sequence
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
    setDeletingSession(state.sessionId, false)
    if (state.status === 'failed') {
      showError(`会话删除未完成：${state.error}`)
    } else if (state.warning) {
      showConversationFeedback('info', `会话已删除；${state.warning}`)
    }
    void refreshSessions()
  }), [refreshSessions, setDeletingSession, showError, showConversationFeedback])

  useEffect(() => {
    if (!rightPanelState.open) setRightPanelFullscreen(false)
    if (!panelFullscreen) return
    const exit = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setRightPanelFullscreen(false)
    }
    window.addEventListener('keydown', exit)
    return () => window.removeEventListener('keydown', exit)
  }, [panelFullscreen, rightPanelState.open])

  const showRightPanelPage = useCallback(async (page: RightPanelPage) => {
    if (page.kind === 'browser') {
      const runtimeId = runtimeIdRef.current
      try { page = await routeBrowserPage(runtimeId, page) }
      catch (error) { showConversationFeedback('error', String(error)); return }
      if (runtimeId !== runtimeIdRef.current) return
    }
    if (page.kind === 'workspace' && !rightPanelStateRef.current.tabs.some(tab => tab.page.kind === 'workspace')) {
      conversationPresentationsRef.current.saveWorkspacePosition(composerKey(runtimeIdRef.current, sessionIdRef.current), undefined)
    }
    const next = openRightPanelPageState(rightPanelStateRef.current, page)
    if (next === rightPanelStateRef.current) { showConversationFeedback('info', '标签页已满，请先关闭部分标签'); return }
    updateRightPanelState(next)
  }, [updateRightPanelState, showConversationFeedback])

  const openCompactionSummary = useCallback((index: number) => {
    void showRightPanelPage({ kind: 'compaction', index })
  }, [showRightPanelPage])

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
    const close = () => updateRightPanelState((current) => closeRightPanelTab(current, tabId))
    if (tab?.page.kind === 'browser') guardBrowserAction(runtimeIdRef.current, tab.page.id, 'close', close, error => showConversationFeedback('error', String(error)))
    else close()
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

  useEffect(() => watchBrowserData(state => {
    if (state.clearing !== 'all') return
    rightPanelSessionStoreRef.current!.removeBrowserTabs()
    const next = closeBrowserTabs(rightPanelStateRef.current)
    rightPanelStateRef.current = next
    setRightPanelState(next)
  }, error => showConversationFeedback('error', String(error), true)), [showConversationFeedback])

  const openRightPanelTerminal = useCallback(async () => {
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId || terminalOpening || !canAddRightPanelTab(rightPanelStateRef.current)) return
    setTerminalOpening(true)
    try {
      await loadTerminalViews()
      if (runtimeIdRef.current !== targetRuntimeId) return
      const terminal = await window.whycode.createTerminal(targetRuntimeId)
      if (runtimeIdRef.current !== targetRuntimeId || !rightPanelStateRef.current.open
        || !canAddRightPanelTab(rightPanelStateRef.current)) {
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
      // 子代理收尾可能晚于父会话终态，会话列表需重新读取宿主的运行状态。
      void refreshSessions()
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
  }, [applySubagentState, refreshSessions])

  useEffect(() => {
    void window.whycode.consensusStatus().then(setConsensus)
    void refreshSessions()
    return window.whycode.onSshChanged(() => { void refreshSessions() })
  }, [refreshSessions])

  useEffect(() => {
    let disposed = false
    let hydrated = false
    let liveEventSequence = -1
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
        if (sequence <= activeEventSequenceRef.current) return
        activeEventSequenceRef.current = sequence
        setComposerSessionId(eventSessionId)
        consumeEvent(event, occurredAt)
      } else if (
        event.type === 'work-started'
        || event.type === 'user-question' || event.type === 'user-question-resolved'
        || (event.type === 'message-queued' && !!event.questionIds) || event.type === 'queued-message-edit-ready' || event.type === 'message-dequeued'
        || event.type === 'work-discarded'
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
      for (const envelope of events) {
        // 通知按实时端口去重；IPC 快照可能先到，不能拿聊天投影的进度过滤通知。
        if (envelope.sequence > liveEventSequence) {
          liveEventSequence = envelope.sequence
          if (hydrated && envelope.event.type === 'work-finished' && envelope.event.outcome === 'completed') {
            void playCompletionSound().catch(error => showConversationFeedback('error', `无法播放提示音：${String(error)}`, true))
          }
        }
        acceptEvent(envelope)
      }
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
    playCompletionSound,
    showConversationFeedback,
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
      followedBottom.current = restoration.position.atBottom ? restoration.position.scrollTop : null
      setShowJumpBottom(!restoration.position.atBottom)
    }
    const target = loaded.targetId
    if (target) scrollToConversation(btwPresentation.navigationTargetIds.get(target) ?? target)
  }, [blocks, releaseConversationScroll, history.completeRender, scrollToConversation, btwPresentation.navigationTargetIds])

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    const contentElement = conversationContentRef.current
    if (resumingSessionId || !scrollElement || !contentElement) return
    // Markdown/公式与离屏段变为真实高度后，贴底语义仍应指向新的真实底部。
    const observer = new ResizeObserver(() => {
      if (pendingScrollRestoreRef.current || followedBottom.current === null) return
      scrollToEnd()
      setShowJumpBottom(false)
    })
    observer.observe(scrollElement)
    observer.observe(contentElement)
    return () => observer.disconnect()
  }, [resumingSessionId, scrollToEnd])

  useEffect(() => {
    if (!resumingSessionId && !pendingScrollRestoreRef.current && followedBottom.current !== null) {
      scrollToEnd()
    }
  }, [blocks, approval, thinkingGapVisible, resumingSessionId, scrollToEnd])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || resumingSessionIdRef.current || pendingScrollRestoreRef.current) return
    const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
    if (followedBottom.current !== null && Math.abs(bottom - followedBottom.current) > 1) {
      scrollToEnd()
      return
    }
    const distance = bottom - el.scrollTop
    const nearBottom = distance < 60
    const following = nearBottom && (!recentlyScrolledAway() || distance <= 1)
    followedBottom.current = following ? bottom : null
    setShowJumpBottom(!following)
    if (!nearBottom && el.scrollTop <= el.clientHeight) void history.loadOlder()
  }, [history.loadOlder, recentlyScrolledAway, scrollToEnd])

  const jumpToBottom = useCallback(() => {
    history.cancel()
    pendingScrollRestoreRef.current = null
    releaseConversationScroll()
    scrollToEnd()
    setShowJumpBottom(false)
  }, [history.cancel, releaseConversationScroll, scrollToEnd])

  const busy = status !== 'idle' && status !== 'error'
  const workActive = busy || workStartedAt !== null
  const deletionBlocksRuntime = sessionIdRef.current !== null
    && deletingSessionIds.has(sessionIdRef.current)
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
    || queueEditPending
    || sessionTransitionPending
    || deletionBlocksRuntime
    || checkpointRestoreToolUseId !== null
  const composerControlsLocked = composerDisabled || submissionPending
  const attachmentLocked = composerControlsLocked || resumingSessionId !== null
  const sessionNavigationLocked = sessionTransitionPending
    || queueEditPending
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
      showError(result.error ?? '新建会话失败')
      return false
    }
    const replacedDraft = result.replacedDraftRuntimeId
    if (replacedDraft) {
      if (replacedDraft === runtimeIdRef.current) await persistComposerRef.current()
      await composerDraftsRef.current.move(composerDraftKey(replacedDraft, null), composerDraftKey(result.snapshot.runtimeId, null))
    }
    await prepareComposer(result.snapshot)
    applyRuntimeSnapshot(result.snapshot)
    if (replacedDraft) void composerDraftsRef.current.delete(composerDraftKey(replacedDraft, null)).catch(draftStorageError)
    void window.whycode.consensusStatus().then(setConsensus)
    void refreshSessions()
    void refreshModelCatalog()
    return true
  }, [showError, applyRuntimeSnapshot, prepareComposer, refreshModelCatalog, refreshSessions, draftStorageError])

  const pickProject = useCallback((projectId?: string) => {
    if (projectId === 'ssh') {
      setSettingsSection('ssh')
      return
    }
    if (!beginSessionTransition()) return
    const project = projects.find(item => item.id === projectId)
    if (project?.remote) {
      void activateNewSession({ mode: 'ssh', target: project.remote.target, selectedDirectory: project.directory })
        .catch(error => showError(String(error))).finally(endSessionTransition)
      return
    }
    void window.whycode.pickProjectDir(projectId).then(async (result) => {
      if (!result.ok) { showError(result.error); return }
      const selectedDirectory = result.value
      if (!selectedDirectory) return
      void refreshSessions()
      await activateNewSession({
        mode: 'local',
        selectedDirectory,
      })
    }).catch((error) => {
      showError(`工作文件夹检查失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(endSessionTransition)
  }, [
    activateNewSession,
    projects,
    showError,
    beginSessionTransition,
    endSessionTransition,
    refreshSessions,
  ])

  const renameProject = useCallback(async (id: string, name: string): Promise<boolean> => {
    try {
      const result = await window.whycode.renameProject(id, name)
      if (!result.ok) { showError(result.error); return false }
      await refreshSessions()
      return true
    } catch (error) {
      showError(`项目重命名失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }, [refreshSessions, showError])

  const removeProject = useCallback((id: string) => {
    void window.whycode.removeProject(id).then(async result => {
      if (!result.ok) { showError(result.error); return }
      await refreshSessions()
      showConversationFeedback('info', '项目已移除，会话和文件已保留')
    }).catch(error => showError(`移除项目失败：${error instanceof Error ? error.message : String(error)}`))
  }, [refreshSessions, showError, showConversationFeedback])

  const toggleConsensus = useCallback(() => {
    const enabled = !consensus.enabled
    void sendRuntimeCommand({ type: 'set-consensus', enabled })
      .then((r) => {
        if (r && r.ok) setConsensus((prev) => ({ ...prev, enabled }))
      })
  }, [consensus.enabled, sendRuntimeCommand])

  const stop = useCallback(() => {
    if (stopping) return
    const targetRuntimeId = runtimeIdRef.current
    composerSubmissions.getSnapshot().get(targetRuntimeId)?.abortController.abort()
    setStopping(true)
    setApproval(null)
    void sendRuntimeCommand({ type: 'abort' }).then((result) => {
      if (result?.ok === false) throw new Error('停止请求未被接受')
    }).catch(() => {
      if (runtimeIdRef.current !== targetRuntimeId) return
      setStopping(false)
      showError('停止请求发送失败，请重试')
    })
  }, [composerSubmissions, showError, sendRuntimeCommand, stopping])

  const startNewSession = useCallback((resetWorkspace = false) => {
    if (!resetWorkspace && runtimeIdRef.current && sessionIdRef.current === null && !resumingSessionIdRef.current) return
    if (!beginSessionTransition()) return
    void activateNewSession(resetWorkspace ? null : undefined)
      .catch((error) => {
        showError(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(endSessionTransition)
  }, [activateNewSession, showError, beginSessionTransition, endSessionTransition])

  const startWorkspaceSession = useCallback(async (workspaceRequest: StartWorkspaceRequest): Promise<boolean> => {
    if (!beginSessionTransition()) return false
    try { return await activateNewSession(workspaceRequest) } catch (error) {
      showError(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally { endSessionTransition() }
  }, [
    showError,
    activateNewSession,
    beginSessionTransition,
    endSessionTransition,
  ])

  const resumeSession = useCallback((sessionId: string) => {
    if (sessionTransitionPendingRef.current) return
    if (!resumingSessionIdRef.current) {
      stashActivePresentation()
      pendingScrollRestoreRef.current = conversationPresentationsRef.current.get(
        composerKey(runtimeIdRef.current, sessionIdRef.current),
      )?.scroll ?? null
    }
    setResumingSessionId(sessionId)
    const presentation = conversationPresentationsRef.current.get(sessionId)
    const historyStart = presentation?.scroll?.atBottom === false ? presentation.historyStart : undefined
    const request = window.whycode.resumeSession(sessionId, historyStart).then(async (result) => {
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
    resumeRequestRef.current = request
  }, [
    showError,
    applyRuntimeSnapshot,
    prepareComposer,
    refreshModelCatalog,
    refreshSessions,
    setResumingSessionId,
    stashActivePresentation,
  ])

  const deleteSession = useCallback(async (sessionId: string, options: DeleteSessionOptions): Promise<DeleteSessionResult | null> => {
    const pendingNavigation = () => [resumeRequestRef.current, sessionTransitionPendingRef.current?.promise].filter(Boolean)
    if (
      deletingSessionIdsRef.current.has(sessionId)
      || resumingSessionIdRef.current
      || sessionTransitionPendingRef.current
    ) return null
    setDeletingSession(sessionId, true)
    if (isCurrentSessionDeletion(sessionIdRef.current, sessionId)) history.cancel()
    let cleanupPending = false
    try {
      const result = await window.whycode.deleteSession(sessionId, options)
      cleanupPending = result.ok && result.cleanupPending
      // 先让用户已发起的导航落定；失败时仍可切离已经删除的会话。
      for (let pending = pendingNavigation(); pending.length; pending = pendingNavigation()) {
        await Promise.allSettled(pending)
      }
      const stillViewingTarget = () => sessionIdRef.current === sessionId
        && !resumingSessionIdRef.current && !sessionTransitionPendingRef.current
      if (result.deletedCurrent && result.snapshot && stillViewingTarget()) {
        await prepareComposer(result.snapshot)
        // 清理可能持续数秒，完成时只替换仍停留在删除目标上的视图。
        if (stillViewingTarget()) {
          applyRuntimeSnapshot(result.snapshot)
          void window.whycode.consensusStatus().then(setConsensus)
        }
      }
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
      if (!result.ok) showConversationFeedback('error', result.error, true)
      return result
    } catch {
      showConversationFeedback('error', '删除会话失败，请重试', true)
      return null
    } finally {
      if (!cleanupPending) setDeletingSession(sessionId, false)
      void refreshSessions()
    }
  }, [
    applyRuntimeSnapshot,
    prepareComposer,
    draftStorageError,
    refreshSessions,
    history.cancel,
    setDeletingSession,
    showConversationFeedback,
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

  const renameSession = useCallback(async (sessionId: string, value: string): Promise<boolean> => {
    try {
      const name = normalizeSessionName(value)
      const result = await window.whycode.renameSession({ sessionId, name })
      if (!result.ok) throw new Error(result.error)
      await refreshSessions()
      return true
    } catch (error) {
      showError(`重命名失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }, [refreshSessions, showError])

  const compact = useCallback(() => {
    if (status !== 'idle' && status !== 'error') return
    if (sshSendUnavailableReason) { showError(sshSendUnavailableReason); return }
    const owner = runtimeIdRef.current
    void sendRuntimeCommand({ type: 'compact' }).then(result => {
      if (owner === runtimeIdRef.current && result?.error) showError(result.error)
    }).catch(error => {
      if (owner === runtimeIdRef.current) showError(error instanceof Error ? error.message : String(error))
    })
  }, [sendRuntimeCommand, showError, sshSendUnavailableReason, status])
  const forkConversation = useCallback((sourceTurnId: string) => {
    if (status !== 'idle' && status !== 'error') return
    const sourceSessionId = sessionIdRef.current
    if (!sourceSessionId || !beginSessionTransition('fork')) return
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
    }).finally(endSessionTransition)
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
    const targetRuntimeId = runtimeIdRef.current
    const previous = modelId
    const previousReasoningEffort = reasoningEffort
    setModelId(next)
    setReasoningEffort('default')
    const rollback = () => {
      if (runtimeIdRef.current !== targetRuntimeId) return
      setModelId((current) => current === next ? previous : current)
      setReasoningEffort((current) =>
        current === 'default' ? previousReasoningEffort : current,
      )
    }
    void sendRuntimeCommand({ type: 'set-model', modelId: next }).then((result) => {
      if (!result || !result.ok) {
        rollback()
        if (result?.error && runtimeIdRef.current === targetRuntimeId) showError(result.error)
      }
    }).catch((error: unknown) => {
      rollback()
      if (runtimeIdRef.current === targetRuntimeId) {
        showError(error instanceof Error ? error.message : String(error))
      }
    })
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
    setSettingsSection('general')
  }, [])

  const openCurrentWorkspaceFolder = useCallback(() => {
    const targetRuntimeId = runtimeIdRef.current
    if (!targetRuntimeId) return
    if (workspace.mode === 'ssh') {
      const page = rightPanelStateRef.current.tabs.find(tab => tab.page.kind === 'workspace')?.page
      showRightPanelPage(page ?? { kind: 'workspace', expanded: [] })
      return
    }
    void window.whycode.openWorkspaceFolder(targetRuntimeId).then((result) => {
      if (!result.ok) showError(result.error)
    }).catch((error) => {
      showError(`打开工作文件夹失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [showError, workspace.mode, showRightPanelPage])

  const connectionSettingsChanged = useCallback(() => {
    void window.whycode.consensusStatus().then(setConsensus)
    void refreshModelCatalog()
  }, [refreshModelCatalog])

  const selectedModel = models.find((model) => model.id === modelId)
  const modelUnavailableReason = selectedModel?.available
    ? null
    : selectedModel?.unavailableReason ?? '当前没有可用模型'

  const send = useCallback((urgent = false) => {
    if (
      stopping
      || sessionTransitionPending
      || deletionBlocksRuntime
      || resumingSessionId
      || checkpointRestoreToolUseId
      || submissionPending
      || queueEditPending
    ) return
    if (sshSendUnavailableReason) { showError(sshSendUnavailableReason); return }
    if (modelUnavailableReason) { showError(modelUnavailableReason); return }
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
    const body = input.getSnapshot().trim()
      || attachmentFallbackText(imageDrafts.length, sentBtwMode ? 0 : pdfDrafts.length)
      || (imageDrafts.length === 0 && sentSkills.length ? '请按所选 Skill 执行。' : '')
    const sentReferences = codeReferences.getSnapshot()
    const text = codeReferenceMessage(body, sentReferences)
    if (!text && imageDrafts.length === 0) return
    const sentImageDrafts = detachImageDrafts()
    const sentPdfDrafts = detachPdfDrafts()
    const sentRestoredInputIds = restoredInputIds
    const submission: ComposerSubmission = {
      runtimeId: targetRuntimeId,
      sessionId: sessionIdRef.current,
      workActiveAtSubmit: workActive,
      previousInputIds: composerInputIds(blocks, [...queued, ...restoredQueue]),
      abortController: new AbortController(),
      draft: {
        question: questionInput.getSnapshot(), text: body, images: sentImageDrafts, pdfs: sentPdfDrafts, skills: sentSkills, codeReferences: sentReferences,
        btwMode: sentBtwMode, restoredInputIds: sentRestoredInputIds,
      },
      ...(!conversationStarted && workspace.mode === 'pending-worktree'
        ? { worktreeBaseRef: workspace.baseRef } : {}),
    }
    composerSubmissions.start(submission)
    codeReferences.replace([])
    setRestoredInputIds([])
    setInput('')
    clearSkills()
    setBtwMode(null)
    // 沿用发送前的浏览位置；只有原本贴底时，既有内容跟随才会继续滚动。
    const restoreRejectedInput = () => {
      setInput((current) => body && current ? `${body}\n${current}` : body || current)
      codeReferences.replace([...sentReferences, ...codeReferences.getSnapshot()])
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
      const { signal } = submission.abortController
      try {
        await composerDraftsRef.current.save(
          composerDraftKey(targetRuntimeId, submission.sessionId), submission.draft,
        )
        signal.throwIfAborted()
        const attachments = await prepareImageDrafts(sentImageDrafts, signal)
        signal.throwIfAborted()
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
        if (result?.ok || submission.receivedInputId) {
          accepted = true
        }
      } catch {
        accepted = Boolean(submission.receivedInputId)
        if (!accepted && !signal.aborted && runtimeIdRef.current === targetRuntimeId) {
          showError(sentImageDrafts.length || sentPdfDrafts.length
            ? '附件读取或消息发送失败，内容已恢复到输入框'
            : '消息发送失败，内容已恢复到输入框')
        }
      } finally {
        // IPC 确认与事件端口独立到达；首次提交须先取得正式身份，再移交后台草稿。
        if (submission.sessionId === null || (accepted && !submission.receivedInputId)) {
          try {
            const snapshot = await window.whycode.runtimeSnapshot(targetRuntimeId)
            await bindComposerSession(targetRuntimeId, snapshot.sessionId)
            const needsTimeline = accepted && !submission.receivedInputId
            composerSubmissions.receiveSnapshot(targetRuntimeId, snapshot.history.view.blocks, snapshot.queuedInputs)
            if (runtimeIdRef.current === targetRuntimeId) {
              sessionIdRef.current = snapshot.sessionId
              // 确认先于事件到达时，以宿主快照接替预览，不能先清掉气泡再等待事件。
              if (needsTimeline && !resumingSessionIdRef.current && !sessionTransitionPendingRef.current
                && snapshot.eventSequence >= activeEventSequenceRef.current) applyRuntimeSnapshot(snapshot)
            }
          } catch (error) {
            draftStorageError(error)
          }
        }
        // 先完成所属运行时的内存移交，再等待磁盘；切回时不会再次合并已经恢复的输入。
        let saved: Promise<void> | undefined
        try {
          if (accepted) releaseImageDrafts(sentImageDrafts)
          if (runtimeIdRef.current === targetRuntimeId) {
            if (!accepted) {
              restoreRejectedInput()
              if (signal.aborted) setStopping(false)
            }
          } else {
            const key = composerDraftKey(targetRuntimeId, submission.sessionId)
            const draft = accepted
              ? submission.remainder ?? { text: '', images: [], pdfs: [], skills: [], btwMode: null, restoredInputIds: [] }
              : prependComposerDraft(submission.draft, submission.remainder)
            composerDraftsRef.current.cache(key, draft)
            saved = composerDraftsRef.current.save(key, draft)
            if (!accepted && !signal.aborted) showError('消息未能发送，内容已恢复到原会话的输入框')
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
    queueEditPending,
    sshSendUnavailableReason,
    modelUnavailableReason,
    applyRuntimeSnapshot,
    bindComposerSession,
    blocks,
    queued,
    restoredQueue,
    composerSubmissions,
    draftStorageError,
    captureSkills,
    checkpointRestoreToolUseId,
    codeReferences,
    clearSkills,
    conversationStarted,
    deletionBlocksRuntime,
    detachImageDrafts,
    detachPdfDrafts,
    imageDrafts.length,
    input,
    setInput,
    mergeRestoredSkills,
    pdfDrafts.length,
    restoredInputIds,
    restoreImageDrafts,
    restorePdfDrafts,
    resumingSessionId,
    sessionTransitionPending,
    stopping,
    setBtwMode,
    workActive,
    workspace,
  ])

  useEffect(() => {
    if (loadingConversation || runtimeId !== runtimeIdRef.current) return
    const current = questionInput.getSnapshot()
    const next = reconcileQuestionDraft(current, view.pendingQuestions)
    if (next !== current) questionInput.replace(next)
  }, [loadingConversation, runtimeId, view.pendingQuestions, questionInput])

  const answerableQuestions = useMemo(() => {
    const reserved = new Set(queued.flatMap(item => item.questionIds ?? []))
    return reserved.size ? view.pendingQuestions.filter(item => !reserved.has(item.id)) : view.pendingQuestions
  }, [queued, view.pendingQuestions])

  const answerQuestion = useCallback(async (resolutions: QuestionSubmission) => {
    if (resolutions.some(item => item.answer !== null) && sshSendUnavailableReason) { showError(sshSendUnavailableReason); return }
    const owner = runtimeIdRef.current
    try {
      const result = await sendRuntimeCommand({ type: 'resolve-user-question', resolutions })
      if (!result?.ok) throw new Error(result?.error ?? '问题处理失败，请重试')
    } catch (error) {
      if (runtimeIdRef.current === owner) showError(error instanceof Error ? error.message : String(error))
    }
  }, [sendRuntimeCommand, showError, sshSendUnavailableReason])

  const editUserMessage = useCallback(async (
    block: Extract<Block, { kind: 'user' }>,
    text: string,
    restoreFiles: boolean,
  ) => {
    if (interactionBusy || stopping) return false
    if (sshSendUnavailableReason) throw new Error(sshSendUnavailableReason)
    const target = block.btw && block.inputId
      ? { kind: 'btw' as const, inputId: block.inputId }
      : block.turnId
        ? { kind: 'main' as const, turnId: block.turnId, restoreFiles }
        : null
    if (!target) return false
    scrollToEnd()
    setShowJumpBottom(false)
    const result = await sendRuntimeCommand({ type: 'edit-user-message', target, text })
    if (!result?.ok) throw new Error(result?.error ?? '重新发送失败，请重试')
    return true
  }, [interactionBusy, scrollToEnd, sendRuntimeCommand, sshSendUnavailableReason, stopping])

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

  const changeQueuedMessagesCollapsed = useCallback((collapsed: boolean) => {
    const key = composerKey(runtimeIdRef.current, sessionIdRef.current)
    conversationPresentationsRef.current.setQueuedMessagesCollapsed(key, collapsed)
    setQueuedMessagesCollapsed(collapsed)
  }, [])

  const modelNeedsRefresh = Boolean(selectedModel?.hasKey && !selectedModel.available && !selectedModel.retired)
  useEffect(() => {
    if (!modelNeedsRefresh) return
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      // 代理启动时可能先返回部分目录；可用后由依赖变化撤销重查。
      void refreshModelCatalog()
    }
    const timer = window.setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [modelNeedsRefresh, refreshModelCatalog])
  const canAttachImages = Boolean(
    selectedModel?.available
      && (btwMode ? selectedModel.imageInputMode === 'native' : selectedModel.imageInputMode !== 'none'),
  )
  const canAttachPdfs = Boolean(selectedModel?.available && !btwMode)
  const pasteAttachments = useCallback((event: ClipboardEvent) => {
    if (!event.clipboardData) return
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
    || (blocks.length > 0 ? '未命名会话' : '新会话')
  const sendDisabled = composerControlsLocked || messageEmpty || Boolean(sshSendUnavailableReason)
  const primaryAction = composerPrimaryAction({
    busy: workActive,
    submissionPending,
    hasDraft: !messageEmpty,
  })
  const contextBaseRef = workspace.mode === 'pending-worktree'
    ? workspace.baseRef
    : workspace.mode === 'worktree'
      ? workspace.baseRef
      : null

  const pendingSession = sessions.find((session) => session.sessionId === resumingSessionId)
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
        codeReferences: pendingDraft?.codeReferences,
        btwMode: pendingDraft?.btwMode ?? null,
      }
    : { images: imageDrafts, pdfs: pdfDrafts, skills: selectedSkills, codeReferences: codeItems, btwMode }

  const sshTarget = workspace.mode === 'ssh' ? workspace.target : undefined
  const codeReview = useMemo<Omit<CodeReview, 'version'> | null>(() => projectDir ? {
    workspace: projectDir, sshTarget, items: codeItems, disabled: attachmentLocked,
    add(reference) {
      if (runtimeIdRef.current !== runtimeId || attachmentLocked) return false
      if (!codeReferences.add(reference)) {
        showError('代码引用空间已满，请缩小选区或移除已有引用。')
        return false
      }
      if (!reference.comment) {
        if (panelFullscreen) {
          setRightPanelFullscreen(false)
          requestAnimationFrame(() => { if (runtimeId === runtimeIdRef.current) composerInputRef.current?.focus() })
        } else composerInputRef.current?.focus()
      }
      return true
    },
    remove: codeReferences.remove,
  } : null, [projectDir, sshTarget, codeItems, attachmentLocked, runtimeId, codeReferences, showError, panelFullscreen])

  const panelSessionKey = composerKey(runtimeId, sessionIdRef.current)
  const markdownViewOwner = useMemo(() => ({
    key: panelSessionKey,
    cache: conversationPresentationsRef.current,
  }), [panelSessionKey])
  return (
    <ConversationFeedbackContext value={showConversationFeedback}>
    <div
      ref={panelLayout.rootRef}
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
          layout={panelLayout}
          collapsed={sidebarCollapsed}
          sessions={sessions}
          projects={projects}
          onSelectProject={pickProject}
          onRenameProject={renameProject}
          onRemoveProject={removeProject}
          selectedSessionId={resumingSessionId ?? sessionIdRef.current}
          navigationLocked={sessionNavigationLocked}
          error={sessionListError}
          busy={sessionChangeLocked}
          deletingSessionIds={deletingSessionIds}
          onCollapsedChange={setSidebarCollapsed}
          onNewSession={() => startNewSession()}
          onResume={resumeSession}
          onPinnedChange={setSessionPinned}
          onRename={renameSession}
          onDelete={deleteSession}
          onError={showError}
          onOpenSettings={openConnectionSettings}
        />
      </div>

      <section className="wc-shell-panel flex min-w-0 flex-1 flex-col bg-[var(--wc-surface)]">
        <div className="contents" inert={panelFullscreen}>
          <TaskHeader
            workspaceLabel={workspace.mode === 'ssh' ? workspace.label : undefined}
            ssh={workspace.mode === 'ssh' ? { target: workspace.target, ...sshConnection } : undefined}
            sessionId={loadingConversation ? resumingSessionId : sessionIdRef.current}
            onRename={renameSession}
            title={loadingConversation ? pendingSession?.title || '未命名会话' : taskTitle}
            projectDir={loadingConversation
              ? pendingSession?.workspace ? workspaceDisplayDirectory(pendingSession.workspace) : null
              : workspace.mode === 'pending-managed' ? null : projectDir}
            workspaceMode={loadingConversation ? pendingSession?.workspace?.mode ?? 'pending-managed' : workspace.mode}
            backgroundTasks={loadingConversation ? [] : backgroundTasks}
            onStopBackgroundTask={stopBackgroundTask}
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
          <section className="wc-conversation relative flex min-w-0 flex-1 flex-col" inert={panelFullscreen}
            style={{ '--wc-content-font-size': `${conversationFontSize}px` } as CSSProperties}>
            {(!loadingConversation || showConnectionSettings) && conversationFeedback && (
              <ConversationFeedbackToast
                key={conversationFeedback.id}
                feedback={conversationFeedback}
                floating={conversationFeedback.floating || showConnectionSettings || panelFullscreen}
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
                  className="wc-conversation-content wc-conversation-balanced-content mx-auto w-full max-w-4xl"
                >
                  {!loadingConversation && !conversationStarted && !pendingMessage && (
                    <div className="mx-auto mt-[18vh] max-w-md text-center">
                      <h2 className="text-lg font-semibold tracking-tight">想一起做点什么？</h2>
                      <p className="mt-1.5 text-sm leading-6 text-[var(--wc-muted)]">
                        {explicitProjectSelected
                          ? '描述目标，WhyCode 会在当前工作区中读取、修改和验证。'
                          : '先选择一个项目，或直接在默认工作区中开始。'}
                      </p>
                    </div>
                  )}
                  <MarkdownNavigation baseDir={projectDir} onOpenFile={openFilePreview}>
                    <ConversationView
                      remote={workspace.mode === 'ssh'}
                      runtimeId={runtimeId}
                      markdownViewOwner={markdownViewOwner}
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
                      forkSourceTurnId={forkOrigin?.sourceTurnId ?? null}
                      skills={skillCatalog.skills}
                      projectDir={projectDir}
                      onCheckpointRestoreRequest={requestCheckpointRestore}
                      onNavigate={navigateConversation}
                      onEdit={editUserMessage}
                      onFork={forkConversation}
                      onOpenFilePreview={openFilePreview}
                      onOpenChanges={showRightPanelPage}
                      onOpenCompaction={openCompactionSummary}
                      onToggle={toggle}
                    >
                      {presentedInputs.answers.map(answer => <PendingUserMessage key={answer.id} answer={answer.text} />)}
                      {pendingMessage && <PendingUserMessage draft={pendingMessage} />}
                      {!conversationStarted && pendingMessage && worktreePreparation && (
                        <WorktreePreparation baseRef={worktreePreparation.baseRef} />
                      )}
                      {thinkingGapVisible && <ThinkingGapIndicator />}
                    </ConversationView>
                  </MarkdownNavigation>
                </div>
              </main>
            </div>

            <div className="relative shrink-0 px-4 pb-4 pt-1">
              <div className="wc-conversation-balanced-content relative mx-auto w-full max-w-4xl">
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

                  {(presentedInputs.queue.length > 0 || pendingQueuedMessage) && (
                    <QueuedMessageList
                      key={runtimeId}
                      messages={presentedInputs.queue}
                      submitting={pendingQueuedMessage}
                      collapsed={queuedMessagesCollapsed}
                      onCollapsedChange={changeQueuedMessagesCollapsed}
                      confirmOverwrite={hasComposerDraft}
                      editDisabled={attachmentLocked}
                      pendingActions={queuedActionPending}
                      onAction={actOnQueuedMessage}
                    />
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
                    {!questionCollapsed && answerableQuestions.length > 0 && <QuestionCard key={runtimeId}
                      questions={answerableQuestions} input={questionInput} disabled={composerControlsLocked}
                      onResolve={answerQuestion}
                      stopControl={workActive && <ComposerActionButton runtimeId={runtimeId} workStartedAt={workStartedAt}
                        primaryAction="stop" runningSubagentCount={subagents.filter(item => isSubagentRunning(item.status)).length}
                        stopping={stopping} stopDisabled={composerDisabled} sendDisabled={false} onSend={() => send(false)} onStop={stop} />} />}
                  </div>
                  <div hidden={!loadingConversation && answerableQuestions.length > 0 && !questionCollapsed}>
                    {showMcpStatus && !skillTrigger && !attachmentLocked && (
                      <ComposerMcpStatus
                        key={`mcp:${runtimeId}`}
                        runtimeId={runtimeId}
                        composerRef={composerInputRef}
                        onClose={() => setShowMcpStatus(false)}
                      />
                    )}
                    {skillTrigger && !attachmentLocked && (
                      <ComposerSlashMenu
                        id={composerMenuId}
                        items={composerMenuItems}
                        activeIndex={Math.min(skillActiveIndex, Math.max(0, composerMenuItems.length - 1))}
                        diagnostics={skillCatalog.diagnostics}
                        loading={skillCatalogLoading}
                        limitReached={skillLimitReached}
                        onSelect={selectComposerMenuItem}
                        onActivate={setSkillActiveIndex}
                      />
                    )}

                    {!loadingConversation && !conversationStarted && !submissionPending && (
                      <WorkspaceContextBar
                        key={`workspace:${runtimeId}`}
                        runtimeId={runtimeId}
                        projects={projects}
                        workspace={workspace}
                        projectDir={projectDir}
                        baseRef={contextBaseRef}
                        busy={sessionChangeLocked}
                        canChangeWorkspace={canChangeSessionWorkspace(sessionIdRef.current)}
                        onPickProject={pickProject}
                        onClearProject={() => startNewSession(true)}
                        onStart={startWorkspaceSession}
                      />
                    )}

                    <ImageDraftStrip drafts={composerDraft.images} onRemove={removeImageDraft} onEditReference={id => {
                      const draft = imageDrafts.find(item => item.id === id)
                      if (!draft?.source || composerDisabled || resumingSessionId !== null || !canAttachImages) return
                      try {
                        showRightPanelPage(browserReferencePage(rightPanelStateRef.current, draft.source.page.url,
                          !!draft.source.page.file?.remote, { kind: 'edit', draftId: id }, draft.browserId, workspace.mode === 'ssh'))
                      } catch (error) { showError(String(error)) }
                    }} />
                    <div className="wc-composer-chips">
                      <CodeReferenceChips items={composerDraft.codeReferences} onRemove={attachmentLocked ? undefined : codeReferences.remove} />
                      {!loadingConversation && questionCollapsed && answerableQuestions.length > 0 && <button type="button" className="wc-question-summary wc-focus-ring"
                        onClick={() => {
                          const draft = questionInput.getSnapshot()
                          if (draft) questionInput.replace({ ...draft, collapsed: false })
                        }}>
                        <MessageCircleQuestionMark size={14} />{answerableQuestions.length} 个待答问题
                      </button>}
                      <PdfDraftStrip drafts={composerDraft.pdfs} onRemove={removePdfDraft} />
                      <SkillChips skills={composerDraft.skills} disabled={composerControlsLocked} onRemove={removeSelectedSkill} />
                    </div>

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

                    <ComposerInput
                      ref={composerInputRef}
                      aria-controls={skillTrigger && !attachmentLocked ? composerMenuId : undefined}
                      aria-activedescendant={skillTrigger && !attachmentLocked ? composerActiveOptionId : undefined}
                      scopeKey={resumingSessionId ?? `${runtimeId}:${restoredInputIds.join(',')}`}
                      runtimeId={runtimeId}
                      className="wc-composer-text wc-scrollbar max-h-40 w-full overflow-y-auto bg-transparent px-1.5 py-1 text-[var(--wc-ink)] caret-[var(--wc-ink)] outline-none"
                      text={input}
                      previewText={loadingConversation ? composerDraft.text : undefined}
                      onChange={(text, cursor) => {
                        setShowMcpStatus(false)
                        updateSkillMenu(text, cursor)
                      }}
                      onSelect={cursor => updateSkillMenu(input.getSnapshot(), cursor)}
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
                          isComposing: event.isComposing,
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
                      runtimeId={runtimeId}
                      workStartedAt={workStartedAt}
                      runningSubagentCount={subagents.filter((subagent) => isSubagentRunning(subagent.status)).length}
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
                      sendUnavailableReason={sshSendUnavailableReason ?? undefined}
                      sendPendingLabel={sshConnecting ? '连接中' : undefined}
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
            ref={panelLayout.refs.right}
            data-fullscreen={panelFullscreen}
            data-panel-open={rightPanelState.open ? 'true' : 'false'}
            aria-busy={loadingConversation}
            inert={loadingConversation}
            className="wc-resizable-panel wc-right-panel-shell relative h-full shrink-0 overflow-clip bg-[var(--wc-surface)] transition-[width,margin-left] duration-[var(--wc-motion-layout)] ease-out"
            style={{
              width: rightPanelState.open
                ? panelWidthExpression('right', panelLayout.widths.right)
                : undefined,
            }}
          >
            {!panelFullscreen && (rightPanelState.open || rightPanelResizeActive) && (
              <PanelResizeHandle
                side="right"
                layout={panelLayout}
                onResizeActiveChange={setRightPanelResizeActive}
              />
            )}
            <div
              className={`absolute inset-y-0 left-0 w-[348px] transition-[opacity,transform] duration-[var(--wc-motion-layout)] ease-out ${
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
                view={committedRightPanelState.inspectorView}
                onViewChange={(inspectorView) => updateRightPanelState((current) => ({
                  ...current, inspectorView,
                }))}
                subagents={subagents}
                busy={interactionBusy}
                gitData={gitData}
                conversationStarted={conversationStarted}
                onOpenGit={() => showRightPanelPage(gitOverviewPage(gitPage?.kind === 'git' ? gitPage : defaultGitPage(), gitData.snapshot?.repository))}
                onOpenSubagents={() => {
                  showRightPanelPage({ kind: 'subagent-overview' })
                }}
              />
            </div>
            <div
              className={`absolute inset-y-0 right-0 w-full transition-[opacity,transform] duration-[var(--wc-motion-layout)] ease-out ${
                rightPanelState.open
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none translate-x-8 opacity-0'
              }`}
              aria-hidden={!rightPanelState.open}
              inert={!rightPanelState.open}

            >
              <RightPanel
                codeReview={codeReview}
                gitData={gitData}
                gitRevision={gitRevision}
                busy={interactionBusy}
                remote={workspace.mode === 'ssh'}
                active={rightPanelState.open}
                loading={loadingConversation}
                runtimeId={loadingConversation ? '' : runtimeId}
                refreshRevision={`${view.fileSystemRevision}:${filePreviewInteractionRevision}`}
                parentSessionId={loadingConversation ? resumingSessionId : sessionIdRef.current}
                subagents={loadingConversation ? [] : subagents}
                conversationFontSize={conversationFontSize}
                skills={skillCatalog.skills}
                projectDir={projectDir}
                state={rightPanelState}
                workspacePath={workspaceDisplayDirectory(workspace)}
                fullscreen={panelFullscreen}
                onToggleFullscreen={() => setRightPanelFullscreen(value => !value)}
                onCollapse={() => changePanelOpen('right', false)}
                onOpenPage={showRightPanelPage}
                onUpdatePage={changeRightPanelPage}
                onRegisterBrowserPage={(owner, sessionId, page) => {
                  if (owner === runtimeIdRef.current) updateRightPanelState(current => registerBrowserPage(current, page))
                  else {
                    const store = rightPanelSessionStoreRef.current!
                    const key = rightPanelSessionKey(owner, sessionId)
                    const current = store.get(key), next = registerBrowserPage(current, page)
                    if (next !== current) store.set(key, next)
                  }
                }}
                onSelectTab={selectRightPanelTab}
                onCloseTab={closeRightPanelPage}
                onMoveTab={(id, targetId) => updateRightPanelState(current => moveRightPanelTab(current, id, targetId))}
                terminalOpening={terminalOpening}
                onOpenTerminal={() => { void openRightPanelTerminal() }}
                canReferencePath={!composerDisabled && resumingSessionId === null}
                canReferenceBrowser={!composerDisabled && resumingSessionId === null && canAttachImages}
                referenceDrafts={imageDrafts}
                onReferenceBrowser={(owner, image, replaceId) => {
                  if (owner !== runtimeIdRef.current || composerDisabled || resumingSessionId !== null || !canAttachImages) return false
                  const added = addBrowserReference(image, replaceId)
                  if (added && panelFullscreen) setRightPanelFullscreen(false)
                  return added
                }}
                onReferencePath={(owner, reference) => {
                  if (owner === runtimeIdRef.current && !composerDisabled && resumingSessionId === null) {
                    if (panelFullscreen) setRightPanelFullscreen(false)
                    composerInputRef.current?.appendReference(reference)
                    if (panelFullscreen) requestAnimationFrame(() => {
                      if (owner === runtimeIdRef.current) composerInputRef.current?.focus()
                    })
                  }
                }}
                workspacePosition={conversationPresentationsRef.current.get(panelSessionKey)?.workspacePosition}
                onWorkspacePositionChange={position => {
                  const owner = rightPanelSessionStoreRef.current!.get(panelSessionKey)
                  if (owner.tabs.some(tab => tab.page.kind === 'workspace')) {
                    conversationPresentationsRef.current.saveWorkspacePosition(panelSessionKey, position)
                  }
                }}
              />
            </div>
          </div>
        </div>
      </section>

      {sessionTransition === 'fork' && <ForkProgressDialog />}
      {settingsSection !== null && (
        <ConnectionSettingsPanel
          initialSection={settingsSection}
          onStartSession={startWorkspaceSession}
          workspaceCleanup={workspaceCleanup}
          conversationFontSize={conversationFontSize}
          onConversationFontSizeChange={setConversationFontSize}
          completionSound={{ enabled: completionSoundEnabled, setEnabled: setCompletionSoundEnabled,
            preview: () => { void playCompletionSound(true).catch(error => showConversationFeedback('error', `无法播放提示音：${String(error)}`, true)) } }}
          onClose={() => { setSettingsSection(null); void refreshSessions() }}
          onChanged={connectionSettingsChanged}
          onError={showError}
        />
      )}
    </div>
    </ConversationFeedbackContext>
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

function sameSidebarItems(
  current: readonly unknown[],
  next: readonly unknown[],
): boolean {
  if (current.length !== next.length) return false
  return current.every((item, index) => JSON.stringify(item) === JSON.stringify(next[index]))
}
