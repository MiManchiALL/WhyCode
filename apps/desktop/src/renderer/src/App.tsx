import { useCallback, useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
// 注意：Renderer 只能从浏览器安全的子路径导入运行时值；从 '@whycode/core' 根导入值会把
// Node 内置模块拖进渲染端导致白屏（types 导入不受此限）
import { PERMISSION_MODES, type PermissionMode } from '@whycode/core/permissions'
import type { AgentStatus, CoreEvent } from '@whycode/core/events'
import { applyPeerEvent, createPeerBlock, PeerCard, voteLabel, type PeerBlockData } from './consensus-blocks.tsx'

interface ToolCall {
  id: string
  name: string
  input: unknown
  status: 'running' | 'done' | 'error'
  result?: string
  progress: string
  /** 有执行前快照，可回滚 */
  hasCheckpoint?: boolean
}

type Block =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; durationMs: number | null }
  | { kind: 'tool'; id: string; call: ToolCall }
  | { kind: 'notice'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'peer'; id: string; peer: PeerBlockData }

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
  const [blocks, setBlocks] = useState<Block[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [models, setModels] = useState<{ id: string; displayName: string; hasKey: boolean }[]>([])
  const [modelId, setModelId] = useState('')
  const [approval, setApproval] = useState<Approval | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [queued, setQueued] = useState<{ id: string; text: string }[]>([])
  const [permMode, setPermMode] = useState<PermissionMode>('default')
  const [consensus, setConsensus] = useState<{ ready: boolean; reason: string | null; enabled: boolean }>({ ready: false, reason: null, enabled: false })
  const nextId = useRef(0)
  const scrollRef = useRef<HTMLElement>(null)
  /** 贴底跟随：仅当用户本就在底部附近才自动滚动；往上翻阅时不打扰 */
  const stickToBottom = useRef(true)
  const [showJumpBottom, setShowJumpBottom] = useState(false)
  /** 发送用户消息时暂存的 block 位置，turn-start 到来时与 turnId 关联 */
  const pendingTurnStart = useRef<number | null>(null)
  /** turnId → turn 起点的 block 下标（文件+对话回滚时截断到这里） */
  const turnStartBlocks = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    void window.whycode.listModels().then((list) => {
      setModels(list)
      const first = list.find((m) => m.hasKey)
      if (first) setModelId(first.id)
    })
    void window.whycode.getProjectDir().then(setProjectDir)
    void window.whycode.consensusStatus().then(setConsensus)
  }, [])

  useEffect(() => {
    return window.whycode.onEvent((event: CoreEvent) => {
      switch (event.type) {
        case 'agent-status':
          setStatus(event.status)
          break
        case 'turn-start':
          if (pendingTurnStart.current !== null) {
            turnStartBlocks.current.set(event.turnId, pendingTurnStart.current)
            pendingTurnStart.current = null
          }
          break
        case 'message-queued':
          setQueued((prev) => [...prev, { id: event.id, text: event.text }])
          break
        case 'message-injected':
          setQueued((prev) => prev.filter((q) => q.id !== event.id))
          setBlocks((prev) => [
            ...prev,
            { kind: 'user', id: `b${nextId.current++}`, text: event.text },
          ])
          break
        case 'queue-restored':
          setQueued([])
          setInput((prev) => (prev ? `${prev}\n${event.text}` : event.text))
          break
        case 'text-delta':
          setBlocks((prev) => appendText(prev, event.text, nextId))
          break
        case 'thinking-delta':
          setBlocks((prev) => appendThinking(prev, event.text, nextId))
          break
        case 'thinking-end':
          setBlocks((prev) => endThinking(prev, event.durationMs))
          break
        case 'tool-start':
          setBlocks((prev) => [
            ...prev,
            {
              kind: 'tool',
              id: `b${nextId.current++}`,
              call: {
                id: event.toolUseId,
                name: event.toolName,
                input: event.input,
                status: 'running',
                progress: '',
              },
            },
          ])
          break
        case 'tool-progress':
          setBlocks((prev) => updateTool(prev, event.toolUseId, (c) => ({ ...c, progress: c.progress + event.output })))
          break
        case 'tool-end':
          setBlocks((prev) =>
            updateTool(prev, event.toolUseId, (c) => ({
              ...c,
              status: event.isError ? 'error' : 'done',
              result: String(event.result),
            })),
          )
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
        case 'checkpoint-created':
          setBlocks((prev) => updateTool(prev, event.toolUseId, (c) => ({ ...c, hasCheckpoint: true })))
          break
        case 'checkpoint-disabled':
          setBlocks((prev) => [
            ...prev,
            { kind: 'notice', id: `b${nextId.current++}`, text: `检查点已禁用：${event.reason}` },
          ])
          break
        case 'checkpoint-restored':
          setBlocks((prev) => {
            if (!event.ok) {
              return [...prev, { kind: 'error', id: `b${nextId.current++}`, text: `回滚失败：${event.error}` }]
            }
            let next = prev
            if (event.scope === 'files-and-chat') {
              // 截断到 turn 起点（含触发指令）；无记录时回退为工具卡片前最近的用户消息
              let idx = turnStartBlocks.current.get(event.turnId) ?? -1
              if (idx < 0) {
                const toolIdx = prev.findIndex((b) => b.kind === 'tool' && b.call.id === event.toolUseId)
                idx = toolIdx
                for (let i = toolIdx; i >= 0; i--) {
                  if (prev[i]!.kind === 'user') {
                    idx = i
                    break
                  }
                }
              }
              if (idx >= 0) next = prev.slice(0, idx)
            }
            return [
              ...next,
              {
                kind: 'notice',
                id: `b${nextId.current++}`,
                text: event.scope === 'files-and-chat' ? '已回滚：该轮对话与文件改动均已撤销' : '已回滚文件到该操作前（对话保留）',
              },
            ]
          })
          break
        case 'context-compacted':
          setBlocks((prev) => [
            ...prev,
            {
              kind: 'notice',
              id: `b${nextId.current++}`,
              text: `上下文已压缩（${event.level === 'full' ? '摘要' : '清理'}：${Math.round(event.preTokens / 1000)}k → ${Math.round(event.postTokens / 1000)}k tokens）`,
            },
          ])
          break
        case 'error':
          setBlocks((prev) => [...prev, { kind: 'error', id: `b${nextId.current++}`, text: event.message }])
          break
        // --- 多 Agent 协商（M3）---
        case 'peer-event':
          setBlocks((prev) => {
            const idx = prev.findLastIndex(
              (b) => b.kind === 'peer' && b.peer.agentId === event.agentId && b.peer.status === 'working',
            )
            if (idx < 0) {
              return [
                ...prev,
                { kind: 'peer', id: `b${nextId.current++}`, peer: applyPeerEvent(createPeerBlock(event.agentId), event.event) },
              ]
            }
            const block = prev[idx]! as Extract<Block, { kind: 'peer' }>
            const next = [...prev]
            next[idx] = { ...block, peer: applyPeerEvent(block.peer, event.event) }
            return next
          })
          break
        case 'vote-cast':
          setBlocks((prev) => {
            // B/C 的票落到自己的卡片上并收口；Main 的票（M3-c）走主线通知
            const idx = prev.findLastIndex(
              (b) => b.kind === 'peer' && b.peer.agentId === event.from && b.peer.status === 'working',
            )
            if (idx < 0) {
              return [
                ...prev,
                { kind: 'notice', id: `b${nextId.current++}`, text: `${event.from} 对 ${event.target} 投票 ${voteLabel(event.vote)}：${event.reason}` },
              ]
            }
            const block = prev[idx]! as Extract<Block, { kind: 'peer' }>
            const next = [...prev]
            next[idx] = {
              ...block,
              peer: {
                ...block.peer,
                status: 'done',
                vote: { vote: event.vote, reason: event.reason, suggestedChange: event.suggestedChange },
              },
            }
            return next
          })
          break
        case 'candidate-submitted':
          setBlocks((prev) => [
            ...prev,
            { kind: 'notice', id: `b${nextId.current++}`, text: `📋 候选 ${event.candidateId}（${event.agentId}）：${event.summary}` },
          ])
          break
        case 'negotiation-started':
          setBlocks((prev) => [
            ...prev,
            { kind: 'notice', id: `b${nextId.current++}`, text: `🤝 协商开始（${event.mode === 'quick_review' ? '快速评审' : '完整共识'}）：B/C 正在独立评审…` },
          ])
          break
        case 'negotiation-decided':
          setBlocks((prev) => [
            ...prev,
            { kind: 'notice', id: `b${nextId.current++}`, text: `⚖️ 协商决定（${event.selectedCandidateIds.join('、')}）：${event.reason}` },
          ])
          break
        case 'execution-started':
          setBlocks((prev) => [
            ...prev,
            { kind: 'notice', id: `b${nextId.current++}`, text: '▶ Main 进入执行阶段' },
          ])
          break
        default:
          break
      }
    })
  }, [])

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
        setBlocks([])
        void window.whycode.consensusStatus().then(setConsensus)
      }
    })
  }, [])

  const toggleConsensus = useCallback(() => {
    const enabled = !consensus.enabled
    void window.whycode
      .sendCommand({ type: 'set-consensus', enabled })
      .then((r) => {
        if (r && r.ok) setConsensus((prev) => ({ ...prev, enabled }))
      })
  }, [consensus.enabled])

  const send = useCallback((urgent = false) => {
    const text = input.trim()
    if (!text) return
    // 忙碌时不直接显示为用户消息——Main 会排队并回 message-queued 事件
    if (!busy) {
      setBlocks((prev) => {
        // 记录 turn 起点（用户消息之前），供「文件+对话」回滚截断
        pendingTurnStart.current = prev.length
        return [...prev, { kind: 'user', id: `b${nextId.current++}`, text }]
      })
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
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">WhyCode</span>
          <button
            className="max-w-96 truncate rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:border-neutral-500"
            onClick={pickProject}
            disabled={busy}
            title={projectDir ?? '选择要工作的项目目录'}
          >
            {projectDir ?? '📁 选择项目目录'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`rounded border px-2 py-1 text-xs disabled:opacity-40 ${
              consensus.enabled
                ? 'border-violet-400 bg-violet-50 text-violet-700'
                : 'border-neutral-300 text-neutral-500 hover:border-neutral-500'
            }`}
            onClick={toggleConsensus}
            disabled={busy || (!consensus.enabled && !consensus.ready)}
            title={
              consensus.enabled
                ? '多 Agent 协商已开启：Main 提案，B/C 独立评审'
                : consensus.reason ?? '开启多 Agent 协商：Main 提案，B/C 独立评审后再执行'
            }
          >
            🤝 协商{consensus.enabled ? '·开' : ''}
          </button>
          <button
            className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:border-neutral-500 disabled:opacity-40"
            onClick={() => {
              setBlocks((prev) => [
                ...prev,
                { kind: 'notice', id: `b${nextId.current++}`, text: '正在压缩上下文（生成摘要中，可点停止取消）…' },
              ])
              void window.whycode.sendCommand({ type: 'compact' })
            }}
            disabled={busy}
            title="手动压缩上下文：把较早的对话浓缩为摘要，释放上下文空间"
          >
            🗜 压缩
          </button>
          <select
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
            value={permMode}
            onChange={(e) => {
              const mode = e.target.value as PermissionMode
              setPermMode(mode)
              void window.whycode.sendCommand({ type: 'set-permission-mode', mode })
            }}
            title="权限档位：控制哪些操作需要审批"
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <select
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
            value={modelId}
            onChange={(e) => {
              const prev = modelId
              const next = e.target.value
              setModelId(next)
              void window.whycode
                .sendCommand({ type: 'set-model', modelId: next })
                .then((r) => {
                  // 切换失败（如没配 key）回退选择，避免下拉框与实际模型不一致
                  if (!r || !r.ok) setModelId(prev)
                })
            }}
            disabled={busy}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.hasKey}>
                {m.displayName}
                {m.hasKey ? '' : '（未配置 key）'}
              </option>
            ))}
          </select>
        </div>
      </header>

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
            expanded={expanded.has(b.id)}
            onToggle={() => toggle(b.id)}
          />
        ))}
        {approval && (
          <ApprovalCard approval={approval} onRespond={respondApproval} />
        )}
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
            placeholder={busy ? '工作中——Enter 排队插话，Ctrl+Enter 立即插话' : projectDir ? '输入消息…' : '纯聊天模式，输入消息…'}
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
          <RestoreButton toolUseId={call.id} />
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
function RestoreButton({ toolUseId }: { toolUseId: string }) {
  const [open, setOpen] = useState(false)
  const restore = (scope: 'files' | 'files-and-chat') => {
    setOpen(false)
    void window.whycode.sendCommand({ type: 'restore-checkpoint', toolUseId, scope })
  }
  if (!open) {
    return (
      <button
        className="shrink-0 text-xs text-neutral-400 hover:text-neutral-700"
        title="回滚到此操作执行前"
        onClick={() => setOpen(true)}
      >
        ⟲ 回滚
      </button>
    )
  }
  return (
    <span className="flex shrink-0 gap-1 text-xs">
      <button className="rounded border border-neutral-300 px-2 py-0.5" onClick={() => restore('files')}>
        仅文件
      </button>
      <button className="rounded border border-neutral-300 px-2 py-0.5" onClick={() => restore('files-and-chat')}>
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

// --- 事件应用到 blocks 的纯函数（保持 reducer 简单） ---

type IdRef = { current: number }

function appendText(prev: Block[], text: string, id: IdRef): Block[] {
  const last = prev.at(-1)
  if (last?.kind === 'text') {
    return [...prev.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...prev, { kind: 'text', id: `b${id.current++}`, text }]
}

function appendThinking(prev: Block[], text: string, id: IdRef): Block[] {
  const last = prev.at(-1)
  if (last?.kind === 'thinking' && last.durationMs === null) {
    return [...prev.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...prev, { kind: 'thinking', id: `b${id.current++}`, text, durationMs: null }]
}

function endThinking(prev: Block[], durationMs: number): Block[] {
  const last = prev.at(-1)
  if (last?.kind === 'thinking' && last.durationMs === null) {
    return [...prev.slice(0, -1), { ...last, durationMs }]
  }
  return prev
}

function updateTool(prev: Block[], toolId: string, fn: (c: ToolCall) => ToolCall): Block[] {
  return prev.map((b) =>
    b.kind === 'tool' && b.call.id === toolId ? { ...b, call: fn(b.call) } : b,
  )
}
