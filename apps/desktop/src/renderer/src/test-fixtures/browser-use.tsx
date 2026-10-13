import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserSurfaces } from '../browser-surfaces.tsx'
import { ConversationFeedbackContext } from '../conversation-feedback.tsx'
import { guardBrowserAction, routeBrowserPage } from '../browser-host-state.ts'
import { closeRightPanelTab, openRightPanelPage, updateRightPanelPage, type RightPanelPage, type RightPanelSessionState } from '../right-panel-state.ts'
import '../styles.css'

const blank: RightPanelSessionState = { open: false, tabs: [], activeTabId: null, inspectorView: 'plan' }
const feedback = (_tone: unknown, message: string) => { (window as any).lastFeedback = message }
function Fixture() {
  const [runtimeId, setRuntimeId] = useState('alpha')
  const [state, setState] = useState(blank)
  const [width, setWidth] = useState(420)
  const open = (page: RightPanelPage) => {
    if (page.kind === 'browser') page = routeBrowserPage(runtimeId, page, message => feedback('error', message))
    setState(current => openRightPanelPage(current, page))
  }
  const close = (id: string) => {
    const page = state.tabs.find(tab => tab.id === id)?.page
    const proceed = () => setState(current => closeRightPanelTab(current, id))
    if (page?.kind === 'browser') guardBrowserAction(runtimeId, page.id, proceed)
    else proceed()
  }
  ;(window as any).fixture = {
    open: (url: string) => open({ kind: 'browser', id: crypto.randomUUID(), url, title: '' }),
    file: () => open({ kind: 'file', path: 'fixture.html', name: 'fixture.html', source: { kind: 'current' } }),
    reference: (url: string) => open({ kind: 'browser', id: crypto.randomUUID(), url, title: '', referenceRequest: { kind: 'new' } }),
    session: (id: string) => { setRuntimeId(id); setState(blank) },
    visible: (value: boolean) => setState(current => ({ ...current, open: value })),
    close: () => close(state.activeTabId!), state: () => state,
    narrow: () => setWidth(300),
  }
  return <ConversationFeedbackContext value={feedback}>
    <div style={{ position: 'relative', width, height: 700, marginLeft: 100 }}>
      <BrowserSurfaces runtimeId={runtimeId} active={state.open} state={state} canReference referenceDrafts={[]}
        onReference={() => true} onUpdate={page => setState(current => updateRightPanelPage(current, page))}
        onRegister={page => setState(current => {
          if (current.tabs.some(tab => tab.page.kind === 'browser' && tab.page.id === page.id)) return current
          return { ...openRightPanelPage(current, page), open: current.open, activeTabId: current.activeTabId ?? `browser:${page.id}` }
        })} onOpen={open} onClose={close} />
    </div>
  </ConversationFeedbackContext>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
