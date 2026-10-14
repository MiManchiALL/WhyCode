import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { BrowserPanel } from './browser-panel.tsx'
import { browserAction, completeBrowserConfirmation, dismissBrowserConfirmation, guardBrowserAction, updateBrowserHost, useBrowserConfirmation, useBrowserHostState } from './browser-host-state.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'
import { rightPanelTabId, type RightPanelPage, type RightPanelSessionState } from './right-panel-state.ts'
import type { ImageDraft } from './image-draft.ts'
import type { BrowserReferenceImage } from '../../shared/browser-reference.ts'
import type { BrowserViewRequest } from '../../shared/browser-agent.ts'
import { useBrowserBounds } from './use-browser-bounds.ts'

interface Props {
  runtimeId: string; active: boolean; fullscreen?: boolean; state: RightPanelSessionState
  canReference: boolean; referenceDrafts: readonly ImageDraft[]
  onReference: (owner: string, image: BrowserReferenceImage, replaceId?: string) => boolean
  onUpdate: (page: RightPanelPage) => void
  onRegister: (page: Extract<RightPanelPage, { kind: 'browser' }>) => void
  onOpen: (page: RightPanelPage) => void
  onClose: (tabId: string) => void
}

/** 此宿主始终挂载。切换会话只改变可见槽位，不重建本轮 Agent 的 webview。 */
export function BrowserSurfaces(props: Props) {
  const state = useBrowserHostState()
  const confirmation = useBrowserConfirmation()
  const feedback = useConversationFeedback()
  const registered = useRef(new Set<string>())
  const { anchor, bounds } = useBrowserBounds(props.active)
  const pages = props.state.tabs.flatMap(tab => tab.page.kind === 'browser' ? [tab.page] : [])
  const activePage = props.state.tabs.find(tab => tab.id === props.state.activeTabId)?.page
  const view: BrowserViewRequest = { runtimeId: props.runtimeId, pages,
    activePageId: activePage?.kind === 'browser' ? activePage.id : null, visible: props.active }
  const serializedView = JSON.stringify(view)
  useEffect(() => {
    const unsubscribe = window.whycode.onBrowserHostChanged(updateBrowserHost)
    void window.whycode.browserHostState().then(updateBrowserHost, error => feedback('error', String(error)))
    return unsubscribe
  }, [feedback])
  useEffect(() => {
    void window.whycode.syncBrowserView(JSON.parse(serializedView)).catch(error => feedback('error', String(error)))
  }, [serializedView, feedback])
  useEffect(() => {
    if (confirmation && confirmation.runtimeId !== props.runtimeId) dismissBrowserConfirmation()
  }, [confirmation, props.runtimeId])
  useEffect(() => {
    for (const agent of state.agents) {
      if (agent.runtimeId !== props.runtimeId || registered.current.has(agent.turnId)) continue
      registered.current.add(agent.turnId)
      props.onRegister({ kind: 'browser', ...agent.page })
    }
    const turns = new Set(state.agents.map(agent => agent.turnId))
    for (const id of registered.current) if (!turns.has(id)) registered.current.delete(id)
  }, [state.agents, props.runtimeId, props.onRegister])
  useEffect(() => {
    for (const surface of state.surfaces) {
      if (surface.runtimeId !== props.runtimeId) continue
      const descriptor = pages.find(page => page.id === surface.page.id)
      const agent = state.agents.find(agent => agent.runtimeId === surface.runtimeId && agent.page.id === surface.page.id)
      if (!descriptor || (agent && !!surface.turnId !== (agent.view === 'agent'))) continue
      if (descriptor.url !== surface.page.url || descriptor.title !== surface.page.title || descriptor.workspaceFile !== surface.page.workspaceFile) {
        props.onUpdate({ ...descriptor, ...surface.page, kind: 'browser' })
      }
    }
  }, [state.surfaces, state.agents, props.runtimeId, props.onUpdate, serializedView])
  const fail = (error: unknown) => feedback('error', String(error), true)
  return <>
    <div ref={anchor} aria-hidden style={{ position: 'absolute', inset: '44px 0 0', pointerEvents: 'none' }} />
    {createPortal(state.surfaces.map(surface => {
      const agent = state.agents.find(agent => agent.runtimeId === surface.runtimeId && agent.page.id === surface.page.id)
      const shown = state.visibleId === surface.id && props.active && props.runtimeId === surface.runtimeId
      const descriptor = pages.find(page => page.id === surface.page.id)
      const page = { kind: 'browser' as const, ...surface.page, ...(shown ? { referenceRequest: descriptor?.referenceRequest } : {}) }
      // 负层级或全透明会被 Chromium 剔除合成；保留不可交互的极低透明度表面供后台截图。
      return <div key={surface.id} aria-hidden={!shown} inert={!shown}
        style={shown ? { position: 'fixed', ...bounds, display: 'flex', zIndex: props.fullscreen ? 50 : 20, overflow: 'hidden' }
          : { position: 'fixed', left: 0, top: 0, width: 1280, height: 849, display: surface.turnId ? 'flex' : 'none', zIndex: 0, opacity: 0.001, pointerEvents: 'none' }}>
        <BrowserPanel page={page} active={shown} lease={surface} navigationRevision={surface.navigation} agent={!!surface.turnId}
          runtimeId={surface.runtimeId} canReference={shown && props.canReference} referenceDrafts={props.referenceDrafts}
          onReference={(image, replaceId) => props.onReference(surface.runtimeId, image, replaceId)}
          onChange={updated => {
            if (updated.url !== surface.page.url || updated.title !== surface.page.title) {
              void browserAction({ type: 'update', id: surface.id, url: updated.url, title: updated.title }).catch(fail)
            }
            if (shown) props.onUpdate(updated)
          }}
          onOpen={url => props.onOpen({ kind: 'browser', id: crypto.randomUUID(), url, title: '', workspaceFile: surface.page.workspaceFile && url.startsWith('file:') })}
          onClose={() => props.onClose(rightPanelTabId(page))}
          onNavigate={address => guardBrowserAction(surface.runtimeId, surface.page.id, () => props.onOpen({ ...page, url: address, referenceRequest: undefined }))}
          switchView={agent ? () => { void browserAction({ type: 'switch', runtimeId: surface.runtimeId, view: surface.turnId ? 'user' : 'agent' }).catch(fail) } : undefined}
        />
      </div>
    }), document.body)}
    <AlertDialog.Root open={!!confirmation} onOpenChange={open => { if (!open) dismissBrowserConfirmation() }}>
      <AlertDialog.Portal><AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
        <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 p-5 outline-none">
          <AlertDialog.Title className="text-base font-medium">停止 Agent 网页操作？</AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-sm text-[var(--wc-muted)]">此操作会关闭 Agent 当前网页，已经完成的网页操作不会撤销。</AlertDialog.Description>
          <p className="mt-2 text-xs text-[var(--wc-faint)]">切换回“我的网页”后再关闭，不会停止 Agent 操作。</p>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className="wc-focus-ring rounded-lg px-3 py-2 text-sm">取消</AlertDialog.Cancel>
            <button className="wc-focus-ring rounded-lg bg-[var(--wc-ink)] px-3 py-2 text-sm text-[var(--wc-surface)]" onClick={() => {
              if (!confirmation) return
              const pending = confirmation
              void browserAction({ type: 'stop', runtimeId: pending.runtimeId }).then(() => {
                completeBrowserConfirmation(pending)
              }, fail)
            }}>停止并继续</button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </>
}
