import type { SkillSummary, SubagentSummary } from '@whycode/core'
import { useEffect, useMemo } from 'react'
import { FolderOpen, Globe, Maximize2, Minimize2, PanelRightClose, Plus, SquareTerminal } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RightPanelFilePreview } from './right-panel-file.tsx'
import { RightPanelChanges } from './right-panel-changes.tsx'
import { WorkspaceBrowser } from './workspace-browser.tsx'
import {
  activeRightPanelPage,
  canAddRightPanelTab,
  browserReferencePage,
  type RightPanelPage,
  type RightPanelSessionState,
} from './right-panel-state.ts'
import { SubagentPanelContent } from './subagent-panel.tsx'
import { RightPanelTabs } from './right-panel-tabs.tsx'
import { TerminalPanel } from './terminal-panel.tsx'
import type { WorkspaceBrowserPosition } from './workspace-browser-position.ts'
import { WorkspaceDirectories } from './workspace-directories.ts'
import { BrowserPanel } from './browser-panel.tsx'
import type { PathReference } from './path-reference.ts'
import { browserAddress } from '../../shared/browser.ts'
import type { BrowserReferenceImage } from '../../shared/browser-reference.ts'
import type { ImageDraft } from './image-draft.ts'
import { SessionLoading } from './session-loading.tsx'

interface RightPanelProps {
  remote?: boolean
  active: boolean
  loading: boolean
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
  onUpdatePage: (page: RightPanelPage) => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onMoveTab: (tabId: string, targetId: string) => void
  terminalOpening: boolean
  onOpenTerminal: () => void
  canReferencePath: boolean
  onReferencePath: (runtimeId: string, reference: PathReference) => void
  canReferenceBrowser: boolean
  onReferenceBrowser: (runtimeId: string, image: BrowserReferenceImage, replaceId?: string) => boolean
  referenceDrafts: readonly ImageDraft[]
  workspacePosition?: WorkspaceBrowserPosition
  onWorkspacePositionChange: (position: WorkspaceBrowserPosition) => void
}

export function RightPanel(props: RightPanelProps) {
  const workspacePage = props.state.tabs.find(tab => tab.page.kind === 'workspace')?.page
  const expanded = workspacePage?.kind === 'workspace' ? workspacePage.expanded : undefined
  const hasWorkspace = expanded !== undefined
  const directories = useMemo(() => new WorkspaceDirectories(window.whycode, props.runtimeId, props.refreshRevision),
    [props.runtimeId, props.workspacePath, hasWorkspace])
  const browsing = !props.loading && props.active && activeRightPanelPage(props.state)?.kind === 'workspace'
  useEffect(() => () => directories.close(), [directories])
  useEffect(() => directories.retain(expanded ?? []), [directories, expanded])
  useEffect(() => directories.setActive(browsing, Boolean(props.remote)), [directories, browsing, props.remote])
  useEffect(() => directories.setRevision(props.refreshRevision), [directories, props.refreshRevision])
  useEffect(() => {
    if (!browsing) return
    const refresh = () => directories.invalidate()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [directories, browsing])
  return (
    <aside className="flex h-full w-full flex-col border-l border-[var(--wc-line)] bg-[var(--wc-surface)]">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--wc-line)] px-2">
        <RightPanelTabs key={props.parentSessionId ?? props.runtimeId} tabs={props.state.tabs} activeTabId={props.state.activeTabId}
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
                <DropdownMenu.Item className="wc-menu-item" disabled={props.terminalOpening || !canAddRightPanelTab(props.state)} onSelect={props.onOpenTerminal}>
                  <SquareTerminal size={15} />
                  <span>终端</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="wc-menu-item" disabled={!canAddRightPanelTab(props.state)} onSelect={() => openBrowser(props)}>
                  <Globe size={15} /><span>内置浏览器</span>
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
      {props.loading ? <div className="relative min-h-0 flex-1"><SessionLoading /></div> : <>
        <RightPanelContent {...props} directories={directories} />
        {props.state.tabs.map(tab => tab.page.kind === 'browser' && <BrowserPanel key={`${props.runtimeId}:${tab.id}`}
          page={tab.page} active={props.active && props.state.activeTabId === tab.id}
          runtimeId={props.runtimeId} canReference={props.canReferenceBrowser} referenceDrafts={props.referenceDrafts}
          onReference={(image, replaceId) => props.onReferenceBrowser(props.runtimeId, image, replaceId)}
          onChange={props.onUpdatePage} onOpen={url => openBrowser(props, url, tab.page.kind === 'browser' && !!tab.page.workspaceFile && url.startsWith('file:'))} onClose={() => props.onCloseTab(tab.id)} />)}
      </>}
    </aside>
  )
}

function RightPanelContent(props: RightPanelProps & { directories: WorkspaceDirectories }) {
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
      <button type="button" className="wc-focus-ring flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-[var(--wc-muted)] hover:bg-black/[0.035] hover:text-[var(--wc-ink)] disabled:opacity-50"
        disabled={!props.runtimeId} onClick={() => openBrowser(props)}><Globe size={17} /><span>内置浏览器</span></button>
    </div>
  )
  switch (page.kind) {
    case 'browser': return null
    case 'changes':
      return props.active ? <RightPanelChanges key={`${props.runtimeId}:${page.checkpointIds.join(',')}`}
        runtimeId={props.runtimeId} projectDir={props.projectDir} remote={props.remote} page={page} onOpenPage={props.onOpenPage} />
        : <div className="min-h-0 flex-1" />
    case 'workspace':
      return props.active && props.workspacePath ? <WorkspaceBrowser
        key={`${props.runtimeId}:${props.workspacePath}`}
        runtimeId={props.runtimeId} canReferencePath={props.canReferencePath} onReferencePath={props.onReferencePath}
        directories={props.directories} rootPath={props.workspacePath} expanded={page.expanded}
        position={props.workspacePosition} onPositionChange={props.onWorkspacePositionChange}
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
          onReferenceInBrowser={props.canReferenceBrowser
            ? path => props.onOpenPage(browserReferencePage(props.state, browserAddress(path), true, { kind: 'new' }, undefined, props.remote)) : undefined}
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

function openBrowser(props: RightPanelProps, url = 'about:blank', workspaceFile = false): void {
  props.onOpenPage({ kind: 'browser', id: crypto.randomUUID(), url, title: '', workspaceFile })
}
