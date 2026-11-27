import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { BackgroundTaskSummary } from '@whycode/core/background-command'
import { TaskHeader } from '../task-header.tsx'
import { ConversationPresentationCache } from '../conversation-presentation.ts'
import '../styles.css'

const root = createRoot(document.getElementById('root')!)
const cache = new ConversationPresentationCache()
export const stopCalls: string[] = []

export function show(sessionId: string, statuses: Record<string, BackgroundTaskSummary['status']>) {
  const tasks = Object.entries(statuses).map(([id, status]): BackgroundTaskSummary => ({
    id, status, sessionId, label: id, kind: 'command', startedAt: new Date(0).toISOString(), wakeOnCompletion: false,
  }))
  flushSync(() => root.render(<TaskHeader
    sessionId={sessionId} title={sessionId} projectDir={null} workspaceMode="local"
    backgroundTasks={tasks} presentationCache={cache} rightPanelOpen={false}
    onStopBackgroundTask={async task => { stopCalls.push(task.id) }}
    onRename={async () => true} onOpenWorkspaceFolder={() => {}} onToggleRightPanel={() => {}}
  />))
}
