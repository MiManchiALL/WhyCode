import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { Streamdown } from 'streamdown'
// 注意：Renderer 只能从浏览器安全的子路径导入运行时值；从 '@whycode/core' 根导入值会把
// Node 内置模块拖进渲染端导致白屏（types 导入不受此限）
import type { PermissionMode } from '@whycode/core/permissions'
import type {
  AgentStatus,
  CoreEvent,
  QueuedUserMessage,
  UserQuestion,
} from '@whycode/core/events'
import type { SessionListItem } from '../../shared/session.ts'
import type { ModelListItem, ModelSettingsSnapshot } from '../../shared/settings.ts'
import {
  applyCoreEvent,
  appendNotice,
  createConversationState,
  eventsAfterRuntimeSnapshot,
  restoreRuntimeConversation,
  toggleExpanded,
  voteLabel,
  type Block,
} from './conversation-state.ts'
import {
  CandidateCard,
  PeerCard,
} from './consensus-blocks.tsx'
import { AppHeader } from './app-header.tsx'
import { SessionPanel } from './session-panel.tsx'
import { TaskPlanCard } from './task-plan-card.tsx'
import { ModelSettingsPanel } from './model-settings-panel.tsx'
import {
  ImageDraftStrip,
  ImagePickerButton,
  QueuedImageStrip,
  releaseImageDrafts,
  useImageDrafts,
  UserImageGallery,
} from './image-attachments.tsx'
import { prepareImageDrafts, restoredImageDrafts } from './image-draft.ts'
import { collectPastedImageFiles, collectPastedPdfFiles } from './image-paste.ts'
import { useAttachmentDropTarget } from './image-drop.ts'
import {
  PdfDraftStrip,
  PdfPickerButton,
  QueuedPdfStrip,
  usePdfDrafts,
  UserPdfGallery,
} from './pdf-attachments.tsx'
import { preparePdfDrafts, restoredPdfDrafts } from './pdf-draft.ts'

interface Approval {
  requestId: string
  toolName: string
  input: unknown
  reason: string
  diff?: string
  suggestion?: { kind: 'add-dir'; dir: string } | { kind: 'allow-tool'; toolName: string }
}

/** M1-c 主界面：文本 + thinking + 工具卡片 + 审批。正式组件化（Streamdown/shadcn）在 M1 收尾时做。 */
export function App() {
  const [view, setView] = useState(() => createConversationState())
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [stopping, setStopping] = useState(false)
  const [questionSubmitting, setQuestionSubmitting] = useState(false)
  const [attachmentSubmissionPending, setAttachmentSubmissionPending] = useState(false)
  const [models, setModels] = useState<ModelListItem[]>([])
  const [modelId, setModelId] = useState('')
  const [showModelSettings, setShowModelSettings] = useState(false)
  const [modelSettings, setModelSettings] = useState<ModelSettingsSnapshot | null>(null)
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
  const [showSessions, setShowSessions] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [checkpointRestoreToolUseId, setCheckpointRestoreToolUseId] = useState<string | null>(null)
  /** 协商进行中的状态条文案（null = 无协商） */
  const [negoStatus, setNegoStatus] = useState<string | null>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const questionSubmittingRef = useRef(false)
  /** 贴底跟随：仅当用户本就在底部附近才自动滚动；往上翻阅时不打扰 */
  const stickToBottom = useRef(true)
  const [showJumpBottom, setShowJumpBottom] = useState(false)
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
    const [nextModels, snapshot] = await Promise.all([
      window.whycode.listModels(),
      window.whycode.runtimeSnapshot(),
    ])
    setModels(nextModels)
    setModelId(snapshot.modelId ?? '')
  }, [])

  const consumeEvent = useCallback((event: CoreEvent) => {
    setView((previous) => applyCoreEvent(previous, event))
    switch (event.type) {
      case 'agent-status':
        setStatus(event.status)
        if (event.status === 'idle' || event.status === 'error') {
          setStopping(false)
          setDeletingSessionId(null)
        }
        if (event.status === 'idle') setNegoStatus(null)
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
  }, [refreshSessions, restoreQueuedDrafts])

  useEffect(() => {
    void window.whycode.listModels().then(setModels)
    void window.whycode.consensusStatus().then(setConsensus)
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    let disposed = false
    let hydrated = false
    const buffered: { event: CoreEvent; sequence: number }[] = []
    const unsubscribe = window.whycode.onEvent((event, sequence) => {
      if (hydrated) consumeEvent(event)
      else buffered.push({ event, sequence })
    })
    void window.whycode.runtimeSnapshot().then((snapshot) => {
      if (disposed) return
      const restored = restoreRuntimeConversation(
        snapshot.viewEvents,
        snapshot.busy && !snapshot.checkpointRestoreToolUseId,
      )
      setView(restored)
      setProjectDir(snapshot.projectDir)
      setPermMode(snapshot.permissionMode)
      setStatus(snapshot.status)
      setDeletingSessionId(snapshot.deletingSessionId)
      setCheckpointRestoreToolUseId(snapshot.checkpointRestoreToolUseId)
      setStopping(false)
      setQueued(snapshot.queuedInputs)
      restoreQueuedDrafts(snapshot.restoredInputs)
      setApproval(snapshot.approval)
      if (snapshot.modelId) setModelId(snapshot.modelId)
      hydrated = true
      const pendingEvents = eventsAfterRuntimeSnapshot(
        buffered.splice(0),
        snapshot.eventSequence,
      )
      for (const event of pendingEvents) consumeEvent(event)
      void refreshSessions()
    }).catch(() => {
      if (disposed) return
      hydrated = true
      for (const bufferedEvent of buffered.splice(0)) consumeEvent(bufferedEvent.event)
      void window.whycode.getProjectDir().then(setProjectDir)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [consumeEvent, refreshSessions, restoreQueuedDrafts])

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
    || attachmentSubmissionPending
    || deletingSessionId !== null
    || checkpointRestoreToolUseId !== null
  const attachmentLocked = stopping
    || attachmentSubmissionPending
    || deletingSessionId !== null
    || checkpointRestoreToolUseId !== null

  const changeCheckpointRestore = useCallback((toolUseId: string, pending: boolean) => {
    setCheckpointRestoreToolUseId((current) =>
      pending ? (current ?? toolUseId) : current === toolUseId ? null : current,
    )
  }, [])

  const pickProject = useCallback(() => {
    void window.whycode.pickProjectDir().then((dir) => {
      if (dir) {
        setProjectDir(dir)
        setView(createConversationState())
        setInput('')
        setQueued([])
        setRestoredInputIds([])
        setRestoredQueue([])
        setRestoredSubmissionPending(false)
        setApproval(null)
        clearImageDrafts()
        clearPdfDrafts()
        void window.whycode.consensusStatus().then(setConsensus)
        void refreshSessions()
      }
    })
  }, [clearImageDrafts, clearPdfDrafts, refreshSessions])

  const toggleConsensus = useCallback(() => {
    const enabled = !consensus.enabled
    void window.whycode
      .sendCommand({ type: 'set-consensus', enabled })
      .then((r) => {
        if (r && r.ok) setConsensus((prev) => ({ ...prev, enabled }))
      })
  }, [consensus.enabled])

  const resetView = useCallback((notice?: string) => {
    const empty = createConversationState()
    setView(notice ? appendNotice(empty, notice) : empty)
    setInput('')
    setQueued([])
    setRestoredInputIds([])
    setRestoredQueue([])
    setRestoredSubmissionPending(false)
    setApproval(null)
    setStatus('idle')
    setStopping(false)
    setAttachmentSubmissionPending(false)
    setCheckpointRestoreToolUseId(null)
    setNegoStatus(null)
    clearImageDrafts()
    clearPdfDrafts()
    stickToBottom.current = true
    setShowJumpBottom(false)
  }, [clearImageDrafts, clearPdfDrafts])

  const stop = useCallback(() => {
    if (stopping) return
    setStopping(true)
    setApproval(null)
    void window.whycode.sendCommand({ type: 'abort' }).catch(() => {
      setStopping(false)
      addError('停止请求发送失败，请重试')
    })
  }, [addError, stopping])

  const startNewSession = useCallback(() => {
    void window.whycode.newSession().then((result) => {
      if (!result.ok) return addError(result.error ?? '新建会话失败')
      resetView()
      setProjectDir(result.projectDir)
      setShowSessions(false)
      void refreshSessions()
    })
  }, [addError, refreshSessions, resetView])

  const resumeSession = useCallback((sessionId: string) => {
    void window.whycode.resumeSession(sessionId).then((result) => {
      if (!result.ok) return addError(result.error)
      const interrupted = result.recoveredFromInterruption
        ? '；已回退到安全边界，未完成工具和半截协商不会自动重放'
        : ''
      const restored = createConversationState(result.viewEvents)
      setView(
        appendNotice(
          restored,
          `已恢复「${result.session.title || '未命名会话'}」${interrupted}`,
        ),
      )
      setQueued([])
      setInput('')
      clearImageDrafts()
      clearPdfDrafts()
      setRestoredInputIds([])
      setRestoredQueue([])
      setRestoredSubmissionPending(false)
      setQueued(result.queuedInputs)
      restoreQueuedDrafts(result.restoredInputs)
      setApproval(null)
      setStatus('idle')
      setStopping(false)
      setCheckpointRestoreToolUseId(null)
      setNegoStatus(null)
      stickToBottom.current = true
      setShowJumpBottom(false)
      setProjectDir(result.session.projectDir)
      setModelId(result.session.modelId)
      setShowSessions(false)
      void window.whycode.consensusStatus().then(setConsensus)
      void refreshSessions()
    })
  }, [addError, clearImageDrafts, clearPdfDrafts, refreshSessions, restoreQueuedDrafts])

  const deleteSession = useCallback((sessionId: string) => {
    if (deletingSessionId) return
    if (!window.confirm(
      '将永久删除这个会话的对话、任务状态、检查点、后台命令记录和临时数据；不会修改项目文件。确定继续？',
    )) return
    setDeletingSessionId(sessionId)
    void window.whycode.deleteSession(sessionId).then((result) => {
      if (result.deletedCurrent) {
        resetView()
        void window.whycode.getProjectDir().then(setProjectDir)
        if (result.ok) setShowSessions(false)
        void window.whycode.consensusStatus().then(setConsensus)
      }
      if (!result.ok) addError(result.error ?? '删除会话失败')
    }).catch(() => {
      addError('删除会话失败，请重试')
    }).finally(() => {
      setDeletingSessionId(null)
      void refreshSessions()
    })
  }, [addError, deletingSessionId, refreshSessions, resetView])

  const compact = useCallback(() => {
    setView((previous) =>
      appendNotice(previous, '正在压缩上下文（生成摘要中，可点停止取消）…'),
    )
    void window.whycode.sendCommand({ type: 'compact' })
  }, [])

  const changePermission = useCallback((mode: PermissionMode) => {
    const previous = permMode
    setPermMode(mode)
    const rollback = () => setPermMode((current) => current === mode ? previous : current)
    void window.whycode.sendCommand({ type: 'set-permission-mode', mode }).then((result) => {
      if (!result || !result.ok) rollback()
    }).catch(rollback)
  }, [permMode])

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
    setModelId(next)
    const rollback = () => setModelId((current) => current === next ? previous : current)
    void window.whycode.sendCommand({ type: 'set-model', modelId: next }).then((result) => {
      if (!result || !result.ok) rollback()
    }).catch(rollback)
  }, [addError, imageDrafts.length, modelId, models])

  const openModelSettings = useCallback(() => {
    void window.whycode.modelSettings().then((snapshot) => {
      setModelSettings(snapshot)
      setShowModelSettings(true)
    }).catch((error) => {
      addError(`模型设置读取失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [addError])

  const applyModelSettings = useCallback((snapshot: ModelSettingsSnapshot) => {
    setModelSettings(snapshot)
    void refreshModels().catch((error) => {
      addError(`模型列表刷新失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [addError, refreshModels])

  const send = useCallback((urgent = false) => {
    if (
      stopping
      || deletingSessionId
      || checkpointRestoreToolUseId
      || attachmentSubmissionPending
    ) return
    const text = input.trim() || defaultDraftPrompt(imageDrafts.length, pdfDrafts.length)
    if (!text) return
    const sentImageDrafts = detachImageDrafts()
    const sentPdfDrafts = detachPdfDrafts()
    const sentRestoredInputIds = restoredInputIds
    setRestoredInputIds([])
    if (sentRestoredInputIds.length > 0) setRestoredSubmissionPending(true)
    if (sentImageDrafts.length > 0 || sentPdfDrafts.length > 0) {
      setAttachmentSubmissionPending(true)
    }
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
        const result = await window.whycode.sendCommand({
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
        if (sentImageDrafts.length > 0 || sentPdfDrafts.length > 0) {
          setAttachmentSubmissionPending(false)
        }
        if (sentRestoredInputIds.length > 0) setRestoredSubmissionPending(false)
      }
    })()
  }, [
    addError,
    attachmentSubmissionPending,
    checkpointRestoreToolUseId,
    deletingSessionId,
    detachImageDrafts,
    detachPdfDrafts,
    imageDrafts.length,
    input,
    pdfDrafts.length,
    restoredInputIds,
    restoreImageDrafts,
    restorePdfDrafts,
    stopping,
  ])

  const answerQuestion = useCallback((answer: string) => {
    const question = view.pendingQuestion
    if (!question || interactionBusy || stopping || questionSubmittingRef.current) return
    const text = `回答「${question.question}」：${answer}`
    questionSubmittingRef.current = true
    setQuestionSubmitting(true)
    stickToBottom.current = true
    setShowJumpBottom(false)
    void window.whycode.sendCommand({ type: 'user-message', text }).finally(() => {
      questionSubmittingRef.current = false
      setQuestionSubmitting(false)
    })
  }, [interactionBusy, stopping, view.pendingQuestion])

  const respondApproval = useCallback((approved: boolean, remember = false) => {
    if (!approval) return
    void window.whycode.sendCommand({
      type: 'approval-response',
      requestId: approval.requestId,
      approved,
      remember,
    })
    setApproval(null)
  }, [approval])

  const toggle = useCallback((id: string) => {
    setView((previous) => toggleExpanded(previous, id))
  }, [])

  const selectedModel = models.find((model) => model.id === modelId)
  const canAttachImages = Boolean(selectedModel?.available && selectedModel.supportsImageInput)
  const canAttachPdfs = Boolean(selectedModel?.available)
  const pasteAttachments = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
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
        permissionLocked={deletingSessionId !== null}
        consensus={consensus}
        permMode={permMode}
        models={models}
        modelId={modelId}
        onPickProject={pickProject}
        onToggleConsensus={toggleConsensus}
        onCompact={compact}
        onPermissionChange={changePermission}
        onModelChange={changeModel}
        onOpenSessions={() => {
          setShowSessions(true)
          void refreshSessions()
        }}
        onNewSession={startNewSession}
        onOpenModelSettings={openModelSettings}
      />

      {showModelSettings && modelSettings && (
        <ModelSettingsPanel
          snapshot={modelSettings}
          onClose={() => setShowModelSettings(false)}
          onChanged={applyModelSettings}
        />
      )}

      {showSessions && (
        <SessionPanel
          sessions={sessions}
          error={sessionListError}
          busy={interactionBusy}
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
        {blocks.map((b) => (
          <BlockView
            key={b.id}
            block={b}
            expanded={view.expanded.has(b.id)}
            busy={interactionBusy}
            checkpointRestoreToolUseId={checkpointRestoreToolUseId}
            onCheckpointRestoreChange={changeCheckpointRestore}
            onToggle={() => toggle(b.id)}
          />
        ))}
      </main>

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
        <div className="flex gap-2">
          <ImagePickerButton
            supportsImageInput={canAttachImages}
            disabled={attachmentLocked}
            onFiles={addImageFiles}
          />
          <PdfPickerButton
            disabled={!canAttachPdfs || attachmentLocked}
            onFiles={addPdfFiles}
          />
          <input
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={pasteAttachments}
            disabled={stopping || deletingSessionId !== null || checkpointRestoreToolUseId !== null}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // Enter=排队（等当前步骤结束注入）；Ctrl+Enter=立即插话（打断当前步骤）
              send(e.ctrlKey)
            }}
            placeholder={
              stopping
                ? '正在停止当前任务并清理子进程…'
                : deletingSessionId
                  ? '正在删除会话及其关联数据…'
                : checkpointRestoreToolUseId
                  ? '正在安全回滚文件，请等待完成…'
                : status === 'waiting-approval'
                  ? '⏸ Agent 在等你审批上方的请求…'
                  : busy
                    ? '工作中——Enter 排队插话，Ctrl+Enter 立即插话'
                    : projectDir
                      ? '输入消息…'
                      : '正在准备工作文件夹…'
            }
          />
          {busy && deletingSessionId === null && (
            <button
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm disabled:opacity-40"
              onClick={stop}
              disabled={stopping}
            >
              {stopping ? '停止中…' : '停止'}
            </button>
          )}
          {busy && deletingSessionId === null && (
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
              || deletingSessionId !== null
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

function QuestionCard({
  question,
  disabled,
  onAnswer,
}: {
  question: UserQuestion
  disabled: boolean
  onAnswer: (answer: string) => void
}) {
  const [customAnswer, setCustomAnswer] = useState('')
  const submitCustom = () => {
    const answer = customAnswer.trim()
    if (answer && !disabled) onAnswer(answer)
  }
  return (
    <div className="mb-2 rounded border border-violet-300 bg-violet-50 p-3 text-sm">
      <div className="mb-1 text-xs font-medium text-violet-600">{question.header}</div>
      <div className="mb-3 font-medium text-violet-950">{question.question}</div>
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        {question.options.map((option) => (
          <button
            key={option.label}
            className="rounded border border-violet-200 bg-white p-2 text-left hover:border-violet-400 disabled:opacity-40"
            disabled={disabled}
            onClick={() => onAnswer(option.label)}
          >
            <div className="font-medium text-violet-900">{option.label}</div>
            <div className="mt-0.5 text-xs text-violet-600">{option.description}</div>
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-violet-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-violet-400"
          value={customAnswer}
          disabled={disabled}
          placeholder="或者直接输入你的回答"
          onChange={(event) => setCustomAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitCustom()
          }}
        />
        <button
          className="rounded bg-violet-700 px-3 py-1.5 text-white disabled:opacity-40"
          disabled={disabled || !customAnswer.trim()}
          onClick={submitCustom}
        >
          回答
        </button>
      </div>
    </div>
  )
}

function BlockView({
  block,
  expanded,
  busy,
  checkpointRestoreToolUseId,
  onCheckpointRestoreChange,
  onToggle,
}: {
  block: Block
  expanded: boolean
  busy: boolean
  checkpointRestoreToolUseId: string | null
  onCheckpointRestoreChange: (toolUseId: string, pending: boolean) => void
  onToggle: () => void
}) {
  if (block.kind === 'user') {
    return (
      <div className="mb-2 rounded bg-neutral-200/60 px-3 py-2 text-sm">
        <UserImageGallery attachments={block.attachments} />
        <UserPdfGallery attachments={block.pdfAttachments} />
        <div className="whitespace-pre-wrap">{block.text}</div>
      </div>
    )
  }
  if (block.kind === 'text') {
    return (
      <div className="prose prose-sm prose-neutral mb-2 max-w-none px-3 py-2">
        <Streamdown>{block.text}</Streamdown>
      </div>
    )
  }
  if (block.kind === 'error') {
    return <div className="mb-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{block.text}</div>
  }
  if (block.kind === 'notice') {
    return <div className="mb-2 rounded bg-blue-50 px-3 py-2 text-xs text-blue-700">{block.text}</div>
  }
  if (block.kind === 'plan-replaced') {
    const completed = block.previous.items.filter((item) => item.status === 'completed').length
    return (
      <div className="mb-2 rounded border border-slate-200 bg-slate-50 text-xs text-slate-600">
        <button
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          onClick={onToggle}
        >
          <span>↪</span>
          <span className="min-w-0 flex-1 truncate">
            已归档未完成计划“{block.previous.goal}”（{completed}/{block.previous.items.length}）
          </span>
          <span className="text-slate-400">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <div className="space-y-1 border-t border-slate-200 px-3 py-2">
            <div>替换原因：{block.previous.summary}</div>
            <div>当前计划：{block.nextGoal}</div>
            {block.previous.items.map((item) => (
              <div key={item.id} className="text-slate-400">
                {item.id} [{item.status}] {item.title}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
  if (block.kind === 'peer') {
    return <PeerCard peer={block.peer} expanded={expanded} onToggle={onToggle} />
  }
  if (block.kind === 'candidate') {
    return <CandidateCard candidate={block.candidate} expanded={expanded} onToggle={onToggle} />
  }
  if (block.kind === 'thinking') {
    const streaming = block.durationMs === null
    const open = streaming || expanded
    return (
      <div className="mb-2">
        <button
          className="text-xs text-neutral-400 hover:text-neutral-600"
          onClick={() => !streaming && onToggle()}
        >
          {streaming ? '思考中…' : `思考了 ${(block.durationMs! / 1000).toFixed(1)}s ${open ? '▾' : '▸'}`}
        </button>
        {open && (
          <div className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-200 pl-3 text-xs text-neutral-400">
            {block.text}
          </div>
        )}
      </div>
    )
  }
  // tool
  const { call } = block
  const icon = call.status === 'running' ? '○' : call.status === 'error' ? '✗' : '✓'
  const summary = summarizeInput(call.input)
  return (
    <div className="mb-2 rounded border border-neutral-200 bg-white text-sm">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle}>
          <span className={call.status === 'error' ? 'text-red-500' : 'text-neutral-500'}>{icon}</span>
          <span className="font-medium">{call.name}</span>
          <span className="truncate text-xs text-neutral-400">{summary}</span>
        </button>
        {call.hasCheckpoint && call.status !== 'running' && (
          <RestoreButton
            toolUseId={call.id}
            busy={busy}
            pending={checkpointRestoreToolUseId === call.id}
            onPendingChange={onCheckpointRestoreChange}
          />
        )}
      </div>
      {call.attachments?.length ? (
        <div className="border-t border-neutral-100 px-3 pt-2">
          <UserImageGallery attachments={call.attachments} />
        </div>
      ) : null}
      {expanded && (call.result || call.progress) && (
        <pre className="max-h-64 overflow-auto border-t border-neutral-100 px-3 py-2 text-xs text-neutral-600">
          {call.result || call.progress}
        </pre>
      )}
    </div>
  )
}

function defaultDraftPrompt(imageCount: number, pdfCount: number): string {
  if (imageCount > 0 && pdfCount > 0) return '请分析这些附件。'
  if (imageCount > 0) return '请分析这些图片。'
  if (pdfCount > 0) return '请分析这些 PDF。'
  return ''
}

/** 回滚按钮：点击展开两种范围选择 */
function RestoreButton({
  toolUseId,
  busy,
  pending,
  onPendingChange,
}: {
  toolUseId: string
  busy: boolean
  pending: boolean
  onPendingChange: (toolUseId: string, pending: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const pendingRef = useRef(false)
  const restore = async (scope: 'files' | 'files-and-chat') => {
    if (pendingRef.current || busy) return
    pendingRef.current = true
    onPendingChange(toolUseId, true)
    setOpen(false)
    try {
      await window.whycode.sendCommand({ type: 'restore-checkpoint', toolUseId, scope })
    } finally {
      pendingRef.current = false
      onPendingChange(toolUseId, false)
    }
  }
  if (pending) {
    return (
      <button
        className="shrink-0 cursor-wait text-xs text-neutral-400"
        disabled
        aria-busy="true"
      >
        ○ 回滚中…
      </button>
    )
  }
  if (!open) {
    return (
      <button
        className="shrink-0 text-xs text-neutral-400 hover:text-neutral-700"
        disabled={busy}
        title="回滚到此操作执行前"
        onClick={() => setOpen(true)}
      >
        ⟲ 回滚
      </button>
    )
  }
  return (
    <span className="flex shrink-0 gap-1 text-xs">
      <button
        className="rounded border border-neutral-300 px-2 py-0.5"
        disabled={busy}
        onClick={() => void restore('files')}
      >
        仅文件
      </button>
      <button
        className="rounded border border-neutral-300 px-2 py-0.5"
        disabled={busy}
        onClick={() => void restore('files-and-chat')}
      >
        文件+对话
      </button>
      <button className="px-1 text-neutral-400" onClick={() => setOpen(false)}>
        ✕
      </button>
    </span>
  )
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

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.path === 'string') return obj.path
    if (typeof obj.pattern === 'string') return obj.pattern
    if (typeof obj.command === 'string') return obj.command
  }
  return JSON.stringify(input)
}
