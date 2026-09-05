import { useEffect, useRef, useState } from 'react'
import type { TerminalInfo } from '../../shared/terminal.ts'

let views: Promise<typeof import('./terminal-view.ts')> | undefined

export function loadTerminalViews() {
  return views ??= import('./terminal-view.ts')
}

export function disposeTerminalView(terminalId: string): void {
  void views?.then((module) => module.disposeTerminalView(terminalId))
}

export function TerminalPanel({ terminal, active }: { terminal: TerminalInfo; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let detach: (() => void) | undefined
    void loadTerminalViews().then((module) => {
      if (!cancelled && host.current) detach = module.attachTerminal(terminal, host.current)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { cancelled = true; detach?.() }
  }, [terminal, active])
  return error
    ? <div role="alert" className="p-4 text-sm text-[var(--wc-danger)]">终端显示失败：{error}</div>
    : <div ref={host} className="wc-terminal min-h-0 min-w-0 flex-1 overflow-hidden p-2" aria-label={terminal.title} />
}
