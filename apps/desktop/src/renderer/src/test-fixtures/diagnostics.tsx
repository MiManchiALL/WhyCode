import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DiagnosticSettings } from '../diagnostic-settings.tsx'
import { ConversationFeedbackContext } from '../conversation-feedback.tsx'
import { installRendererDiagnostics, rendererErrorHandlers } from '../renderer-diagnostics.ts'
import '../styles.css'

declare global {
  interface Window {
    diagnosticFixture: { visible: (value: boolean) => void; crash: () => void }
  }
}

function Fixture() {
  const [visible, setVisible] = useState(true)
  const [crash, setCrash] = useState(false)
  window.diagnosticFixture = { visible: setVisible, crash: () => setCrash(true) }
  if (crash) throw new Error('react-diagnostic-fixture')
  return <ConversationFeedbackContext.Provider value={(_tone, message) => {
    document.getElementById('feedback')!.textContent = message
  }}>
    <div style={{ padding: 24 }}>{visible && <DiagnosticSettings />}</div>
  </ConversationFeedbackContext.Provider>
}

installRendererDiagnostics()
createRoot(document.getElementById('root')!, rendererErrorHandlers).render(<Fixture />)
