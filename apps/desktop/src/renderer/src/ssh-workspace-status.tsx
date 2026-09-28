import { useCallback, useEffect, useRef, useState } from 'react'
import type { SshConnection, SshConnectionInput } from '../../shared/ssh.ts'
import { SshConnectionEditor } from './ssh-connection-editor.tsx'
import { useConversationFeedback } from './conversation-feedback.tsx'

/** 历史可离线阅读；状态查询不连接服务器，重连由用户操作发起。 */
export function SshWorkspaceStatus({ target }: { target: string }) {
  const [connection, setConnection] = useState<SshConnection | null>(null)
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [editor, setEditor] = useState<SshConnection | null>(null)
  const feedback = useConversationFeedback()
  const generation = useRef(0)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const result = await window.whycode.ssh({ action: 'resolve', target })
      if (current !== generation.current) return
      if (!result.ok) throw new Error(result.error)
      setConnection(result.connection ?? null)
    } catch (error) {
      if (current === generation.current) feedback('error', error instanceof Error ? error.message : String(error))
    } finally { if (current === generation.current) setLoading(false) }
  }, [target, feedback])
  useEffect(() => {
    mounted.current = true
    const reload = () => { void refresh() }
    reload()
    const unsubscribe = window.whycode.onSshChanged(reload)
    window.addEventListener('focus', reload)
    return () => { mounted.current = false; generation.current++; unsubscribe(); window.removeEventListener('focus', reload) }
  }, [refresh])
  const connect = async (selected: SshConnection) => {
    if (connecting) return
    setConnecting(true)
    try {
      const result = await window.whycode.ssh({ action: 'connect', id: selected.id })
      if (!mounted.current) return
      if (!result.ok) {
        if (result.credentialsRequired) {
          setEditor(selected)
          if (editor) feedback('error', result.error, true)
        }
        else throw new Error(result.error)
      } else if (result.connect?.status === 'connected') setEditor(null)
      else throw new Error('请在 SSH 设置中确认服务器指纹')
    } catch (error) { if (mounted.current) feedback('error', error instanceof Error ? error.message : String(error), Boolean(editor)) }
    finally { if (mounted.current) { setConnecting(false); await refresh() } }
  }
  const save = async (value: SshConnectionInput) => {
    try {
      const result = await window.whycode.ssh({ action: 'save', connection: value })
      if (!mounted.current) return
      if (!result.ok) throw new Error(result.error)
      if (result.connection) await connect(result.connection)
    } catch (error) { if (mounted.current) feedback('error', error instanceof Error ? error.message : String(error), true) }
  }
  const label = loading ? 'SSH' : connecting ? 'SSH · 连接中' : connection?.connected
    ? 'SSH · 已连接' : connection ? 'SSH · 未连接' : 'SSH · 未配置'
  return <>
    <button type="button" className="wc-focus-ring shrink-0 rounded-lg bg-[var(--wc-blue)] px-2 py-1 wc-type-tiny text-[var(--wc-blue-ink)] disabled:cursor-default"
      disabled={loading || connecting || !connection || connection.connected}
      aria-label={connection?.connected ? 'SSH 已连接' : '连接 SSH'}
      title={connection?.connected ? connection.name : connection ? '连接服务器' : '原连接已删除，可在设置中重新添加原服务器'}
      onClick={() => connection && void connect(connection)}>{label}</button>
    {editor && <SshConnectionEditor connection={editor} purpose="connect" onClose={() => setEditor(null)} onSave={save} />}
  </>
}
