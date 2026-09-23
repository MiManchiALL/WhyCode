import type { SkillSummary, SubagentSummary } from '@whycode/core'
import { FolderOpen, Maximize2, Minimize2, PanelRightClose, Plus, SquareTerminal } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RightPanelFilePreview } from './right-panel-file.tsx'
import { RightPanelChanges } from './right-panel-changes.tsx'
import { WorkspaceBrowser } from './workspace-browser.tsx'
import {
  activeRightPanelPage,
  type RightPanelPage,
  type RightPanelSessionState,
} from './right-panel-state.ts'
import { SubagentPanelContent } from './subagent-panel.tsx'
import { RightPanelTabs } from './right-panel-tabs.tsx'
import { TerminalPanel } from './terminal-panel.tsx'

interface RightPanelProps {
  active: boolean
  runtimeId: string
  refreshRevision: string
  parentSessionId: string | null
  subagents: readonly SubagentSummary[]
  skills: readonly SkillSummary[]
  projectDir: string | null
  workspacePath: string | null
  fullscreen: boolean
  onToggleFullscreen: () => void
  onCollapse: () => void
  state: RightPanelSessionState
  onOpenPage: (page: RightPanelPage) => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onMoveTab: (tabId: string, targetId: string) => void
  terminalOpening: boolean
  onOpenTerminal: () => void
}

export function RightPanel(props: RightPanelProps) {
  return (
    <aside className="flex h-full w-full flex-col border-l border-[var(--wc-line)] bg-[var(--wc-surface)]">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--wc-line)] px-2">
        <RightPanelTabs key={props.runtimeId} tabs={props.state.tabs} activeTabId={props.state.activeTabId}
          subagents={props.subagents} onSelect={props.onSelectTab} onClose={props.onCloseTab} onMove={props.onMoveTab}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="wc-focus-ring flex size-7 shrink-0 items-center justify-center rounded-lg text-[var(--wc-muted)] hover:bg-black/[0.05] disabled:opacity-50"
                aria-label="新建右侧标签页"
                title="新建标签页"
                disabled={!props.runtimeId}
              >
                <Plus size={15} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="wc-menu-content min-w-36" align="start" sideOffset={5}>
                <DropdownMenu.Item className="wc-menu-item" disabled={!props.workspacePath} onSelect={() => openWorkspace(props)}>
                  <FolderOpen size={15} />
                  <span>当前工作路径</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="wc-menu-item" disabled={props.terminalOpening} onSelect={props.onOpenTerminal}>
                  <SquareTerminal size={15} />
                  <span>终端</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </RightPanelTabs>
        <button type="button" className="wc-preview-action" title={props.fullscreen ? '退出全屏' : '全屏'} aria-label={props.fullscreen ? '退出全屏' : '全屏'} onClick={props.onToggleFullscreen}>
          {props.fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        {props.fullscreen && <button type="button" className="wc-preview-action" title="收起右侧栏" aria-label="收起右侧栏" onClick={props.onCollapse}><PanelRightClose size={15} /></button>}
      </div>
      <RightPanelContent {...props} />
    </aside>
  )
}

function RightPanelContent(props: RightPanelProps) {
  const page = activeRightPanelPage(props.state)
  if (!page) return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
      <button type="button" className="wc-focus-ring flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-[var(--wc-muted)] hover:bg-black/[0.035] hover:text-[var(--wc-ink)] disabled:opacity-50" disabled={!props.runtimeId || !props.workspacePath} onClick={() => openWorkspace(props)}>
        <FolderOpen size={17} /><span>当前工作路径</span>
      </button>
      <button
        type="button"
        className="wc-focus-ring flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm text-[var(--wc-muted)] hover:bg-black/[0.035] hover:text-[var(--wc-ink)] disabled:opacity-50"
        onClick={props.onOpenTerminal}
        disabled={props.terminalOpening || !props.runtimeId}
      >
        <SquareTerminal size={17} className="shrink-0" />
        <span>{props.terminalOpening ? '正在打开终端…' : '终端'}</span>
      </button>
    </div>
  )
  switch (page.kind) {
    case 'changes':
      return props.active ? <RightPanelChanges key={`${props.runtimeId}:${page.checkpointIds.join(',')}`}
        runtimeId={props.runtimeId} projectDir={props.projectDir} page={page} onOpenPage={props.onOpenPage} />
        : <div className="min-h-0 flex-1" />
    case 'workspace':
      return props.active && props.workspacePath ? <WorkspaceBrowser
        key={`${props.runtimeId}:${props.workspacePath}`}
        runtimeId={props.runtimeId} rootPath={props.workspacePath} expanded={page.expanded}
        refreshRevision={props.refreshRevision}
        onExpandedChange={expanded => props.onOpenPage({ ...page, expanded })}
        onOpenFile={(path, name) => props.onOpenPage({ kind: 'file', path, name, source: { kind: 'current' } })}
      /> : <div className="min-h-0 flex-1" />
    case 'terminal':
      return <TerminalPanel key={page.terminal.id} terminal={page.terminal} active={props.active} />
    case 'file':
      return props.active ? (
        <RightPanelFilePreview
          key={filePageKey(props.runtimeId, page)}
          runtimeId={props.runtimeId}
          refreshRevision={props.refreshRevision}
          page={page}
          onChange={props.onOpenPage}
        />
      ) : <div className="min-h-0 flex-1" />
    case 'subagent-overview':
    case 'subagent-transcript':
      return (
        <SubagentPanelContent
          active={props.active}
          runtimeId={props.runtimeId}
          parentSessionId={props.parentSessionId}
          subagents={props.subagents}
          skills={props.skills}
          projectDir={props.projectDir}
          page={page}
          onSelect={(subagentId) => props.onOpenPage({ kind: 'subagent-transcript', subagentId })}
          onBack={() => props.onOpenPage({ kind: 'subagent-overview' })}
        />
      )
  }
}

function filePageKey(
  runtimeId: string,
  page: Extract<RightPanelPage, { kind: 'file' }>,
): string {
  const source = page.source.kind === 'current'
    ? 'current'
    : `${page.source.toolUseId}:${page.source.toolName}`
  return `${runtimeId}:${page.path}:${source}`
}

function openWorkspace(props: RightPanelProps): void {
  const existing = props.state.tabs.find(tab => tab.page.kind === 'workspace')
  props.onOpenPage(existing?.page ?? { kind: 'workspace', expanded: [] })
}
