import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentStatus, CoreEvent } from '@whycode/core'

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

/**
 * 骨架版主界面：单会话消息流 + 输入框，验证 IPC 事件链路。
 * M1-b 起按文档一 §3.4 逐步替换为正式组件（thinking 折叠、工具卡片等）。
 */
export function App() {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<AgentStatus>('idle')
  const nextId = useRef(0)

  useEffect(() => {
    return window.whycode.onEvent((event: CoreEvent) => {
      if (event.type === 'agent-status') {
        setStatus(event.status)
      } else if (event.type === 'text-delta') {
        setMessages((prev) => {
          const last = prev.at(-1)
          if (last?.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, text: last.text + event.text }]
          }
          return [
            ...prev,
            { id: `m${nextId.current++}`, role: 'assistant', text: event.text },
          ]
        })
      }
    })
  }, [])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || status !== 'idle') return
    setMessages((prev) => [
      ...prev,
      { id: `m${nextId.current++}`, role: 'user', text },
    ])
    setInput('')
    void window.whycode.sendCommand({ type: 'user-message', text })
  }, [input, status])

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <main className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <p className="mt-24 text-center text-sm text-neutral-400">
            WhyCode 骨架已就绪，输入消息验证 IPC 链路
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`mb-1 w-full rounded px-3 py-2 text-sm ${
              m.role === 'user' ? 'bg-neutral-200/60' : 'bg-transparent'
            }`}
          >
            {m.text}
          </div>
        ))}
      </main>
      <footer className="border-t border-neutral-200 p-4">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={status === 'idle' ? '输入消息…' : '处理中…'}
            disabled={status !== 'idle'}
          />
          <button
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
            onClick={send}
            disabled={status !== 'idle' || !input.trim()}
          >
            发送
          </button>
        </div>
      </footer>
    </div>
  )
}
