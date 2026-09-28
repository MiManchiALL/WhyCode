import { useCallback, useEffect, useState } from 'react'
import { FolderPlus, MoreHorizontal, Plus, RefreshCw, Server } from 'lucide-react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { SshConnection, SshConnectionInput, SshRequest, SshResult } from '../../shared/ssh.ts'
import { SettingsButton, SettingsPanel, SettingsSection } from './settings-layout.tsx'
import { useConversationFeedback } from './conversation-feedback.tsx'
import { SshConnectionEditor } from './ssh-connection-editor.tsx'
import { SshDirectoryPicker } from './ssh-directory-picker.tsx'

export function SshSettings() {
  const [connections, setConnections] = useState<SshConnection[]>([])
  const [editor, setEditor] = useState<SshConnection | 'new' | null>(null)
  const [picker, setPicker] = useState<SshConnection | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; action: string; run: () => void } | null>(null)
  const feedback = useConversationFeedback()
  const request = useCallback(async (request: SshRequest): Promise<Extract<SshResult, { ok: true }> | null> => {
    try {
      const result = await window.whycode.ssh(request)
      if (!result.ok) throw new Error(result.error)
      return result
    } catch (error) { feedback('error', error instanceof Error ? error.message : String(error)); return null }
  }, [feedback])
  const refresh = useCallback(async () => {
    const result = await request({ action: 'list' })
    if (result?.connections) {
      setConnections(result.connections)
    }
  }, [request])
  useEffect(() => { void refresh() }, [refresh])
  const connect = async (connection: SshConnection, fingerprint?: string) => {
    if (connection.authentication === 'password' && !connection.hasSecret) { setEditor(connection); return }
    setBusy(connection.id)
    const result = await request({ action: 'connect', id: connection.id, fingerprint })
    setBusy(null)
    void refresh()
    if (result?.connect?.status === 'trust-required') {
      const trust = result.connect
      setConfirmation({ title: '信任此服务器？', description: `${trust.host}\n服务器指纹：\n${trust.fingerprint}`, action: '信任并连接', run: () => void connect(connection, trust.fingerprint) })
    } else if (result?.connect?.status === 'connected') {
      feedback('success', 'SSH 已连接')
    }
  }
  const save = async (value: SshConnectionInput): Promise<boolean> => {
    const result = await request({ action: 'save', connection: value })
    if (!result) return false
    await refresh(); feedback('success', 'SSH 连接已保存'); return true
  }
  const action = (connection: SshConnection, action: 'remove' | 'disconnect' | 'cleanup') => {
    const titles = { remove: '删除此连接？', disconnect: '断开 SSH 连接？', cleanup: '清理远端组件？' }
    const descriptions = { remove: '删除本机连接配置并断开连接。项目文件和会话记录会保留。', disconnect: '此连接下正在运行的命令和终端将被停止。', cleanup: '停止此连接的命令和终端，删除 WhyCode 的远端组件缓存。项目文件和会话记录会保留。' }
    setConfirmation({ title: titles[action], description: descriptions[action], action: '确认', run: () => {
      setBusy(connection.id)
      void request({ action, id: connection.id }).then(async result => {
        await refresh()
        if (result) feedback('success', '操作已完成')
      }).finally(() => setBusy(null))
    } })
  }
  return <>
    <SettingsSection title="SSH 连接" description="连接后添加远端项目，像本地项目一样开始会话。首次连接会自动准备轻量运行组件。"
      actions={<div className="flex items-center gap-2">
        <SettingsButton aria-label="刷新 SSH 连接状态" onClick={() => void refresh()} disabled={Boolean(busy)}><RefreshCw size={15} /></SettingsButton>
        <SettingsButton onClick={() => setEditor('new')} disabled={Boolean(busy)}><Plus size={15} />添加连接</SettingsButton>
      </div>}>
      <SettingsPanel padded={false}>
        {!connections.length && <div className="flex flex-col items-center gap-3 px-8 py-12 text-[var(--wc-muted)]">
          <Server size={30} strokeWidth={1.4} />
          <p className="text-sm">通过 SSH 连接你的服务器</p>
          <SettingsButton variant="primary" onClick={() => setEditor('new')}>添加连接</SettingsButton>
        </div>}
        {connections.map(connection => <div key={connection.id} className="flex min-w-0 flex-wrap items-center gap-3 border-b border-[var(--wc-line)] p-4 last:border-b-0">
          <Server size={20} className="shrink-0 text-[var(--wc-muted)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{connection.name}</div>
            <div className="truncate text-xs text-[var(--wc-faint)]">{connection.username}@{connection.host}:{connection.port}</div>
          </div>
          <SettingsButton disabled={Boolean(busy) || connection.connected} onClick={() => void connect(connection)}>
            {busy === connection.id ? '处理中…' : connection.connected ? '已连接' : '连接'}
          </SettingsButton>
          <SettingsButton aria-label={`添加 ${connection.name} 的项目`} disabled={Boolean(busy) || !connection.connected} onClick={() => setPicker(connection)}>
            <FolderPlus size={16} />添加项目
          </SettingsButton>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="wc-focus-ring flex size-8 items-center justify-center rounded-lg hover:bg-black/[0.05]" aria-label={`${connection.name} 的更多选项`} disabled={Boolean(busy)}>
                <MoreHorizontal size={18} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content className="wc-menu-content" align="end" sideOffset={5}>
              <DropdownMenu.Item className="wc-menu-item" onSelect={() => setEditor(connection)}>编辑连接</DropdownMenu.Item>
              <DropdownMenu.Item className="wc-menu-item" disabled={!connection.connected} onSelect={() => action(connection, 'disconnect')}>断开连接</DropdownMenu.Item>
              <DropdownMenu.Item className="wc-menu-item" disabled={!connection.fingerprint} onSelect={() => action(connection, 'cleanup')}>清理远端组件</DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--wc-line)]" />
              <DropdownMenu.Item className="wc-menu-item" onSelect={() => action(connection, 'remove')}>删除连接</DropdownMenu.Item>
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>)}
      </SettingsPanel>
    </SettingsSection>
    {editor && <SshConnectionEditor connection={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} onSave={save} />}
    {picker && <SshDirectoryPicker connection={picker} onClose={() => setPicker(null)} />}
    <AlertDialog.Root open={Boolean(confirmation)} onOpenChange={open => { if (!open) setConfirmation(null) }}><AlertDialog.Portal>
      <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
      <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 p-5 outline-none">
        <AlertDialog.Title className="text-base font-semibold">{confirmation?.title}</AlertDialog.Title>
        <AlertDialog.Description className="mt-3 whitespace-pre-wrap break-all text-sm leading-6 text-[var(--wc-muted)]">{confirmation?.description}</AlertDialog.Description>
        <div className="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel asChild><SettingsButton>取消</SettingsButton></AlertDialog.Cancel>
          <AlertDialog.Action asChild><SettingsButton variant="primary" onClick={() => confirmation?.run()}>{confirmation?.action}</SettingsButton></AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal></AlertDialog.Root>
  </>
}
