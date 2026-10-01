import { useState } from 'react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import type { SshConnection } from '../../shared/ssh.ts'
import type { SshReleaseOptions } from '../../shared/ssh-skills.ts'
import { SettingsButton } from './settings-layout.tsx'

export interface SshReleaseDialogState {
  connection: SshConnection
  action: 'cleanup' | 'remove'
  options?: SshReleaseOptions
  error?: string
  modifiedSkills?: string[]
}
export function SshReleaseDialog({ state, onClose, onConfirm, onRemoveLocal }: {
  state: SshReleaseDialogState; onClose: () => void
  onConfirm: (options: SshReleaseOptions) => void; onRemoveLocal: () => void
}) {
  const [cleanSkills, setCleanSkills] = useState(state.options?.cleanSkills ?? state.action === 'remove')
  const [allowModified, setAllowModified] = useState<string[]>([])
  const remove = state.action === 'remove'
  return <AlertDialog.Root open onOpenChange={open => { if (!open) onClose() }}><AlertDialog.Portal>
    <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
    <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] max-h-[90vh] w-[min(92vw,540px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 outline-none">
      <AlertDialog.Title className="text-base font-semibold">{remove ? '删除此连接？' : '清理远端组件？'}</AlertDialog.Title>
      <AlertDialog.Description className="mt-3 text-sm leading-6 text-[var(--wc-muted)]">
        {state.connection.name} · {state.connection.username}@{state.connection.host}<br />
        断开共用远端组件的连接并停止相关命令、终端，清理远端组件。{remove ? '完成后删除此连接配置。' : '保留连接配置，重连时自动准备组件。'}项目、会话记录与远端临时文件保留。
      </AlertDialog.Description>
      <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={cleanSkills} onChange={event => setCleanSkills(event.target.checked)} /><span>同时清理已同步 Skill<span className="mt-1 block text-xs leading-5 text-[var(--wc-muted)]">影响此服务器当前账号下的所有项目；服务器原有 Skill 保留。</span></span></label>
      {state.error && <p className="mt-3 break-words text-sm text-[var(--wc-danger)]">{state.error}</p>}
      {remove && state.error && <p className="mt-2 text-xs text-[var(--wc-muted)]">选择“仅删除连接配置”会保留尚未清理的远端文件。</p>}
      {cleanSkills && Boolean(state.modifiedSkills?.length) && <div className="mt-3 space-y-2 rounded-xl border border-[var(--wc-line)] p-3 text-sm">
        <p className="text-[var(--wc-muted)]">以下副本在远端有修改。勾选才会删除，未勾选的保留：</p>
        {state.modifiedSkills!.map(id => <label key={id} className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={allowModified.includes(id)} onChange={event => setAllowModified(old => event.target.checked ? [...old, id] : old.filter(value => value !== id))} /><span className="min-w-0 break-all">{id}</span></label>)}
      </div>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {remove && state.error && <AlertDialog.Action asChild><SettingsButton onClick={onRemoveLocal}>仅删除连接配置</SettingsButton></AlertDialog.Action>}
        <AlertDialog.Cancel asChild><SettingsButton>取消</SettingsButton></AlertDialog.Cancel>
        <AlertDialog.Action asChild><SettingsButton variant="primary" onClick={() => onConfirm({ cleanSkills, allowModified, keepModified: state.modifiedSkills?.filter(id => !allowModified.includes(id)) })}>{state.error ? '重试' : '确认'}</SettingsButton></AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal></AlertDialog.Root>
}
