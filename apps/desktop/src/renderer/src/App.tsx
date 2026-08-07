import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'
// 注意：Renderer 只能从浏览器安全的子路径导入运行时值；从 '@whycode/core' 根导入值会把
// Node 内置模块拖进渲染端导致白屏（types 导入不受此限）
import type { PermissionMode } from '@whycode/core/permissions'
import type { SkillSummary } from '@whycode/core/skills'
import type {
  CoreCommand,
  ReasoningEffortSelection,
} from '@whycode/core'
import {
  formatUserQuestionAnswer,
  type AgentStatus,
  type CoreEvent,
  type QueuedUserMessage,
} from '@whycode/core/events'
import type { RuntimeSnapshot, SessionListItem } from '../../shared/session.ts'
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
  eventsAfterRuntimeSnapshot,
  resumeTargetCommitted,
  toggleExpanded,
  voteLabel,
} from './conversation-state.ts'
import { isCurrentSessionDeletion } from './session-deletion-state.ts'
import { QuestionCard } from './question-card.tsx'
import { ProcessingTime } from './processing-time.ts'
import { ConversationView } from './conversation-view.tsx'
import {
  conversationSections,
  shouldShowComposerProcessingTime,
} from './conversation-sections.ts'
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
import { composerKeyAction } from './composer-key.ts'
import type { WorkspaceStartChoice } from './workspace-start-controls.tsx'
import { WorkspaceContextBar } from './workspace-context-bar.tsx'
import { SkillBadges, SkillChips, ComposerSlashMenu } from './skill-picker.tsx'
import { useSkillComposer } from './use-skill-composer.ts'
import type { ComposerCommandId } from './skill-trigger.ts'
import { AppSidebar } from './app-sidebar.tsx'
import { TaskHeader } from './task-header.tsx'
import { ComposerToolbar } from './composer-toolbar.tsx'
import { TaskInspector } from './task-inspector.tsx'
import { ApprovalCard, type Approval } from './approval-card.tsx'
import { PaperFrame } from './paper-frame.tsx'
import { installPaperHoverTracking } from './paper-hover-tracking.ts'

export function App() {
  const [runtimeId, setRuntimeId] = useState('')
  const [view, setView] = useState(() => createConversationState())
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [workStartedAt, setWorkStartedAt] = useState<number | null>(null)
  const [stopping, setStopping] = useState(false)
  const [sessionTransitionPending, setSessionTransitionPending] = useState(false)
  const [questionSubmitting, setQuestionSubmitting] = useState(false)
  const [attachmentSubmissionPending, setAttachmentSubmissionPending] = useState(false)
  const [models, setModels] = useState<ModelListItem[]>([])
  const [modelId, setModelId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortSelection>('default')
  const [showConnectionSettings, setShowConnectionSettings] = useState(false)
  const [connectionSettings, setConnectionSettings] =
    useState<ConnectionSettingsSnapshot | null>(null)
  const [approval, setApproval] = useState<Approval | null>(null)
  const [workspace, setWorkspace] = useState<RuntimeWorkspace>({ mode: 'none' })
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
  /** 协商进行中的状态条文案（null = 无协商） */
  const [negoStatus, setNegoStatus] = useState<string | null>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const questionSubmittingRef = useRef(false)
  const sessionTransitionPendingRef = useRef(false)
  const resumingSessionIdRef = useRef<string | null>(null)
  const ownsResumeRequestRef = useRef(false)
  const deletionBlocksRuntimeRef = useRef(false)
  const runtimeIdRef = useRef('')
  const sessionIdRef = useRef<string | null>(null)
  const activeSnapshotSequenceRef = useRef(0)
  const hydratingRuntimeIdRef = useRef<string | null>(null)
  const backgroundEventsRef = useRef(new Map<string, {
    event: CoreEvent
    sequence: number
    sessionId: string | null
  }[]>())
  const composerDraftsRef = useRef(new Map<string, {
    text: string
    images: ImageDraft[]
    pdfs: PdfDraft[]
    skills: SkillSummary[]
  }>())
  /** 贴底跟随：仅当用户本就在底部附近才自动滚动；往上翻阅时不打扰 */
  const stickToBottom = useRef(true)
  const [showJumpBottom, setShowJumpBottom] = useState(false)
  const inputRef = useRef('')
  const slashCommandRef = useRef<(command: ComposerCommandId) => void>(() => {})
  const blocks = view.blocks
  const projectDir = workspaceDisplayDirectory(workspace)
  const explicitProjectSelected = workspace.mode !== 'pending-managed' && Boolean(projectDir)
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
    compactDisabled: status !== 'idle'
      && status !== 'error',
    onCommand: (command) => slashCommandRef.current(command),
  })
  const sections = conversationSections(blocks, workStartedAt)
  const conversationStarted = blocks.some((block) => block.kind === 'user')
  const checkpointRestoreAnchors = checkpointRestoreAnchorIds(view)
  const composerProcessingTimeVisible =
    shouldShowComposerProcessingTime(workStartedAt, sections)
  const addError = useCallback((text: string) => {
    setView((previous) =>
      applyCoreEvent(previous, { type: 'error', message: text, recoverable: true }),
    )
  }, [])
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

  useEffect(() => installPaperHoverTracking(document), [])

  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => () => {
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
    // 尚未产生 JSONL 的空白页没有历史入口，切走后不能再导航回来。
    if (!currentSessionId) {
      releaseImageDrafts(images)
      return
    }
    const key = composerKey(currentRuntimeId, currentSessionId)
    if (text || images.length > 0 || pdfs.length > 0 || skills.length > 0) {
      composerDraftsRef.current.set(key, { text, images, pdfs, skills })
    } else {
      composerDraftsRef.current.delete(key)
    }
  }, [captureSkills, detachImageDrafts, detachPdfDrafts])

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
  }, [clearImageDrafts, clearPdfDrafts, clearSkills])

  const setResumingSessionId = useCallback((sessionId: string | null) => {
    resumingSessionIdRef.current = sessionId
    setResumingSessionIdState(sessionId)
  }, [])

  const setDeletionBlocksRuntime = useCallback((blocked: boolean) => {
    deletionBlocksRuntimeRef.current = blocked
    setDeletionBlocksRuntimeState(blocked)
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
    try {
      setSessions(await window.whycode.listSessions())
      setSessionListError(null)
    } catch (error) {
      setSessionListError(
        `会话历史读取失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }, [])

  const refreshModels = useCallback(async () => {
    const targetRuntimeId = runtimeIdRef.current || undefined
    const [nextModels, snapshot] = await Promise.all([
      window.whycode.listModels(targetRuntimeId),
      window.whycode.runtimeSnapshot(targetRuntimeId),
    ])
    if (runtimeIdRef.current && runtimeIdRef.current !== snapshot.runtimeId) return
    setModels(nextModels)
    setModelId(snapshot.modelId ?? '')
    setReasoningEffort(snapshot.reasoningEffort)
  }, [])

  const applyRuntimeSnapshot = useCallback((snapshot: RuntimeSnapshot) => {
    const changingRuntime = runtimeIdRef.current !== snapshot.runtimeId
    if (changingRuntime) stashActiveComposer()
    if (changingRuntime) hydratingRuntimeIdRef.current = snapshot.runtimeId
    runtimeIdRef.current = snapshot.runtimeId
    sessionIdRef.current = snapshot.sessionId
    activeSnapshotSequenceRef.current = snapshot.eventSequence
    setRuntimeId(snapshot.runtimeId)
    if (changingRuntime) {
      resetSkillCatalog()
      const key = composerKey(snapshot.runtimeId, snapshot.sessionId)
      const draft = composerDraftsRef.current.get(key)
      composerDraftsRef.current.delete(key)
      setInput(draft?.text ?? '')
      replaceSkills(draft?.skills ?? [])
      if (draft) {
        restoreImageDrafts(draft.images)
        restorePdfDrafts(draft.pdfs)
      }
    }
    setView(createConversationState(snapshot.viewEvents))
    setWorkspace(snapshot.workspace)
    setPermMode(snapshot.permissionMode)
    setWorkStartedAt(snapshot.workStartedAt)
    setStatus(snapshot.status)
    setDeletingSessionId(snapshot.deletingSessionId)
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
  }, [
    restoreImageDrafts,
    restorePdfDrafts,
    replaceSkills,
    resetSkillCatalog,
    setDeletionBlocksRuntime,
    setResumingSessionId,
    stashActiveComposer,
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
        void refreshModels()
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
    refreshModels,
    refreshSessions,
    setResumingSessionId,
  ])

  const consumeEvent = useCallback((event: CoreEvent) => {
    setView((previous) => applyCoreEvent(previous, event))
    switch (event.type) {
      case 'work-started':
        setWorkStartedAt(event.startedAt)
        break
      case 'work-finished':
        setWorkStartedAt(null)
        break
      case 'agent-status':
        setStatus(event.status)
        if (event.status !== 'waiting-approval') setApproval(null)
        if (event.status === 'idle' || event.status === 'error') {
          setStopping(false)
          if (deletionBlocksRuntimeRef.current) {
            setDeletingSessionId(null)
            setDeletionBlocksRuntime(false)
          }
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
      case 'checkpoint-restored':
        setCheckpointRestoreToolUseId((current) =>
          current === event.toolUseId ? null : current,
        )
        break
      case 'message-queued':
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
  }, [refreshSessions, restoreQueuedDrafts, setDeletionBlocksRuntime, synchronizeUnownedResume])

  useEffect(() => {
    if (!runtimeId) return
    const buffered = (backgroundEventsRef.current.get(runtimeId) ?? [])
      .sort((left, right) => left.sequence - right.sequence)
    backgroundEventsRef.current.delete(runtimeId)
    for (const entry of buffered) {
      if (entry.sequence <= activeSnapshotSequenceRef.current) continue
      sessionIdRef.current = entry.sessionId
      consumeEvent(entry.event)
    }
    if (hydratingRuntimeIdRef.current === runtimeId) {
      hydratingRuntimeIdRef.current = null
    }
  }, [consumeEvent, runtimeId])

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
    }[] = []
    const unsubscribe = window.whycode.onEvent((
      event,
      sequence,
      eventRuntimeId,
      eventSessionId,
    ) => {
      if (!hydrated) {
        buffered.push({
          event,
          sequence,
          runtimeId: eventRuntimeId,
          sessionId: eventSessionId,
        })
        return
      }
      if (
        eventRuntimeId === runtimeIdRef.current
        && hydratingRuntimeIdRef.current !== eventRuntimeId
      ) {
        sessionIdRef.current = eventSessionId
        consumeEvent(event)
      } else if (
        event.type === 'agent-status'
        || event.type === 'turn-end'
        || event.type === 'approval-request'
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
        pending.push({ event, sequence, sessionId: eventSessionId })
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
    })
    void window.whycode.runtimeSnapshot().then((snapshot) => {
      if (disposed) return
      applyRuntimeSnapshot(snapshot)
      hydrated = true
      const pendingEvents = eventsAfterRuntimeSnapshot(
        buffered.splice(0).filter((entry) => entry.runtimeId === snapshot.runtimeId),
        snapshot.eventSequence,
      )
      for (const event of pendingEvents) consumeEvent(event)
      void refreshSessions()
    }).catch(() => {
      if (disposed) return
      hydrated = true
      for (const bufferedEvent of buffered.splice(0)) {
        if (bufferedEvent.runtimeId === runtimeIdRef.current) {
          consumeEvent(bufferedEvent.event)
        }
      }
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [
    applyRuntimeSnapshot,
    consumeEvent,
    refreshSessions,
    synchronizeUnownedResume,
  ])

  useEffect(() => {
    if (stickToBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }
  }, [blocks, approval])

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
  const editableBlockId = !interactionBusy && !stopping && !consensus.enabled
    ? editableUserBlockId(blocks)
    : null
  const attachmentLocked = stopping
    || sessionTransitionPending
    || attachmentSubmissionPending
    || deletionBlocksRuntime
    || resumingSessionId !== null
    || checkpointRestoreToolUseId !== null
  const sessionChangeLocked = deletingSessionId !== null
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
    void refreshModels()
    return true
  }, [addError, applyRuntimeSnapshot, refreshModels, refreshSessions])

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
      stickToBottom.current = true
      setShowJumpBottom(false)
      setSessionActionError(null)
      void window.whycode.consensusStatus().then(setConsensus)
      void refreshSessions()
      void refreshModels()
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
    refreshModels,
    refreshSessions,
    setResumingSessionId,
  ])

  const deleteSession = useCallback((sessionId: string) => {
    if (
      deletingSessionId
      || resumingSessionIdRef.current
      || sessionTransitionPendingRef.current
    ) return
    setDeletingSessionId(sessionId)
    void window.whycode.runtimeSnapshot(runtimeIdRef.current || undefined).then((snapshot) => {
      setDeletionBlocksRuntime(isCurrentSessionDeletion(snapshot.sessionId, sessionId))
      return window.whycode.deleteSession(sessionId)
    }).then(async (result) => {
      if (result.ok || result.deletedCurrent) {
        const detachedDraft = composerDraftsRef.current.get(sessionId)
        if (detachedDraft) releaseImageDrafts(detachedDraft.images)
        composerDraftsRef.current.delete(sessionId)
        for (const [eventRuntimeId, events] of backgroundEventsRef.current) {
          if (events.some((entry) => entry.sessionId === sessionId)) {
            backgroundEventsRef.current.delete(eventRuntimeId)
          }
        }
      }
      if (result.deletedCurrent) {
        resetActiveComposer()
        if (result.snapshot) applyRuntimeSnapshot(result.snapshot)
        void window.whycode.consensusStatus().then(setConsensus)
      }
      if (!result.ok) addError(result.error ?? '删除会话失败')
    }).catch(() => {
      addError('删除会话失败，请重试')
    }).finally(() => {
      setDeletingSessionId(null)
      setDeletionBlocksRuntime(false)
      void refreshSessions()
    })
  }, [
    addError,
    applyRuntimeSnapshot,
    deletingSessionId,
    refreshSessions,
    resetActiveComposer,
    setDeletionBlocksRuntime,
  ])

  const compact = useCallback(() => {
    if (status !== 'idle' && status !== 'error') return
    setView((previous) =>
      appendNotice(previous, '正在压缩上下文（生成摘要中，可点停止取消）…'),
    )
    void sendRuntimeCommand({ type: 'compact' })
  }, [sendRuntimeCommand, status])
  slashCommandRef.current = (command) => {
    if (command === 'compact') compact()
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
    if (imageDrafts.length > 0 && nextModel.imageInputMode === 'none') {
      addError('已添加图片；目标模型既不支持原生识图，也没有可用的辅助识图模型')
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
  }, [addError, imageDrafts.length, modelId, models, reasoningEffort, sendRuntimeCommand])

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
    void refreshModels().catch((error) => {
      addError(`模型列表刷新失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [addError, refreshModels])

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
    const sentSkills = captureSkills()
    const text = input.trim()
      || attachmentFallbackText(imageDrafts.length, pdfDrafts.length)
      || (imageDrafts.length === 0 && sentSkills.length ? '请按所选 Skill 执行。' : '')
    if (!text && imageDrafts.length === 0) return
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
      setRestoredInputIds((current) => [
        ...new Set([...sentRestoredInputIds, ...current]),
      ])
    }
    void (async () => {
      try {
        const attachments = await prepareImageDrafts(sentImageDrafts)
        const pdfAttachments = preparePdfDrafts(sentPdfDrafts)
        const result = await window.whycode.sendCommand(targetRuntimeId, {
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
        })
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

  const editUserMessage = useCallback(async (turnId: string, text: string) => {
    if (interactionBusy || stopping || consensus.enabled) return false
    stickToBottom.current = true
    setShowJumpBottom(false)
    try {
      const result = await sendRuntimeCommand({ type: 'edit-user-message', turnId, text })
      return Boolean(result?.ok)
    } catch {
      return false
    }
  }, [consensus.enabled, interactionBusy, sendRuntimeCommand, stopping])

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
    setView((previous) => toggleExpanded(previous, id))
  }, [])

  const selectedModel = models.find((model) => model.id === modelId)
  const canAttachImages = Boolean(
    selectedModel?.available && selectedModel.imageInputMode !== 'none',
  )
  const canAttachPdfs = Boolean(selectedModel?.available)
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
        onDelete={deleteSession}
        onOpenSettings={openConnectionSettings}
      />

      <section className="wc-shell-panel flex min-w-0 flex-1 flex-col bg-[var(--wc-surface)]">
        <TaskHeader
          title={taskTitle}
          projectDir={workspace.mode === 'pending-managed' ? null : projectDir}
          workspaceMode={workspace.mode}
          onOpenWorkspaceFolder={openCurrentWorkspaceFolder}
        />

        <div className="relative flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <main
              ref={scrollRef}
              onScroll={onScroll}
              className="wc-scrollbar relative min-h-0 flex-1 overflow-y-auto px-5 py-5"
            >
              <div className="mx-auto w-full max-w-4xl">
                {!conversationStarted && (
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
                  sections={sections}
                  expandedIds={view.expanded}
                  editableBlockId={editableBlockId}
                  busy={interactionBusy}
                  checkpointRestoreAnchorIds={checkpointRestoreAnchors}
                  checkpointRestoreToolUseId={checkpointRestoreToolUseId}
                  onCheckpointRestoreChange={changeCheckpointRestore}
                  onEdit={editUserMessage}
                  onToggle={toggle}
                />
              </div>
            </main>

            <div className="relative shrink-0 px-4 pb-4 pt-1">
              <div className="mx-auto w-full max-w-4xl">
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

                {view.pendingQuestion && (
                  <div className="mb-2">
                    <PaperFrame>
                      <QuestionCard
                        key={view.pendingQuestion.id}
                        question={view.pendingQuestion}
                        disabled={interactionBusy || stopping || questionSubmitting}
                        onAnswer={answerQuestion}
                      />
                    </PaperFrame>
                  </div>
                )}

                {approval && (
                  <div className="mb-2">
                    <PaperFrame>
                      <ApprovalCard approval={approval} onRespond={respondApproval} />
                    </PaperFrame>
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

                <footer className="wc-composer relative p-2.5">
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

                  {!conversationStarted && (
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

                  <textarea
                    ref={composerTextareaRef}
                    rows={2}
                    className="wc-scrollbar max-h-40 min-h-[66px] w-full resize-none overflow-y-auto bg-transparent px-1.5 py-1 text-sm leading-6 text-[var(--wc-ink)] caret-[var(--wc-ink)] outline-none [field-sizing:content] placeholder:text-[var(--wc-faint)]"
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
                    busy={busy}
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
                </footer>
              </div>
            </div>
          </section>

          <TaskInspector
            runtimeId={runtimeId}
            workspace={workspace}
            plan={view.taskPlan}
            busy={interactionBusy}
            onPrepareCommitPrompt={prepareCommitPrompt}
          />
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
