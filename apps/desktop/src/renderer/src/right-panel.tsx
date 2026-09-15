import type { SkillSummary, SubagentSummary } from '@whycode/core'
import { Bot, FileText, FolderOpen, Maximize2, Minimize2, PanelRightClose, Plus, SquareTerminal, X } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useEffect, useRef } from 'react'
import { RightPanelFilePreview } from './right-panel-file.tsx'
import { WorkspaceBrowser } from './workspace-browser.tsx'
import {
  activeRightPanelPage,
  type RightPanelPage,
  type RightPanelSessionState,
  type RightPanelTab,
} from './right-panel-state.ts'
import { SubagentPanelContent } from './subagent-panel.tsx'
import { resolveSubagentPanelPage } from './subagent-presentation.ts'
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
  terminalOpening: boolean
  onOpenTerminal: () => void
}

export function RightPanel(props: RightPanelProps) {
  return (
    <aside className="flex h-full w-full flex-col border-l border-[var(--wc-line)] bg-[var(--wc-surface)]">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--wc-line)] px-2">
        <div
          aria-label="右侧栏页面"
          className="wc-right-panel-tabs wc-scrollbar min-w-0 flex-1 overflow-x-auto"
        >
          <div className="flex min-w-max items-center gap-1">
            {props.state.tabs.map((tab) => (
              <RightPanelTabButton
                key={tab.id}
                tab={tab}
                active={tab.id === props.state.activeTabId}
                subagents={props.subagents}
                onSelect={() => props.onSelectTab(tab.id)}
                onClose={() => props.onCloseTab(tab.id)}
              />
            ))}
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
          </div>
        </div>
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

function RightPanelTabButton({
  tab,
  active,
  subagents,
  onSelect,
  onClose,
}: {
  tab: RightPanelTab
  active: boolean
  subagents: readonly SubagentSummary[]
  onSelect: () => void
  onClose: () => void
}) {
  const title = tabTitle(tab.page, subagents)
  const tabRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) return
    tabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <div
      ref={tabRef}
      className={`group flex h-7 max-w-44 items-center gap-1 rounded-lg py-1 pl-2 pr-1 text-xs ${
        active ? 'bg-black/[0.055] text-[var(--wc-ink)]' : 'text-[var(--wc-muted)] hover:bg-black/[0.035]'
      }`}
    >
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        className="wc-focus-ring flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-md text-left"
        title={tab.page.kind === 'terminal' ? `${title}\n${tab.page.terminal.cwd}` : title}
        onClick={onSelect}
      >
        {tab.page.kind === 'file'
          ? <FileText size={13} className="shrink-0 text-[var(--wc-muted)]" />
          : tab.page.kind === 'terminal'
            ? <SquareTerminal size={13} className="shrink-0 text-[var(--wc-muted)]" />
          : tab.page.kind === 'workspace' ? <FolderOpen size={13} className="shrink-0 text-[var(--wc-muted)]" />
          : <Bot size={13} className="shrink-0 text-[var(--wc-muted)]" />}
        <span className="truncate">{title}</span>
      </button>
      <button
        type="button"
        className="wc-focus-ring ml-auto flex size-5 shrink-0 items-center justify-center rounded-md text-[var(--wc-faint)] opacity-70 hover:bg-black/[0.06] hover:text-[var(--wc-ink)] group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        aria-label={`关闭 ${title}`}
      >
        <X size={12} />
      </button>
    </div>
  )
}

function tabTitle(
  page: RightPanelPage,
  subagents: readonly SubagentSummary[],
): string {
  if (page.kind === 'workspace') return '当前工作路径'
  if (page.kind === 'file') return page.name
  if (page.kind === 'terminal') return page.terminal.title
  return resolveSubagentPanelPage(page, subagents)?.title ?? '子代理'
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
