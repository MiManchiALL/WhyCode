import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'
// 注意：Renderer 只能从浏览器安全的子路径导入运行时值；从 '@whycode/core' 根导入值会把
// Node 内置模块拖进渲染端导致白屏（types 导入不受此限）
import type { PermissionMode } from '@whycode/core/permissions'
import type { CoreCommand, ReasoningEffortSelection } from '@whycode/core'
import {
  formatUserQuestionAnswer,
  type AgentStatus,
  type CoreEvent,
  type QueuedUserMessage,
} from '@whycode/core/events'
import type { RuntimeSnapshot, SessionListItem } from '../../shared/session.ts'
import type { ConnectionSettingsSnapshot, ModelListItem } from '../../shared/settings.ts'
import {
  applyCoreEvent,
  appendNotice,
  createConversationState,
  editableUserBlockId,
  eventsAfterRuntimeSnapshot,
  resumeTargetCommitted,
  toggleExpanded,
  voteLabel,
} from './conversation-state.ts'
import { AppHeader } from './app-header.tsx'
import { SessionPanel } from './session-panel.tsx'
import { isCurrentSessionDeletion } from './session-deletion-state.ts'
import { TaskPlanCard } from './task-plan-card.tsx'
import { QuestionCard } from './question-card.tsx'
import { ProcessingTime } from './processing-time.ts'
import { ConversationView } from './conversation-view.tsx'
import { summarizeInput } from './conversation-block.tsx'
import { ConnectionSettingsPanel } from './connection-settings-panel.tsx'
import {
  ImageDraftStrip,
  ImagePickerButton,
  QueuedImageStrip,
  releaseImageDrafts,
  useImageDrafts,
} from './image-attachments.tsx'
import {
  prepareImageDrafts,
  restoredImageDrafts,
  type ImageDraft,
} from './image-draft.ts'
import { collectPastedImageFiles, collectPastedPdfFiles } from './image-paste.ts'
import { useAttachmentDropTarget } from './image-drop.ts'
import {
  PdfDraftStrip,
  PdfPickerButton,
  QueuedPdfStrip,
  usePdfDrafts,
} from './pdf-attachments.tsx'
import {
  preparePdfDrafts,
  restoredPdfDrafts,
  type PdfDraft,
} from './pdf-draft.ts'
import { composerKeyAction } from './composer-key.ts'

interface Approval {
  requestId: string
  toolName: string
  input: unknown
  reason: string
  diff?: string
  suggestion?: { kind: 'add-dir'; dir: string } | { kind: 'allow-tool'; toolName: string }
}

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
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [queued, setQueued] = useState<QueuedUserMessage[]>([])
  const [restoredInputIds, setRestoredInputIds] = useState<string[]>([])
  const [restoredQueue, setRestoredQueue] = useState<QueuedUserMessage[]>([])
  const [restoredSubmissionPending, setRestoredSubmissionPending] = useState(false)
  const [permMode, setPermMode] = useState<PermissionMode>('default')
  const [consensus, setConsensus] = useState<{ ready: boolean; reason: string | null; enabled: boolean }>({ ready: false, reason: null, enabled: false })
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [sessionListError, setSessionListError] = useState<string | null>(null)
  const [sessionActionError, setSessionActionError] = useState<string | null>(null)
  const [showSessions, setShowSessions] = useState(false)
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
  }>())
  /** 贴底跟随：仅当用户本就在底部附近才自动滚动；往上翻阅时不打扰 */
  const stickToBottom = useRef(true)
  const [showJumpBottom, setShowJumpBottom] = useState(false)
  const inputRef = useRef('')
  const blocks = view.blocks
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
    // 尚未产生 JSONL 的空白页没有历史入口，切走后不能再导航回来。
    if (!currentSessionId) {
      releaseImageDrafts(images)
      return
    }
    const key = composerKey(currentRuntimeId, currentSessionId)
    if (text || images.length > 0 || pdfs.length > 0) {
      composerDraftsRef.current.set(key, { text, images, pdfs })
    } else {
      composerDraftsRef.current.delete(key)
    }
  }, [detachImageDrafts, detachPdfDrafts])

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
    ) return
    const next = restoredQueue[0]!
    setRestoredQueue((previous) => previous.filter((item) => item.id !== next.id))
    setInput(next.text)
    restoreImageDrafts(restoredImageDrafts([next]))
    restorePdfDrafts(restoredPdfDrafts([next]))
    setRestoredInputIds([next.id])
  }, [
    imageDrafts.length,
    pdfDrafts.length,
    input,
    restoreImageDrafts,
    restorePdfDrafts,
    restoredInputIds.length,
    restoredQueue,
    restoredSubmissionPending,
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
      const key = composerKey(snapshot.runtimeId, snapshot.sessionId)
      const draft = composerDraftsRef.current.get(key)
      composerDraftsRef.current.delete(key)
      setInput(draft?.text ?? '')
      if (draft) {
        restoreImageDrafts(draft.images)
        restorePdfDrafts(draft.pdfs)
      }
    }
    setView(createConversationState(snapshot.viewEvents))
    setProjectDir(snapshot.projectDir)
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
        setShowSessions(false)
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
      void window.whycode.getProjectDir().then(setProjectDir)
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

  const pickProject = useCallback(() => {
    if (!beginSessionTransition()) return
    void window.whycode.pickProjectDir().then(async (result) => {
      if (!result?.ok) return
      applyRuntimeSnapshot(result.snapshot)
      setShowSessions(false)
      void window.whycode.consensusStatus().then(setConsensus)
      void refreshSessions()
      void refreshModels()
    }).catch((error) => {
      addError(`工作文件夹切换失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(endSessionTransition)
  }, [
    addError,
    applyRuntimeSnapshot,
    beginSessionTransition,
    endSessionTransition,
    refreshModels,
    refreshSessions,
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
    void window.whycode.newSession().then((result) => {
      if (!result.ok) return addError(result.error ?? '新建会话失败')
      applyRuntimeSnapshot(result.snapshot)
      setShowSessions(false)
      void window.whycode.consensusStatus().then(setConsensus)
      void refreshSessions()
      void refreshModels()
    }).catch((error) => {
      addError(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(endSessionTransition)
  }, [
    addError,
    applyRuntimeSnapshot,
    beginSessionTransition,
    endSessionTransition,
    refreshModels,
    refreshSessions,
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
      setShowSessions(false)
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
        inputRef.current = ''
        setInput('')
        clearImageDrafts()
        clearPdfDrafts()
        if (result.snapshot) applyRuntimeSnapshot(result.snapshot)
        if (result.ok) setShowSessions(false)
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
    clearImageDrafts,
    clearPdfDrafts,
    deletingSessionId,
    refreshSessions,
    setDeletionBlocksRuntime,
  ])

  const compact = useCallback(() => {
    setView((previous) =>
      appendNotice(previous, '正在压缩上下文（生成摘要中，可点停止取消）…'),
    )
    void sendRuntimeCommand({ type: 'compact' })
  }, [sendRuntimeCommand])

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
    if (imageDrafts.length > 0 && !nextModel?.supportsImageInput) {
      addError('已添加图片；请先移除图片再切换到非视觉模型')
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
    const text = input.trim() || defaultDraftPrompt(imageDrafts.length, pdfDrafts.length)
    if (!text) return
    const sentImageDrafts = detachImageDrafts()
    const sentPdfDrafts = detachPdfDrafts()
    const sentRestoredInputIds = restoredInputIds
    setRestoredInputIds([])
    if (sentRestoredInputIds.length > 0) setRestoredSubmissionPending(true)
    // IPC 确认持久化并交给目标 Agent 前，暂不允许切换；否则失败恢复可能落入另一对话。
    setAttachmentSubmissionPending(true)
    setInput('')
    // 自己发消息 = 主动行为，恢复贴底跟随
    stickToBottom.current = true
    setShowJumpBottom(false)
    const restoreRejectedInput = () => {
      setInput((current) => current ? `${text}\n${current}` : text)
      restoreImageDrafts(sentImageDrafts)
      restorePdfDrafts(sentPdfDrafts)
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
          ...(sentRestoredInputIds.length
            ? { restoredInputIds: sentRestoredInputIds }
            : {}),
        })
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
    checkpointRestoreToolUseId,
    deletionBlocksRuntime,
    detachImageDrafts,
    detachPdfDrafts,
    imageDrafts.length,
    input,
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
  const canAttachImages = Boolean(selectedModel?.available && selectedModel.supportsImageInput)
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
      else addError('当前模型不支持粘贴图片；PDF 仍可添加')
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

  return (
    <div
      className="relative flex h-screen flex-col bg-neutral-50 text-neutral-900"
      {...attachmentDrop.handlers}
    >
      {attachmentDrop.active && (
        <div className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-violet-500 bg-violet-50/90 text-base font-medium text-violet-700 shadow-lg">
          {attachmentLocked
            ? '当前操作暂时锁定附件'
            : !canAttachPdfs
              ? '当前没有可用模型'
              : canAttachImages
                ? '松开以添加图片或 PDF'
                : '松开以添加 PDF；当前模型不支持图片'}
        </div>
      )}
      <AppHeader
        projectDir={projectDir}
        busy={interactionBusy}
        sessionChangeLocked={sessionChangeLocked}
        permissionLocked={
          sessionTransitionPending
          || deletionBlocksRuntime
          || resumingSessionId !== null
        }
        consensus={consensus}
        permMode={permMode}
        models={models}
        modelId={modelId}
        reasoningEffort={reasoningEffort}
        onPickProject={pickProject}
        onToggleConsensus={toggleConsensus}
        onCompact={compact}
        onPermissionChange={changePermission}
        onModelChange={changeModel}
        onReasoningEffortChange={changeReasoningEffort}
        onOpenSessions={() => {
          setSessionActionError(null)
          setShowSessions(true)
          void refreshSessions()
        }}
        onNewSession={startNewSession}
        onOpenConnectionSettings={openConnectionSettings}
      />

      {showConnectionSettings && connectionSettings && (
        <ConnectionSettingsPanel
          snapshot={connectionSettings}
          onClose={() => setShowConnectionSettings(false)}
          onChanged={applyConnectionSettings}
        />
      )}

      {showSessions && (
        <SessionPanel
          sessions={sessions}
          error={sessionListError}
          actionError={sessionActionError}
          busy={sessionChangeLocked}
          deletingSessionId={deletingSessionId}
          resumingSessionId={resumingSessionId}
          onClose={() => setShowSessions(false)}
          onResume={resumeSession}
          onDelete={deleteSession}
        />
      )}

      {view.taskPlan && <TaskPlanCard key={view.taskPlan.id} plan={view.taskPlan} />}

      <main ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto px-6 py-4">
        {blocks.length === 0 && (
          <p className="mt-24 text-center text-sm text-neutral-400">
            {projectDir
              ? '与 WhyCode 对话，它能读写文件、执行命令（写操作需你确认）'
              : '正在准备默认工作文件夹…'}
          </p>
        )}
        <ConversationView
          runtimeId={runtimeId}
          blocks={blocks}
          expandedIds={view.expanded}
          editableBlockId={editableBlockId}
          busy={interactionBusy}
          workStartedAt={workStartedAt}
          checkpointRestoreToolUseId={checkpointRestoreToolUseId}
          onCheckpointRestoreChange={changeCheckpointRestore}
          onEdit={editUserMessage}
          onToggle={toggle}
        />
      </main>

      {workStartedAt !== null && (
        <div className="border-t border-neutral-100 px-6 py-1.5 text-xs text-neutral-400">
          <ProcessingTime startedAt={workStartedAt} />
        </div>
      )}

      {showJumpBottom && (
        <div className="relative">
          <button
            className="absolute -top-10 left-1/2 -translate-x-1/2 rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-600 shadow hover:border-neutral-500"
            onClick={jumpToBottom}
            title="回到底部并恢复自动跟随"
          >
            ↓ 回到底部
          </button>
        </div>
      )}

      {view.pendingQuestion && (
        <div className="border-t border-violet-200 px-6 pt-3">
          <QuestionCard
            key={view.pendingQuestion.id}
            question={view.pendingQuestion}
            disabled={interactionBusy || stopping || questionSubmitting}
            onAnswer={answerQuestion}
          />
        </div>
      )}

      {/* 审批卡常驻输入框上方：Agent 在等答复，绝不能被滚动藏住 */}
      {approval && (
        <div className="border-t border-amber-200 px-6 pt-3">
          <ApprovalCard approval={approval} onRespond={respondApproval} />
        </div>
      )}

      {negoStatus && (
        <div className="border-t border-violet-100 bg-violet-50/60 px-6 py-1.5 text-xs text-violet-700">
          🤝 {negoStatus}
        </div>
      )}

      {resumingSessionId && (
        <div
          className="border-t border-blue-100 bg-blue-50/70 px-6 py-1.5 text-xs text-blue-700"
          role="status"
          aria-live="polite"
        >
          正在验证附件并恢复会话…
        </div>
      )}

      <footer className="border-t border-neutral-200 p-4">
        {queued.length > 0 && (
          <div className="mb-2 space-y-1">
            {queued.map((q) => (
              <div key={q.id} className="rounded bg-neutral-100 px-3 py-1 text-xs text-neutral-500">
                <div className="truncate">⏳ 已排队 · {q.text}</div>
                <QueuedImageStrip attachments={q.attachments} />
                <QueuedPdfStrip attachments={q.pdfAttachments} />
              </div>
            ))}
          </div>
        )}
        {restoredQueue.length > 0 && (
          <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            另有 {restoredQueue.length} 条中断输入已安全保留；当前恢复输入提交后会按原顺序继续恢复。
          </div>
        )}
        <ImageDraftStrip drafts={imageDrafts} onRemove={removeImageDraft} />
        <PdfDraftStrip drafts={pdfDrafts} onRemove={removePdfDraft} />
        <div className="flex items-end gap-2">
          <ImagePickerButton
            supportsImageInput={canAttachImages}
            disabled={attachmentLocked}
            onFiles={addImageFiles}
          />
          <PdfPickerButton
            disabled={!canAttachPdfs || attachmentLocked}
            onFiles={addPdfFiles}
          />
          <textarea
            rows={1}
            className="max-h-40 min-h-10 flex-1 resize-none overflow-y-auto rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none [field-sizing:content] focus:border-neutral-500"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={pasteAttachments}
            disabled={
              stopping
              || sessionTransitionPending
              || deletionBlocksRuntime
              || resumingSessionId !== null
              || checkpointRestoreToolUseId !== null
            }
            onKeyDown={(e) => {
              const action = composerKeyAction({
                key: e.key,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                isComposing: e.nativeEvent.isComposing,
              })
              if (action === 'ignore' || action === 'newline') return
              e.preventDefault()
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
                  ? '正在验证附件并恢复会话…'
                : checkpointRestoreToolUseId
                  ? '正在安全回滚文件，请等待完成…'
                : status === 'waiting-approval'
                  ? '⏸ Agent 在等你审批上方的请求…'
                  : busy
                    ? '工作中——Enter 排队，Ctrl+Enter 立即插话，Shift+Enter 换行'
                    : projectDir
                      ? '输入消息…（Shift+Enter 换行）'
                      : '正在准备工作文件夹…'
            }
          />
          {busy && !deletionBlocksRuntime && resumingSessionId === null && (
            <button
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm disabled:opacity-40"
              onClick={stop}
              disabled={stopping}
            >
              {stopping ? '停止中…' : '停止'}
            </button>
          )}
          {busy && !deletionBlocksRuntime && resumingSessionId === null && (
            <button
              className="rounded-md border border-amber-400 px-3 py-2 text-sm text-amber-700 disabled:opacity-40"
              onClick={() => send(true)}
              disabled={
                stopping
                || attachmentSubmissionPending
                || (!input.trim() && imageDrafts.length === 0 && pdfDrafts.length === 0)
              }
              title="打断当前步骤，立即插话"
            >
              立即
            </button>
          )}
          <button
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
            onClick={() => send(false)}
            disabled={
              stopping
              || attachmentSubmissionPending
              || deletionBlocksRuntime
              || resumingSessionId !== null
              || checkpointRestoreToolUseId !== null
              || (!input.trim() && imageDrafts.length === 0 && pdfDrafts.length === 0)
            }
          >
            {busy ? '排队' : '发送'}
          </button>
        </div>
      </footer>
    </div>
  )
}

function defaultDraftPrompt(imageCount: number, pdfCount: number): string {
  if (imageCount > 0 && pdfCount > 0) return '请分析这些附件。'
  if (imageCount > 0) return '请分析这些图片。'
  if (pdfCount > 0) return '请分析这些 PDF。'
  return ''
}

function composerKey(runtimeId: string, sessionId: string | null): string {
  return sessionId ?? `runtime:${runtimeId}`
}

function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: Approval
  onRespond: (approved: boolean, remember?: boolean) => void
}) {
  const rememberLabel =
    approval.suggestion?.kind === 'add-dir'
      ? '允许并记住此目录（本会话）'
      : approval.suggestion?.kind === 'allow-tool'
        ? `允许且本会话不再询问 ${approval.suggestion.toolName}`
        : null
  return (
    <div className="mb-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="mb-1 font-medium text-amber-800">
        请求执行：{approval.toolName}
      </div>
      <div className="mb-2 text-xs text-amber-700">{approval.reason}</div>
      {approval.diff ? (
        <pre className="mb-2 max-h-64 overflow-auto rounded bg-white p-2 text-xs">
          {approval.diff.split('\n').map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'text-green-700'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'text-red-700'
                    : 'text-neutral-500'
              }
            >
              {line}
            </div>
          ))}
        </pre>
      ) : (
        <pre className="mb-2 max-h-40 overflow-auto rounded bg-white p-2 text-xs text-neutral-600">
          {summarizeInput(approval.input)}
        </pre>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="rounded bg-neutral-900 px-3 py-1 text-xs text-white"
          onClick={() => onRespond(true, false)}
        >
          批准（仅本次）
        </button>
        {rememberLabel && (
          <button
            className="rounded border border-neutral-400 bg-white px-3 py-1 text-xs"
            onClick={() => onRespond(true, true)}
          >
            {rememberLabel}
          </button>
        )}
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs"
          onClick={() => onRespond(false)}
        >
          拒绝
        </button>
      </div>
    </div>
  )
}
