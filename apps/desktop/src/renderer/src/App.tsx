import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStatus, CoreEvent } from '@whycode/core'

type Block =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; durationMs: number | null }
  | { kind: 'error'; id: string; text: string }

/**
 * M1-b 主界面：流式文本 + thinking 折叠块（流式展开、完毕自动折叠）+ 模型选择 + 中断。
 * 正式组件化（Streamdown/shadcn）在 M1 后半段引入。
 */
export function App() {
  const [blocks, setBlocks] = useState<Block[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<AgentStatus>('idle')
  const [models, setModels] = useState<{ id: string; displayName: string }[]>([])
  const [modelId, setModelId] = useState('')
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const nextId = useRef(0)
  const scrollRef = useRef<HTMLElement>(null)

  useEffect(() => {
    void window.whycode.listModels().then((list) => {
      setModels(list)
      if (list[0]) setModelId(list[0].id)
    })
  }, [])

  useEffect(() => {
    return window.whycode.onEvent((event: CoreEvent) => {
      switch (event.type) {
        case 'agent-status':
          setStatus(event.status)
          break
        case 'text-delta':
          setBlocks((prev) => {
            const last = prev.at(-1)
            if (last?.kind === 'text') {
              return [...prev.slice(0, -1), { ...last, text: last.text + event.text }]
            }
            return [
              ...prev,
              { kind: 'text', id: `b${nextId.current++}`, text: event.text },
            ]
          })
          break
        case 'thinking-delta':
          setBlocks((prev) => {
            const last = prev.at(-1)
            if (last?.kind === 'thinking' && last.durationMs === null) {
              return [...prev.slice(0, -1), { ...last, text: last.text + event.text }]
            }
            return [
              ...prev,
              {
                kind: 'thinking',
                id: `b${nextId.current++}`,
                text: event.text,
                durationMs: null,
              },
            ]
          })
          break
        case 'thinking-end':
          setBlocks((prev) => {
            const last = prev.at(-1)
            if (last?.kind === 'thinking' && last.durationMs === null) {
              return [...prev.slice(0, -1), { ...last, durationMs: event.durationMs }]
            }
            return prev
          })
          break
        case 'error':
          setBlocks((prev) => [
            ...prev,
            { kind: 'error', id: `b${nextId.current++}`, text: event.message },
          ])
          break
        default:
          break
      }
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [blocks])

  const busy = status !== 'idle' && status !== 'error'

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || busy) return
    setBlocks((prev) => [
      ...prev,
      { kind: 'user', id: `b${nextId.current++}`, text },
    ])
    setInput('')
    void window.whycode.sendCommand({ type: 'user-message', text })
  }, [input, busy])

  const abort = useCallback(() => {
    void window.whycode.sendCommand({ type: 'abort' })
  }, [])

  const changeModel = useCallback((id: string) => {
    setModelId(id)
    void window.whycode.sendCommand({ type: 'set-model', modelId: id })
  }, [])

  const toggleThinking = useCallback((id: string) => {
    setExpandedThinking((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
        <span className="text-sm font-medium">WhyCode</span>
        <select
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
          value={modelId}
          onChange={(e) => changeModel(e.target.value)}
          disabled={busy}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </header>

      <main ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {blocks.length === 0 && (
          <p className="mt-24 text-center text-sm text-neutral-400">
            与 WhyCode 对话（当前为纯文本模式，工具能力开发中）
          </p>
        )}
        {blocks.map((b) => {
          if (b.kind === 'user') {
            return (
              <div key={b.id} className="mb-2 rounded bg-neutral-200/60 px-3 py-2 text-sm">
                {b.text}
              </div>
            )
          }
          if (b.kind === 'thinking') {
            const streaming = b.durationMs === null
            const expanded = streaming || expandedThinking.has(b.id)
            return (
              <div key={b.id} className="mb-2">
                <button
                  className="text-xs text-neutral-400 hover:text-neutral-600"
                  onClick={() => !streaming && toggleThinking(b.id)}
                >
                  {streaming
                    ? '思考中…'
                    : `思考了 ${(b.durationMs! / 1000).toFixed(1)}s ${expanded ? '▾' : '▸'}`}
                </button>
                {expanded && (
                  <div className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-200 pl-3 text-xs text-neutral-400">
                    {b.text}
                  </div>
                )}
              </div>
            )
          }
          if (b.kind === 'error') {
            return (
              <div key={b.id} className="mb-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
                {b.text}
              </div>
            )
          }
          return (
            <div key={b.id} className="mb-2 whitespace-pre-wrap px-3 py-2 text-sm">
              {b.text}
            </div>
          )
        })}
      </main>

      <footer className="border-t border-neutral-200 p-4">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={busy ? '处理中…' : '输入消息…'}
            disabled={busy}
          />
          {busy ? (
            <button
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm"
              onClick={abort}
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
