import { useCallback, useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import type { AgentStatus, CoreEvent } from '@whycode/core'

interface ToolCall {
  id: string
  name: string
  input: unknown
  status: 'running' | 'done' | 'error'
  result?: string
  progress: string
}

type Block =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; durationMs: number | null }
  | { kind: 'tool'; id: string; call: ToolCall }
  | { kind: 'error'; id: string; text: string }

interface Approval {
  requestId: string
  toolName: string
  input: unknown
  diff?: string
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
  const nextId = useRef(0)
  const scrollRef = useRef<HTMLElement>(null)

  useEffect(() => {
    void window.whycode.listModels().then((list) => {
      setModels(list)
      const first = list.find((m) => m.hasKey)
      if (first) setModelId(first.id)
    })
    void window.whycode.getProjectDir().then(setProjectDir)
  }, [])

  useEffect(() => {
    return window.whycode.onEvent((event: CoreEvent) => {
      switch (event.type) {
        case 'agent-status':
          setStatus(event.status)
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
            diff: event.diff,
          })
          break
        case 'error':
          setBlocks((prev) => [...prev, { kind: 'error', id: `b${nextId.current++}`, text: event.message }])
          break
        default:
          break
      }
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [blocks, approval])

  const busy = status !== 'idle' && status !== 'error'

  const pickProject = useCallback(() => {
    void window.whycode.pickProjectDir().then((dir) => {
      if (dir) {
        setProjectDir(dir)
        setBlocks([])
      }
    })
  }, [])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || busy) return
    setBlocks((prev) => [...prev, { kind: 'user', id: `b${nextId.current++}`, text }])
    setInput('')
    void window.whycode.sendCommand({ type: 'user-message', text })
  }, [input, busy])

  const respondApproval = useCallback((approved: boolean) => {
    if (!approval) return
    void window.whycode.sendCommand({
      type: 'approval-response',
      requestId: approval.requestId,
      approved,
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
      </header>

      <main ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {blocks.length === 0 && (
          <p className="mt-24 text-center text-sm text-neutral-400">
            {projectDir
              ? '与 WhyCode 对话，它能读写文件、执行命令（写操作需你确认）'
              : '先选择项目目录，然后开始对话'}
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

      <footer className="border-t border-neutral-200 p-4">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={busy ? '处理中…' : projectDir ? '输入消息…' : '先选择项目目录'}
            disabled={busy || !projectDir}
          />
          {busy ? (
            <button
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm"
              onClick={() => window.whycode.sendCommand({ type: 'abort' })}
            >
              停止
            </button>
          ) : (
            <button
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
              onClick={send}
              disabled={!input.trim()}
            >
              发送
            </button>
          )}
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
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={onToggle}
      >
        <span className={call.status === 'error' ? 'text-red-500' : 'text-neutral-500'}>{icon}</span>
        <span className="font-medium">{call.name}</span>
        <span className="truncate text-xs text-neutral-400">{summary}</span>
      </button>
      {expanded && (call.result || call.progress) && (
        <pre className="max-h-64 overflow-auto border-t border-neutral-100 px-3 py-2 text-xs text-neutral-600">
          {call.result || call.progress}
        </pre>
      )}
    </div>
  )
}

function ApprovalCard({
  approval,
  onRespond,
}: {
  approval: Approval
  onRespond: (approved: boolean) => void
}) {
  return (
    <div className="mb-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="mb-2 font-medium text-amber-800">
        请求执行：{approval.toolName}
      </div>
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
      <div className="flex gap-2">
        <button
          className="rounded bg-neutral-900 px-3 py-1 text-xs text-white"
          onClick={() => onRespond(true)}
        >
          批准
        </button>
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
