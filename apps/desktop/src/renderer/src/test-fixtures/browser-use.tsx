import { StrictMode, useState, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { BrowserSurfaces } from '../browser-surfaces.tsx'
import { RightPanelTabs } from '../right-panel-tabs.tsx'
import { ConversationFeedbackContext } from '../conversation-feedback.tsx'
import { browserAction, guardBrowserAction, routeBrowserPage, useBrowserHostState } from '../browser-host-state.ts'
import { closeRightPanelTab, moveRightPanelTab, openRightPanelPage, selectRightPanelTab, updateRightPanelPage, registerBrowserPage, RightPanelSessionStore, browserReferencePage, type RightPanelPage, type RightPanelSessionState } from '../right-panel-state.ts'
import '../styles.css'

const blank: RightPanelSessionState = { open: false, tabs: [], activeTabId: null, inspectorView: 'plan' }
const feedback = (_tone: unknown, message: string) => { (window as any).lastFeedback = message }
function Fixture() {
  const [runtimeId, setRuntimeId] = useState('alpha')
  const [state, setState] = useState(blank)
  const [width, setWidth] = useState(420)
  const [height, setHeight] = useState(700)
  const host = useBrowserHostState()
  const display = state
  const store = useRef(new RightPanelSessionStore(null))
  const open = async (page: RightPanelPage) => {
    if (page.kind === 'browser') page = await routeBrowserPage(runtimeId, page)
    flushSync(() => setState(current => openRightPanelPage(current, page)))
  }
  const close = (id: string) => {
    const page = display.tabs.find(tab => tab.id === id)?.page
    const proceed = () => setState(current => closeRightPanelTab(current, id))
    if (page?.kind === 'browser') guardBrowserAction(runtimeId, page.id, 'close', proceed, error => feedback('error', String(error)))
    else proceed()
  }
  ;(window as any).fixture = {
    flush: flushSync,
    open: (url: string) => open({ kind: 'browser', id: crypto.randomUUID(), url, title: '' }),
    file: () => open({ kind: 'file', path: 'fixture.html', name: 'fixture.html', source: { kind: 'current' } }),
    reference: (url: string, id?: string) => {
      const existing = state.tabs.find(tab => tab.id === id)?.page
      return open(existing?.kind === 'browser' ? { ...existing, url, referenceRequest: { kind: 'new' } } : browserReferencePage(state, url, false, { kind: 'new' }))
    },
    session: async (id: string) => {
      if (id === runtimeId) for (const surface of host.surfaces.filter(s => s.runtimeId === id && !s.turnId)) {
        await browserAction({ type: 'stop', runtimeId: id, pageId: surface.page.id })
      }
      store.current.set(runtimeId, state); setRuntimeId(id); setState(blank)
    },
    resume: (id: string) => { store.current.set(runtimeId, state); setRuntimeId(id); setState(store.current.get(id)) },
    saved: (id: string) => store.current.get(id),
    select: (id: string) => setState(current => selectRightPanelTab(current, id)),
    closeId: close,
    visible: (value: boolean) => setState(current => ({ ...current, open: value })),
    close: () => close(display.activeTabId!), state: () => state, display: () => display,
    narrow: (value = 300) => flushSync(() => setWidth(value)),
    tall: (value: boolean) => flushSync(() => setHeight(value ? 1150 : 700)),
  }
  return <ConversationFeedbackContext value={feedback}>
    <div style={{ position: 'fixed', inset: 0, background: 'var(--wc-surface)' }} />
    <div style={{ position: 'relative', width, height, marginLeft: 100 }}>
      <div className="flex h-11 items-center border-b border-[var(--wc-line)] px-2">
        <RightPanelTabs tabs={display.tabs} activeTabId={display.activeTabId} subagents={[]} runtimeId={runtimeId} browserHost={host}
          onSelect={id => setState(current => selectRightPanelTab(current, id))} onClose={close}
          onMove={(id, targetId) => setState(current => moveRightPanelTab(current, id, targetId))}>{null}</RightPanelTabs>
      </div>
      <BrowserSurfaces runtimeId={runtimeId} sessionId={runtimeId} active={state.open} state={display} canReference referenceDrafts={[]}
        onReference={() => true} onUpdate={page => setState(current => updateRightPanelPage(current, page))}
        onRegister={(owner, _sessionId, page) => {
          if (owner === runtimeId) setState(current => registerBrowserPage(current, page))
          else store.current.set(owner, registerBrowserPage(store.current.get(owner), page))
        }} onOpen={open} onClose={close} />
    </div>
  </ConversationFeedbackContext>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
