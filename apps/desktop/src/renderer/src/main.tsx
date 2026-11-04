import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import './scrollbars.ts'
import { installRendererDiagnostics, rendererErrorHandlers } from './renderer-diagnostics.ts'

installRendererDiagnostics()
createRoot(document.getElementById('root')!, rendererErrorHandlers).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
