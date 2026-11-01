import { createRoot } from 'react-dom/client'
import { scrollbars } from '../scrollbars.ts'
import { attachTerminal, disposeTerminalView } from '../terminal-view.ts'
import { renderMermaid } from '../mermaid-rendering.ts'
import { FadedScrollArea } from '../faded-scroll-area.tsx'
import '../styles.css'

const root = createRoot(document.getElementById('root')!)
function Scroller({ id }: { id: string }) {
  return <div style={{ width: 240 }}><FadedScrollArea id={id} className="wc-scrollbar h-40 w-60 overflow-auto bg-white">
    <div style={{ width: 600, height: 600, padding: 16 }}>上下及左右滚动</div>
  </FadedScrollArea></div>
}
root.render(<div style={{ display: 'flex', gap: 30, padding: 30 }}>
  <div className="wc-conversation-content"><Scroller id="inline" /></div>
  <Scroller id="panel" />
</div>)
Object.assign(window, { fixture: { scrollbars, attachTerminal, disposeTerminalView, renderMermaid } })
