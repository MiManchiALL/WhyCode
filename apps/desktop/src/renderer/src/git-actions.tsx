import { useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUp, Check, GitBranch, GitCommitHorizontal, Plus, Search, X } from 'lucide-react'
import type { GitMutation, GitRepositoryInfo } from '../../shared/git.ts'
import { SettingsButton } from './settings-layout.tsx'
import { SelectMenu } from './select-menu.tsx'
import { useConversationFeedback } from './conversation-feedback.tsx'

type ActionKind = GitMutation['action']['kind']
const titles = { create: '创建并切换分支', switch: '切换分支', commit: '提交改动', push: '推送分支' }

export function GitActions({ runtimeId, repository, busy, onChanged }: {
  runtimeId: string; repository: GitRepositoryInfo; busy: boolean; onChanged: () => void
}) {
  const [dialog, setDialog] = useState<ActionKind | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  return <>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button ref={trigger} type="button" className="wc-preview-action wc-git-actions" aria-label="Git 操作" title={busy ? '任务结束后可操作 Git' : repository.branch ?? '分离 HEAD'} disabled={busy}>
          <GitBranch size={15} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="wc-menu-content min-w-36" side="left" align="start" sideOffset={6}
        onCloseAutoFocus={event => { if (dialog) event.preventDefault() }}>
        <DropdownMenu.Item className="wc-menu-item" disabled={!repository.branch || repository.conflicts > 0 || !(repository.staged + repository.unstaged + repository.untracked)} onSelect={() => setDialog('commit')}>
          <GitCommitHorizontal size={14} />提交…
        </DropdownMenu.Item>
        <DropdownMenu.Item className="wc-menu-item" disabled={!repository.branch || !repository.head || !repository.remotes.length} onSelect={() => setDialog('push')}><ArrowUp size={14} />推送…</DropdownMenu.Item>
        <DropdownMenu.Separator className="my-1 h-px bg-[var(--wc-line)]" />
        <DropdownMenu.Item className="wc-menu-item" onSelect={() => setDialog('create')}><Plus size={14} />创建分支…</DropdownMenu.Item>
        <DropdownMenu.Item className="wc-menu-item" disabled={!repository.refs.length} onSelect={() => setDialog('switch')}><GitBranch size={14} />切换分支…</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {dialog && <GitActionDialog key={dialog} kind={dialog} runtimeId={runtimeId} repository={repository} busy={busy}
      onChanged={onChanged} onClose={() => setDialog(null)} onRestoreFocus={() => trigger.current?.focus()} />}
  </>
}

function GitActionDialog({ kind, runtimeId, repository, busy, onChanged, onClose, onRestoreFocus }: {
  kind: ActionKind; runtimeId: string; repository: GitRepositoryInfo; busy: boolean
  onChanged: () => void; onClose: () => void; onRestoreFocus: () => void
}) {
  const [text, setText] = useState('')
  const [scope, setScope] = useState<'staged' | 'all'>(repository.staged ? 'staged' : 'all')
  const [remote, setRemote] = useState(repository.remotes.find(name => repository.upstream?.startsWith(`refs/remotes/${name}/`)) ?? repository.remotes[0] ?? '')
  const [pending, setPending] = useState(false)
  const [openedAt] = useState({ expectedHead: repository.head, expectedBranch: repository.branch })
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const feedback = useConversationFeedback()
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const submit = async (action: GitMutation['action']) => {
    if (pending || busy) return
    setPending(true); setError(null)
    try {
      const result = await window.whycode.gitMutate(runtimeId, { ...openedAt, action })
      if (!alive.current) return
      onChanged()
      if (!result.ok) { setError(result.error); return }
      feedback('success', result.value, true)
      onClose()
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (alive.current) setPending(false) }
  }
  const branches = repository.refs.filter(ref => ref.name.toLocaleLowerCase().includes(text.toLocaleLowerCase()))
  const blocked = pending || busy
  return <Dialog.Root open onOpenChange={open => { if (!open && !pending) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20" />
    <Dialog.Content className="wc-dialog-card wc-menu-surface wc-git-dialog" onCloseAutoFocus={event => { event.preventDefault(); onRestoreFocus() }}
      onEscapeKeyDown={event => { if (pending || event.isComposing) event.preventDefault() }}>
      <div className="flex items-center justify-between gap-3">
        <Dialog.Title className="text-base font-semibold">{titles[kind]}</Dialog.Title>
        <Dialog.Close asChild><button className="wc-preview-action" aria-label="关闭 Git 操作" disabled={pending}><X size={15} /></button></Dialog.Close>
      </div>
      <Dialog.Description className="mt-2 truncate text-xs text-[var(--wc-muted)]" title={repository.root}>
        {repository.name} · {repository.branch ?? '分离的 HEAD'}
      </Dialog.Description>
      <form className="mt-4" onSubmit={event => {
        event.preventDefault()
        if (kind === 'create') void submit({ kind, name: text.trim() })
        if (kind === 'commit') void submit({ kind, message: text.trim(), scope })
        if (kind === 'push') void submit({ kind, remote })
      }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}>
        {kind === 'switch' ? <>
          <label className="wc-git-search"><Search size={14} /><input aria-label="搜索分支" placeholder="搜索分支…" value={text} onChange={event => setText(event.target.value)} disabled={pending} /></label>
          <div className="wc-scrollbar wc-git-branches">
            {branches.slice(0, 200).map(ref => <button type="button" className="wc-menu-item w-full" key={ref.ref}
              title={ref.name} disabled={blocked || !ref.remote && ref.name === repository.branch}
              onClick={() => void submit({ kind: 'switch', ref: ref.ref })}>
              <GitBranch size={14} /><span className="min-w-0 flex-1 truncate text-left">{ref.name}</span>
              {ref.remote ? <span className="wc-type-tiny text-[var(--wc-faint)]">远端</span> : ref.name === repository.branch && <Check size={14} />}
            </button>)}
            {!branches.length && <p className="py-5 text-center text-xs text-[var(--wc-faint)]">没有匹配的分支</p>}
            {branches.length > 200 && <p className="p-2 text-xs text-[var(--wc-faint)]">输入名称以查找更多分支</p>}
          </div>
        </> : kind === 'push' ? <>
          <label className="wc-git-label">推送到远端</label>
          <SelectMenu value={remote} options={repository.remotes.map(value => ({ value, label: value }))} onValueChange={setRemote} ariaLabel="推送远端" disabled={blocked} className="w-full" />
          <p className="mt-3 truncate text-xs" title={repository.upstream ?? `${remote}/${repository.branch}`}>目标：{repository.upstream?.startsWith(`refs/remotes/${remote}/`) ? repository.upstream.slice('refs/remotes/'.length) : `${remote}/${repository.branch}`}</p>
          <p className="mt-3 text-xs leading-5 text-[var(--wc-muted)]">推送当前分支的已提交内容。首次推送会建立跟踪关系。</p>
        </> : <>
          <label className="wc-git-label" htmlFor={`git-${kind}`}>{kind === 'create' ? '分支名称' : '提交说明'}</label>
          {kind === 'create' ? <input id={`git-${kind}`} className="wc-settings-input w-full" value={text} onChange={event => setText(event.target.value)} placeholder="feature/task-name" maxLength={200} disabled={blocked} />
            : <><textarea id={`git-${kind}`} className="wc-settings-input w-full resize-y" rows={3} value={text} onChange={event => setText(event.target.value)} placeholder="简要说明这次改动" maxLength={10000} disabled={blocked} />
              <SelectMenu value={scope} options={[{ value: 'staged', label: `仅已暂存 · ${repository.staged} 个文件`, disabled: !repository.staged },
                { value: 'all', label: '全部未提交改动（含新文件）' }]} onValueChange={value => setScope(value as 'staged' | 'all')} ariaLabel="提交范围" disabled={blocked} className="mt-3 w-full" />
              {scope === 'all' && <p className="mt-2 text-xs leading-5 text-[var(--wc-muted)]">将暂存并提交整个仓库的改动；提交失败时已暂存的内容会保留。</p>}
            </>}
        </>}
        {error && <p role="alert" className="wc-scrollbar mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--wc-danger)]">{error}</p>}
        {busy && <p className="mt-3 text-xs text-[var(--wc-muted)]">任务进行中，请等待结束后再操作。</p>}
        {kind !== 'switch' && <div className="mt-5 flex justify-end gap-2">
          <SettingsButton type="button" onClick={onClose} disabled={pending}>取消</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={blocked || (kind === 'push' ? !remote : !text.trim())}>{pending ? '处理中…' : kind === 'create' ? '创建并切换' : kind === 'commit' ? '提交' : '推送'}</SettingsButton>
        </div>}
        {kind === 'switch' && pending && <p role="status" className="mt-3 text-xs text-[var(--wc-muted)]">正在切换分支…</p>}
      </form>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
