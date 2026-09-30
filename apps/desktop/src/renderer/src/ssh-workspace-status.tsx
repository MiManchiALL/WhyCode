import { useEffect, useRef, useState } from 'react'
import type { SshConnection, SshConnectionInput, SshConnectionSnapshot } from '../../shared/ssh.ts'
import { SshConnectionEditor } from './ssh-connection-editor.tsx'
import { useConversationFeedback } from './conversation-feedback.tsx'

/** 历史可离线阅读；状态查询不连接服务器，重连由用户操作发起。 */
export function SshWorkspaceStatus({ connection, loading }: { connection: SshConnectionSnapshot | null; loading: boolean }) {
  const [editor, setEditor] = useState<SshConnection | null>(null)
  const feedback = useConversationFeedback()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const connect = async (selected: SshConnection) => {
    try {
      const result = await window.whycode.ssh({ action: 'connect', id: selected.id })
      if (!result.ok) {
        if (result.credentialsRequired) {
          if (mounted.current) setEditor(selected)
          if (selected.hasSecret || !mounted.current) feedback('error', result.error, true)
        }
        else throw new Error(result.error)
      } else if (result.connect?.status !== 'connected') throw new Error('请在 SSH 设置中确认服务器指纹')
    } catch (error) { feedback('error', error instanceof Error ? error.message : String(error), true) }
  }
  const save = async (value: SshConnectionInput) => {
    try {
      const result = await window.whycode.ssh({ action: 'save', connection: value })
      if (!result.ok) throw new Error(result.error)
      if (mounted.current) setEditor(null)
      if (result.connection) void connect(result.connection)
    } catch (error) { feedback('error', error instanceof Error ? error.message : String(error), true) }
  }
  const connected = connection?.status === 'connected'
  const label = loading ? 'SSH' : connection?.status === 'connecting' ? 'SSH · 连接中' : connected
    ? 'SSH · 已连接' : connection?.status === 'releasing' ? 'SSH · 清理中' : connection ? 'SSH · 未连接' : 'SSH · 未配置'
  return <>
    <button type="button" className={`wc-focus-ring shrink-0 rounded-lg px-2 py-1 wc-type-tiny disabled:cursor-default ${connected
      ? 'bg-[var(--wc-sage)] text-[var(--wc-sage-ink)]' : 'bg-[var(--wc-blue)] text-[var(--wc-blue-ink)]'}`}
      disabled={loading || !connection || connection.status !== 'disconnected'}
      aria-label={connected ? 'SSH 已连接' : connection?.status === 'connecting' ? 'SSH 连接中' : '连接 SSH'}
      title={connected ? connection.name : connection ? '连接服务器' : '原连接已删除，可在设置中重新添加原服务器'}
      onClick={() => connection && void connect(connection)}>{label}</button>
    {editor && <SshConnectionEditor connection={editor} purpose="connect" onClose={() => setEditor(null)} onSave={save} />}
  </>
}
