import { useCallback, useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
// 注意：Renderer 只能从浏览器安全的子路径导入运行时值；从 '@whycode/core' 根导入值会把
// Node 内置模块拖进渲染端导致白屏（types 导入不受此限）
import type { PermissionMode } from '@whycode/core/permissions'
import type { AgentStatus, CoreEvent } from '@whycode/core/events'
import type { SessionListItem } from '../../shared/session.ts'
import {
  applyCoreEvent,
  appendNotice,
  appendUserMessage,
  createConversationState,
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
  const [models, setModels] = useState<{ id: string; displayName: string; hasKey: boolean }[]>([])
  const [modelId, setModelId] = useState('')
  const [approval, setApproval] = useState<Approval | null>(null)
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [queued, setQueued] = useState<{ id: string; text: string }[]>([])
  const [permMode, setPermMode] = useState<PermissionMode>('default')
  const [consensus, setConsensus] = useState<{ ready: boolean; reason: string | null; enabled: boolean }>({ ready: false, reason: null, enabled: false })
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [showSessions, setShowSessions] = useState(false)
  /** 协商进行中的状态条文案（null = 无协商） */
  const [negoStatus, setNegoStatus] = useState<string | null>(null)
  const scrollRef = useRef<HTMLElement>(null)
  /** 贴底跟随：仅当用户本就在底部附近才自动滚动；往上翻阅时不打扰 */
  const stickToBottom = useRef(true)
  const [showJumpBottom, setShowJumpBottom] = useState(false)
  const blocks = view.blocks

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.whycode.listSessions())
    } catch {
      setSessions([])
    }
  }, [])

  useEffect(() => {
    void window.whycode.listModels().then((list) => {
      setModels(list)
      const first = list.find((m) => m.hasKey)
      if (first) setModelId(first.id)
    })
    void window.whycode.getProjectDir().then(setProjectDir)
    void window.whycode.consensusStatus().then(setConsensus)
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    return window.whycode.onEvent((event: CoreEvent) => {
      setView((previous) => applyCoreEvent(previous, event))
      switch (event.type) {
        case 'agent-status':
          setStatus(event.status)
          // 空闲 = 一切结束（中止/异常兜底），协商状态条不残留
          if (event.status === 'idle') setNegoStatus(null)
          break
        case 'turn-end':
          void refreshSessions()
          break
        case 'message-queued':
          setQueued((prev) => [...prev, { id: event.id, text: event.text }])
          break
        case 'message-injected':
          setQueued((prev) => prev.filter((q) => q.id !== event.id))
          break
        case 'queue-restored':
          setQueued([])
          setInput((prev) => (prev ? `${prev}\n${event.text}` : event.text))
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
    })
  }, [refreshSessions])

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

  const pickProject = useCallback(() => {
    void window.whycode.pickProjectDir().then((dir) => {
      if (dir) {
        setProjectDir(dir)
        setView(createConversationState())
        void window.whycode.consensusStatus().then(setConsensus)
        void refreshSessions()
      }
    })
  }, [refreshSessions])

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
    setQueued([])
    setApproval(null)
    setStatus('idle')
    setNegoStatus(null)
    stickToBottom.current = true
    setShowJumpBottom(false)
  }, [])

  const addError = useCallback((text: string) => {
    setView((previous) =>
      applyCoreEvent(previous, { type: 'error', message: text, recoverable: true }),
    )
  }, [])

  const startNewSession = useCallback(() => {
    void window.whycode.newSession().then((result) => {
      if (!result.ok) return addError(result.error ?? '新建会话失败')
      resetView()
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
      setApproval(null)
      setStatus('idle')
      setNegoStatus(null)
      stickToBottom.current = true
      setShowJumpBottom(false)
      setProjectDir(result.session.projectDir)
      if (models.some((model) => model.id === result.session.modelId && model.hasKey)) {
        setModelId(result.session.modelId)
      }
      setShowSessions(false)
      void window.whycode.consensusStatus().then(setConsensus)
      void refreshSessions()
    })
  }, [addError, models, refreshSessions])

  const deleteSession = useCallback((sessionId: string) => {
    if (!window.confirm('确定删除这个会话？此操作不会修改项目文件。')) return
    void window.whycode.deleteSession(sessionId).then((result) => {
      if (!result.ok) return addError(result.error ?? '删除会话失败')
      if (result.deletedCurrent) {
        resetView()
        setProjectDir(null)
        setShowSessions(false)
        void window.whycode.consensusStatus().then(setConsensus)
      }
      void refreshSessions()
    })
  }, [addError, refreshSessions, resetView])

  const compact = useCallback(() => {
    setView((previous) =>
      appendNotice(previous, '正在压缩上下文（生成摘要中，可点停止取消）…'),
    )
    void window.whycode.sendCommand({ type: 'compact' })
  }, [])

  const changePermission = useCallback((mode: PermissionMode) => {
    setPermMode(mode)
    void window.whycode.sendCommand({ type: 'set-permission-mode', mode })
  }, [])

  const changeModel = useCallback((next: string) => {
    const previous = modelId
    setModelId(next)
    void window.whycode.sendCommand({ type: 'set-model', modelId: next }).then((result) => {
      if (!result || !result.ok) setModelId(previous)
    })
  }, [modelId])

  const send = useCallback((urgent = false) => {
    const text = input.trim()
    if (!text) return
    // 忙碌时不直接显示为用户消息——Main 会排队并回 message-queued 事件
    if (!busy) {
      setView((previous) => appendUserMessage(previous, text, true))
    }
    setInput('')
    // 自己发消息 = 主动行为，恢复贴底跟随
    stickToBottom.current = true
    setShowJumpBottom(false)
    void window.whycode.sendCommand({ type: 'user-message', text, urgent })
  }, [input, busy])

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

  return (
    <div className="relative flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <AppHeader
        projectDir={projectDir}
        busy={busy}
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
      />

      {showSessions && (
        <SessionPanel
          sessions={sessions}
          busy={busy}
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
              : '纯聊天模式：可直接对话；选择项目目录后解锁文件与命令能力'}
          </p>
        )}
        {blocks.map((b) => (
          <BlockView
            key={b.id}
            block={b}
            expanded={view.expanded.has(b.id)}
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
              <div key={q.id} className="truncate rounded bg-neutral-100 px-3 py-1 text-xs text-neutral-400">
                ⏳ 已排队 · {q.text}
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // Enter=排队（等当前步骤结束注入）；Ctrl+Enter=立即插话（打断当前步骤）
              send(e.ctrlKey)
            }}
            placeholder={
              status === 'waiting-approval'
                ? '⏸ Agent 在等你审批上方的请求…'
                : busy
                  ? '工作中——Enter 排队插话，Ctrl+Enter 立即插话'
                  : projectDir
                    ? '输入消息…'
                    : '纯聊天模式，输入消息…'
            }
          />
          {busy && (
            <button
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm"
              onClick={() => window.whycode.sendCommand({ type: 'abort' })}
            >
              停止
            </button>
          )}
          {busy && (
            <button
              className="rounded-md border border-amber-400 px-3 py-2 text-sm text-amber-700 disabled:opacity-40"
              onClick={() => send(true)}
              disabled={!input.trim()}
              title="打断当前步骤，立即插话"
            >
              立即
            </button>
          )}
          <button
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
            onClick={() => send(false)}
            disabled={!input.trim()}
          >
            {busy ? '排队' : '发送'}
          </button>
        </div>
      </footer>
    </div>
  )
}

function BlockView({
  block,
  expanded,
  onToggle,
}: {
  block: Block
  expanded: boolean
  onToggle: () => void
}) {
  if (block.kind === 'user') {
    return <div className="mb-2 rounded bg-neutral-200/60 px-3 py-2 text-sm">{block.text}</div>
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
            coverage={call.checkpointCoverage ?? 'complete'}
            warning={call.checkpointWarning}
          />
        )}
      </div>
      {expanded && (call.result || call.progress) && (
        <pre className="max-h-64 overflow-auto border-t border-neutral-100 px-3 py-2 text-xs text-neutral-600">
          {call.result || call.progress}
        </pre>
      )}
    </div>
  )
}

/** 回滚按钮：点击展开两种范围选择 */
function RestoreButton({
  toolUseId,
  coverage,
  warning,
}: {
  toolUseId: string
  coverage: 'complete' | 'partial'
  warning?: string
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => () => {
    mountedRef.current = false
  }, [])
  const restore = async (scope: 'files' | 'files-and-chat') => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setOpen(false)
    try {
      await window.whycode.sendCommand({ type: 'restore-checkpoint', toolUseId, scope })
    } finally {
      pendingRef.current = false
      if (mountedRef.current) setPending(false)
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
        title={warning ?? '回滚到此操作执行前'}
        onClick={() => setOpen(true)}
      >
        ⟲ {coverage === 'partial' ? '有限回滚' : '回滚'}
      </button>
    )
  }
  return (
    <span className="flex shrink-0 gap-1 text-xs">
      <button className="rounded border border-neutral-300 px-2 py-0.5" onClick={() => void restore('files')}>
        仅文件
      </button>
      {coverage === 'complete' && (
        <button className="rounded border border-neutral-300 px-2 py-0.5" onClick={() => void restore('files-and-chat')}>
          文件+对话
        </button>
      )}
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
