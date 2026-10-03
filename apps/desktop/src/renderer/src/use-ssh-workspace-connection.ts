import { useCallback, useEffect, useRef, useState } from 'react'
import { sshMessageUnavailableReason, type SshConnectionSnapshot } from '../../shared/ssh.ts'

/** Header 和发送入口共用宿主快照；切换会话不把旧服务器状态带入新草稿。 */
export function useSshWorkspaceConnection(target: string | null, onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<{ target: string; connection: SshConnectionSnapshot | null } | null>(null)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (!target) return
    const current = ++generation.current
    try {
      const result = await window.whycode.ssh({ action: 'resolve', target })
      if (current !== generation.current) return
      if (!result.ok) throw new Error(result.error)
      setSnapshot({ target, connection: result.connection ?? null })
    } catch (error) {
      if (current === generation.current) {
        setSnapshot(previous => previous?.target === target ? previous : { target, connection: null })
        onError(error instanceof Error ? error.message : String(error))
      }
    }
  }, [target, onError])
  useEffect(() => {
    if (!target) return
    const reload = () => { void refresh() }
    const unsubscribe = window.whycode.onSshChanged(reload)
    reload()
    window.addEventListener('focus', reload)
    return () => { generation.current++; unsubscribe(); window.removeEventListener('focus', reload) }
  }, [target, refresh])
  const connection = snapshot?.target === target ? snapshot.connection : null
  const loading = target !== null && snapshot?.target !== target
  return { connection, loading, sendUnavailableReason: target === null ? null
    : loading ? '正在读取 SSH 连接状态，请稍后发送' : sshMessageUnavailableReason(connection?.status) }
}
