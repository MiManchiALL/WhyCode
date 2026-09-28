import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { SshConnection, SshConnectionInput } from '../../shared/ssh.ts'
import { SettingsButton, SettingsSwitch } from './settings-layout.tsx'
import { SelectMenu } from './select-menu.tsx'

export function SshConnectionEditor({ connection, onClose, onSave }: {
  connection?: SshConnection; onClose: () => void; onSave: (value: SshConnectionInput) => Promise<boolean>
}) {
  const [value, setValue] = useState<SshConnectionInput>({ name: '', host: '', username: '', port: 22,
    authentication: 'password', rememberSecret: false, ...connection, secret: '' })
  const [busy, setBusy] = useState(false)
  const change = <K extends keyof SshConnectionInput>(key: K, next: SshConnectionInput[K]) => setValue(old => ({ ...old, [key]: next }))
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
    <Dialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] max-h-[90vh] w-[min(92vw,540px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-6 outline-none">
      <Dialog.Title className="text-lg font-semibold">{connection ? '编辑 SSH 连接' : '添加 SSH 连接'}</Dialog.Title>
      <Dialog.Description className="mt-1 text-sm text-[var(--wc-muted)]">连接 Linux 服务器，直接使用远端项目。{connection ? '保存会断开此连接并停止相关命令。' : ''}</Dialog.Description>
      <form className="mt-5 space-y-4" onSubmit={event => {
        event.preventDefault(); if (busy) return
        setBusy(true); void onSave(value).then(saved => { if (saved) onClose() }).finally(() => setBusy(false))
      }}>
        <fieldset disabled={busy} className="space-y-4">
          <label className="block text-sm">显示名称<input required maxLength={100} autoFocus className="wc-settings-input mt-1" value={value.name} onChange={event => change('name', event.target.value)} placeholder="例如：开发服务器" /></label>
          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
            <label className="block text-sm">主机地址<input required className="wc-settings-input mt-1" value={value.host} onChange={event => change('host', event.target.value)} placeholder="主机名或 IP 地址" /></label>
            <label className="block text-sm">端口<input required type="number" min={1} max={65535} className="wc-settings-input mt-1" value={value.port} onChange={event => change('port', Number(event.target.value))} /></label>
          </div>
          <label className="block text-sm">用户名<input required className="wc-settings-input mt-1" value={value.username} onChange={event => change('username', event.target.value)} autoComplete="off" /></label>
          <div className="space-y-1 text-sm"><span>身份验证</span><SelectMenu value={value.authentication} ariaLabel="SSH 身份验证" className="w-full"
            options={[{ value: 'password', label: '密码' }, { value: 'key', label: '私钥文件' }, { value: 'agent', label: '系统 SSH Agent' }]}
            onValueChange={next => change('authentication', next as SshConnectionInput['authentication'])} /></div>
          {value.authentication === 'key' && <label className="block text-sm">私钥文件路径<input required className="wc-settings-input mt-1" value={value.privateKeyPath ?? ''} onChange={event => change('privateKeyPath', event.target.value)} placeholder="本机私钥的完整路径" /></label>}
          {value.authentication !== 'agent' && <>
            <label className="block text-sm">{value.authentication === 'key' ? '私钥密码（可选）' : '密码'}<input type="password" autoComplete="new-password" className="wc-settings-input mt-1" value={value.secret ?? ''} onChange={event => change('secret', event.target.value)} placeholder={connection?.hasSecret ? '留空保留现有密码' : ''} /></label>
            <div className="flex items-center justify-between text-sm"><span>记住密码<span className="ml-2 text-xs text-[var(--wc-faint)]">使用系统加密存储</span></span><SettingsSwitch checked={value.rememberSecret} ariaLabel="记住 SSH 密码" onCheckedChange={next => change('rememberSecret', next)} /></div>
          </>}
        </fieldset>
        <div className="flex justify-end gap-2 pt-2"><SettingsButton onClick={onClose} disabled={busy}>取消</SettingsButton><SettingsButton type="submit" variant="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</SettingsButton></div>
      </form>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
