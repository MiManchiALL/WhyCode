import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Loader2, X } from 'lucide-react'
import type { SshConnectionSnapshot } from '../../shared/ssh.ts'
import type { SshSkillRow } from '../../shared/ssh-skills.ts'
import { SettingsButton } from './settings-layout.tsx'
import { SshConnectionEditor } from './ssh-connection-editor.tsx'
import { canSyncSkill, sshSkillItems, type SshSkillItem } from './ssh-skill-presentation.ts'
import { useSshSkills } from './use-ssh-skills.ts'

const STATUS: Record<SshSkillRow['status'], string> = { missing: '远端缺少', same: '内容一致', update: '可更新', conflict: '有冲突', 'remote-only': '仅远端副本' }

export function SshSkillDialog({ connection, initialMode, onClose }: { connection: SshConnectionSnapshot; initialMode: 'sync' | 'clean'; onClose: () => void }) {
  const state = useSshSkills(connection.id)
  const [mode, setMode] = useState(initialMode)
  const [selected, setSelected] = useState<string[] | null>(null)
  const [showExisting, setShowExisting] = useState(true)
  const [cleanup, setCleanup] = useState<SshSkillRow[] | null>(null)
  const rows = state.listing?.rows ?? []
  const visible = sshSkillItems(rows, state.job, mode, showExisting)
  const selectable = visible.flatMap(({ row }) => row && (mode === 'clean' ? row.managed : canSyncSkill(row)) ? [row] : [])
  const defaults = selectable.filter(row => mode === 'sync' || !row.modified).map(row => row.id)
  const chosen = selectable.filter(row => (selected ?? defaults).includes(row.id))
  const waiting = state.loading || state.busy
  const changeMode = (next: typeof mode) => { if (next !== mode) { setMode(next); setSelected(null) } }
  const clean = (items: SshSkillRow[], allowModified: string[]) => {
    setCleanup(null)
    const skills = items.filter(row => !row.modified || allowModified.includes(row.id)).map(row => row.id)
    if (skills.length) void state.run({ action: 'skills-clean', id: connection.id, skills, allowModified })
  }
  return <>
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
      <Dialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
      <Dialog.Content className="wc-dialog-card wc-menu-surface wc-scrollbar fixed left-1/2 top-1/2 z-[91] max-h-[90vh] w-[min(92vw,680px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 outline-none">
        <div className="flex items-center justify-between gap-3"><Dialog.Title className="text-base font-semibold">同步与管理 Skill</Dialog.Title><Dialog.Close asChild><button className="wc-focus-ring rounded-lg p-1.5 hover:bg-black/[0.05]" aria-label="关闭 Skill 管理"><X size={17} /></button></Dialog.Close></div>
        <Dialog.Description className="mt-2 break-words text-sm leading-6 text-[var(--wc-muted)]">{connection.name} · {connection.username}@{connection.host}<br />管理 WhyCode 内置 Skill 和本地用户 Skill 的远端副本，此账号下的所有项目共用。清理后不会在重连时自动上传，可在此重新同步。</Dialog.Description>
        <div className="my-4 flex flex-wrap items-center gap-2">
          <SettingsButton variant={mode === 'sync' ? 'primary' : undefined} disabled={state.busy} onClick={() => changeMode('sync')}>同步/更新 Skill</SettingsButton>
          <SettingsButton variant={mode === 'clean' ? 'primary' : undefined} disabled={state.busy} onClick={() => changeMode('clean')}>清理远端 Skill</SettingsButton>
          {mode === 'sync' && <label className="ml-auto flex items-center gap-2 text-xs text-[var(--wc-muted)]"><input type="checkbox" disabled={state.busy} checked={showExisting} onChange={event => setShowExisting(event.target.checked)} />显示已有项</label>}
        </div>
        <SkillList state={state} mode={mode} items={visible} chosen={chosen} onSelect={(id, checked) => setSelected(old => checked ? [...(old ?? defaults), id] : (old ?? defaults).filter(item => item !== id))} />
        {connection.status === 'disconnected' && <p className="mt-3 text-xs text-[var(--wc-muted)]">未连接时会临时连接，操作完成后断开；会话仍需单独连接。</p>}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-[var(--wc-muted)]"><input type="checkbox" disabled={waiting || !selectable.length} checked={selectable.length > 0 && chosen.length === selectable.length} onChange={event => setSelected(event.target.checked ? selectable.map(row => row.id) : [])} />全选 · 已选 {chosen.length}/{selectable.length}</label>
          <div className="flex flex-wrap gap-2">
            {mode === 'clean' && <SettingsButton disabled={waiting || !selectable.length} onClick={() => setCleanup(selectable)}>清理全部已同步 Skill</SettingsButton>}
            <SettingsButton variant="primary" disabled={waiting || !chosen.length} onClick={() => mode === 'sync' ? void state.run({ action: 'skills-sync', id: connection.id, skills: chosen.map(row => row.id) }) : setCleanup(chosen)}>{mode === 'sync' ? '同步已选项' : '清理已选项'}</SettingsButton>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
    {cleanup && <SkillCleanupConfirmation rows={cleanup} connection={connection} onClose={() => setCleanup(null)} onConfirm={allowed => clean(cleanup, allowed)} />}
    {state.credentials && <SshConnectionEditor connection={connection} purpose="skills" onClose={() => state.setCredentials(null)} onSave={state.saveCredentials} />}
  </>
}

function SkillList({ state, mode, items, chosen, onSelect }: {
  state: ReturnType<typeof useSshSkills>; mode: 'sync' | 'clean'; items: SshSkillItem[]; chosen: SshSkillRow[]; onSelect: (id: string, checked: boolean) => void
}) {
  const waiting = state.loading || state.busy
  const runningJob = state.job?.running ? state.job : undefined
  const operation = runningJob?.operation ?? mode
  return <div className="relative h-[min(24rem,45vh)] overflow-hidden rounded-xl border border-[var(--wc-line)]" role="region" aria-label="Skill 列表" aria-busy={waiting}>
    <div className={`wc-scrollbar h-full overflow-y-auto ${waiting ? 'invisible' : ''}`} inert={waiting} aria-hidden={waiting}>
      {state.error && <p className={`break-words p-4 text-sm text-[var(--wc-danger)] ${items.length ? 'border-b border-[var(--wc-line)]' : 'flex h-full flex-col items-center justify-center gap-3 text-center'}`} role="alert">{state.error} <button className="wc-focus-ring rounded underline" disabled={waiting} onClick={() => void state.load()}>重试读取</button></p>}
      {items.map(item => <SkillListItem key={item.id} item={item} operation={state.job?.operation ?? mode} disabled={waiting || !item.row || (mode === 'clean' ? !item.row.managed : !canSyncSkill(item.row))} checked={chosen.some(row => row.id === item.id)} onSelect={checked => onSelect(item.id, checked)} />)}
      {!state.error && !items.length && <p className="flex h-full items-center justify-center p-5 text-center text-sm text-[var(--wc-muted)]">{mode === 'clean' ? '没有已同步的 Skill' : '没有符合条件的本地 Skill'}</p>}
    </div>
    {waiting && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center text-[var(--wc-muted)]" role="status">
      <Loader2 size={20} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <p className="text-sm">{state.busy ? `${operation === 'sync' ? '正在同步' : '正在清理'}${runningJob ? ` ${runningJob.results.length}/${runningJob.total}` : '…'}` : '正在核对本地与远端 Skill…'}</p>
      {state.busy && <p className="text-xs">关闭窗口后仍会在后台继续。</p>}
    </div>}
    {!waiting && state.job && <p className="sr-only" role="status">{state.job.operation === 'sync' ? '同步' : '清理'}结果：{state.job.results.filter(result => result.ok).length} 项成功，{state.job.results.filter(result => !result.ok).length} 项失败。</p>}
  </div>
}

function SkillListItem({ item: { id, row, result }, operation, disabled, checked, onSelect }: {
  item: SshSkillItem; operation: 'sync' | 'clean'; disabled: boolean; checked: boolean; onSelect: (checked: boolean) => void
}) {
  const failure = result && !result.ok ? result.message : row?.error
  return <label className="flex items-start gap-3 border-b border-[var(--wc-line)] p-3 last:border-b-0">
    <input type="checkbox" className="mt-1 shrink-0" disabled={disabled} checked={checked} onChange={event => onSelect(event.target.checked)} />
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="break-words text-sm font-medium">{row?.name ?? result?.name}</span>
          {result && <span className={`rounded-md px-1.5 py-0.5 text-xs ${result.ok ? 'bg-[var(--wc-sage)] text-[var(--wc-sage-ink)]' : 'bg-[var(--wc-rollback)] text-[var(--wc-danger)]'}`}>{result.ok ? result.message : operation === 'sync' ? '同步失败' : '清理失败'}</span>}
        </span>
        {row && <span className="text-xs text-[var(--wc-muted)]">{row.modified ? '远端有修改' : STATUS[row.status]}</span>}
      </span>
      {row?.description && <span className="mt-1 block break-words text-xs leading-5 text-[var(--wc-muted)]">{row.description}</span>}
      {failure && <span className="mt-1 block break-words text-xs leading-5 text-[var(--wc-danger)]">{failure}</span>}
      <span className="mt-1 block break-all text-xs text-[var(--wc-faint)]">{id.startsWith('.system/') ? '内置' : '用户'} · {id}</span>
    </span>
  </label>
}

function SkillCleanupConfirmation({ rows, connection, onClose, onConfirm }: {
  rows: SshSkillRow[]; connection: SshConnectionSnapshot; onClose: () => void; onConfirm: (allowed: string[]) => void
}) {
  const [allowed, setAllowed] = useState<string[]>([])
  const modified = rows.filter(row => row.modified)
  const count = rows.length - modified.length + allowed.length
  return <AlertDialog.Root open onOpenChange={open => { if (!open) onClose() }}><AlertDialog.Portal>
    <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[92] bg-black/20" />
    <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[93] max-h-[85vh] w-[min(90vw,520px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 outline-none">
      <AlertDialog.Title className="text-base font-semibold">清理已同步 Skill？</AlertDialog.Title>
      <AlertDialog.Description className="mt-3 text-sm leading-6 text-[var(--wc-muted)]">将清理 {connection.name}（{connection.username}@{connection.host}）上的 {count} 个副本，影响此账号下的所有项目。服务器原有 Skill、本地源文件、项目和会话均保留。</AlertDialog.Description>
      {modified.length > 0 && <div className="mt-3 space-y-2 text-sm"><p className="text-[var(--wc-muted)]">以下副本在远端有修改，勾选才会删除：</p>{modified.map(row => <label key={row.id} className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={allowed.includes(row.id)} onChange={event => setAllowed(old => event.target.checked ? [...old, row.id] : old.filter(id => id !== row.id))} /><span className="min-w-0 break-all">{row.name} · {row.id}</span></label>)}</div>}
      <div className="mt-5 flex justify-end gap-2"><AlertDialog.Cancel asChild><SettingsButton>取消</SettingsButton></AlertDialog.Cancel><AlertDialog.Action asChild><SettingsButton variant="primary" disabled={!count} onClick={() => onConfirm(allowed)}>清理 {count} 项</SettingsButton></AlertDialog.Action></div>
    </AlertDialog.Content>
  </AlertDialog.Portal></AlertDialog.Root>
}
