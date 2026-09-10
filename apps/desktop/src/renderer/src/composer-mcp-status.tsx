import { useEffect, useRef, useState, type RefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Plug, RefreshCw, X } from 'lucide-react'
import type { McpConnectionStatus } from '../../shared/settings.ts'

const CONNECTION_LABELS: Record<McpConnectionStatus['state'], string> = {
  idle: '未连接',
  connecting: '连接中',
  refreshing: '已连接 · 更新中',
  ready: '已连接',
  failed: '连接失败',
  disconnected: '已断开',
}

export function ComposerMcpStatus({ runtimeId, composerRef, onClose }: {
  runtimeId: string
  composerRef: RefObject<HTMLTextAreaElement | null>
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{
    servers: McpConnectionStatus[]
    loading: boolean
    error: string | null
  }>({ servers: [], loading: true, error: null })

  useEffect(() => {
    let disposed = false
    setState((current) => ({ ...current, loading: true, error: null }))
    void window.whycode.mcpStatus(runtimeId).then((servers) => {
      if (!disposed) setState({ servers, loading: false, error: null })
    }).catch((error: unknown) => {
      if (!disposed) setState({
        servers: [], loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return () => { disposed = true }
  }, [runtimeId, revision])

  return (
    <Dialog.Root open modal={false} onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Content
        ref={panelRef}
        className="wc-menu-content absolute bottom-full left-0 z-30 mb-2 w-full min-w-0 overflow-hidden p-0"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (document.activeElement === document.body
            || panelRef.current?.contains(document.activeElement)) composerRef.current?.focus()
        }}
        onEscapeKeyDown={(event) => { if (event.isComposing) event.preventDefault() }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--wc-line)] px-3 py-2 text-xs text-[var(--wc-muted)]">
          <Plug size={14} aria-hidden="true" />
          <Dialog.Title className="min-w-0 flex-1 font-medium">MCP 服务器状态</Dialog.Title>
          <button
            type="button"
            className="wc-icon-button size-7"
            title="刷新状态"
            aria-label="刷新 MCP 状态"
            disabled={state.loading}
            onClick={() => setRevision((current) => current + 1)}
          >
            <RefreshCw size={13} className={state.loading ? 'animate-spin' : ''} />
          </button>
          <Dialog.Close className="wc-icon-button size-7" aria-label="关闭 MCP 状态">
            <X size={14} />
          </Dialog.Close>
        </div>
        <div className="wc-scrollbar max-h-[min(18rem,45vh)] overflow-y-auto p-3 text-xs" aria-busy={state.loading}>
          {state.error ? (
            <p role="alert" className="break-words text-[var(--wc-danger)]">{state.error}</p>
          ) : state.servers.length === 0 ? (
            <p role="status" className="text-[var(--wc-faint)]">
              {state.loading ? '正在读取服务器状态…' : '当前会话没有可用的 MCP 服务器'}
            </p>
          ) : (
            <ul className="space-y-3">
              {state.servers.map((server) => (
                <li key={`${server.scope}:${server.name}`} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-[var(--wc-ink)]" title={server.name}>
                    {server.name}
                    <span className="ml-2 wc-type-tiny text-[var(--wc-faint)]">
                      {server.scope === 'project' ? '项目' : '全局'}
                    </span>
                  </span>
                  <span className={`shrink-0 ${server.state === 'ready' || server.state === 'refreshing'
                    ? 'text-[var(--wc-sage-ink)]' : 'text-[var(--wc-muted)]'}`}>
                    {CONNECTION_LABELS[server.state]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}
