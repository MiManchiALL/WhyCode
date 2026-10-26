import { createRoot } from 'react-dom/client'
import type { ContextUsageInfo } from '@whycode/core/events'
import { ContextUsageMeter } from '../context-usage-meter.tsx'
import '../styles.css'

const root = createRoot(document.getElementById('root')!)

export function mount(mode: 'append' | 'replace' | null = 'append') {
  const usage: ContextUsageInfo = {
    usedTokens: 24_000, contextWindow: 200_000, autoCompactThreshold: 160_000,
    breakdown: { systemPromptTokens: mode === 'replace' ? 1_000 : 5_000, toolTokens: 4_000, messageTokens: 15_000 },
    details: {
      system: { builtIn: mode === 'replace' ? 0 : 4_000, custom: 1_000, mode: mode ?? 'off' },
      tools: { builtIn: mode === 'replace' ? 4_000 : 3_000, mcp: mode === 'replace' ? 0 : 1_000 },
      messages: { agents: 1_200, subagents: 600, skills: 1_500, context: 11_700 },
    },
  }
  root.render(<main>
    <button type="button" id="outside" style={{ margin: 24 }}>外部按钮</button>
    <div style={{ position: 'absolute', right: 64, bottom: 48 }}>
      <ContextUsageMeter usage={mode === null ? null : usage} />
    </div>
  </main>)
}
