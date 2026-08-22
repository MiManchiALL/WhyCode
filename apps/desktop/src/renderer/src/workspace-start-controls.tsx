import { useEffect, useState } from 'react'
import { Check, ChevronDown, GitBranch, Laptop } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type {
  RuntimeWorkspace,
  WorkspaceCandidate,
  WorktreeBase,
} from '../../shared/workspace.ts'

export type WorkspaceStartChoice =
  | { mode: 'local' }
  | { mode: 'worktree'; base: WorktreeBase }

interface WorkspaceStartControlsProps {
  candidate: WorkspaceCandidate
  mode: RuntimeWorkspace['mode']
  baseRef: string | null
  busy: boolean
  onStart: (choice: WorkspaceStartChoice) => void
}

export function WorkspaceStartControls(props: WorkspaceStartControlsProps) {
  const worktreeMode = props.mode === 'worktree' || props.mode === 'pending-worktree'
  const [selectedBaseKey, setSelectedBaseKey] = useState(() => (
    worktreeMode
      ? initialBaseKey(props.candidate.worktreeBases, props.baseRef)
      : firstBaseKey(props.candidate.worktreeBases)
  ))

  useEffect(() => {
    setSelectedBaseKey((current) => {
      if (worktreeMode) return initialBaseKey(props.candidate.worktreeBases, props.baseRef)
      return props.candidate.worktreeBases.some((base) => worktreeBaseKey(base) === current)
        ? current
        : firstBaseKey(props.candidate.worktreeBases)
    })
  }, [props.baseRef, props.candidate, worktreeMode])

  const selectedBase = props.candidate.worktreeBases.find(
    (base) => worktreeBaseKey(base) === selectedBaseKey,
  ) ?? props.candidate.worktreeBases[0] ?? null
  const worktreeAvailable = Boolean(
    props.candidate.repositoryDirectory
    && selectedBase
    && !props.candidate.worktreeUnavailableReason,
  )

  const changeMode = (value: string) => {
    if (value === 'local') {
      if (worktreeMode) props.onStart({ mode: 'local' })
      return
    }
    if (!worktreeMode && worktreeAvailable && selectedBase) {
      props.onStart({ mode: 'worktree', base: selectedBase })
    }
  }

  const changeBase = (value: string) => {
    setSelectedBaseKey(value)
    const base = props.candidate.worktreeBases.find(
      (candidate) => worktreeBaseKey(candidate) === value,
    )
    if (worktreeMode && base) props.onStart({ mode: 'worktree', base })
  }

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="wc-context-trigger wc-focus-ring"
            disabled={props.busy}
            aria-label="选择项目启动模式"
            title="选择本地或 Worktree 启动模式"
          >
            {worktreeMode ? <GitBranch size={12} /> : <Laptop size={12} />}
            <span>{worktreeMode ? 'Worktree' : '本地'}</span>
            <ChevronDown size={11} className="text-[var(--wc-faint)]" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="wc-menu-content min-w-64"
            align="start"
            side="top"
            sideOffset={7}
          >
            <DropdownMenu.Label className="px-2 py-1.5 wc-type-tiny font-medium text-[var(--wc-faint)]">
              启动模式
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={worktreeMode ? 'worktree' : 'local'}
              onValueChange={changeMode}
            >
              <DropdownMenu.RadioItem value="local" className="wc-menu-item">
                <Laptop size={15} />
                <div className="min-w-0 flex-1">
                  <div>在本地处理</div>
                  <div className="wc-type-tiny text-[var(--wc-faint)]">包含当前目录的未提交修改</div>
                </div>
                <MenuCheck />
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem
                value="worktree"
                className="wc-menu-item"
                disabled={!worktreeAvailable}
                title={props.candidate.worktreeUnavailableReason ?? undefined}
              >
                <GitBranch size={15} />
                <div className="min-w-0 flex-1">
                  <div>新工作树</div>
                  <div className="wc-type-tiny text-[var(--wc-faint)]">
                    {props.candidate.worktreeUnavailableReason
                      ?? (props.candidate.dirty ? '从所选提交创建，不带入未提交修改' : '从所选提交创建隔离目录')}
                  </div>
                </div>
                <MenuCheck />
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="wc-context-trigger wc-focus-ring min-w-0 max-w-48"
            disabled={props.busy || props.candidate.worktreeBases.length === 0}
            aria-label="选择 Worktree 基线分支"
            title={baseLabel(selectedBase)}
          >
            <GitBranch size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{baseRefLabel(selectedBase)}</span>
            <ChevronDown size={11} className="shrink-0 text-[var(--wc-faint)]" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="wc-menu-content min-w-[min(22rem,calc(100vw-2rem))]"
            align="start"
            side="top"
            sideOffset={7}
          >
            <DropdownMenu.Label className="px-2 py-1.5 wc-type-tiny font-medium text-[var(--wc-faint)]">
              基线分支
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={selectedBaseKey} onValueChange={changeBase}>
              {props.candidate.worktreeBases.map((base) => (
                <DropdownMenu.RadioItem
                  key={worktreeBaseKey(base)}
                  value={worktreeBaseKey(base)}
                  className="wc-menu-item"
                  title={baseLabel(base)}
                >
                  <GitBranch size={14} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{baseRefLabel(base)}</div>
                    <div className="font-mono wc-type-tiny text-[var(--wc-faint)]">
                      {base.commit.slice(0, 10)}
                    </div>
                  </div>
                  <MenuCheck />
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  )
}

function MenuCheck() {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <DropdownMenu.ItemIndicator>
        <Check size={14} />
      </DropdownMenu.ItemIndicator>
    </span>
  )
}

function initialBaseKey(bases: readonly WorktreeBase[], baseRef: string | null): string {
  const matchingBase = bases.find((base) => base.ref === baseRef)
  return matchingBase ? worktreeBaseKey(matchingBase) : firstBaseKey(bases)
}

function firstBaseKey(bases: readonly WorktreeBase[]): string {
  return bases[0] ? worktreeBaseKey(bases[0]) : ''
}

function baseRefLabel(base: WorktreeBase | null): string {
  return base?.ref ?? 'detached HEAD'
}

function baseLabel(base: WorktreeBase | null): string {
  return base ? `${baseRefLabel(base)} · ${base.commit.slice(0, 10)}` : '没有可用基线'
}

function worktreeBaseKey(base: WorktreeBase): string {
  return base.ref ? `ref:${base.ref}` : `detached:${base.commit}`
}
