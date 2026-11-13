import type { ModelMessage } from 'ai'
import type { TaskPlanState } from './types.ts'

const TASK_STATE_OPEN = '<whycode-task-state schema-version="1">'

export function formatTaskToolResult(
  operation: string,
  result: { ok: boolean; message: string; error?: string },
  state: TaskPlanState,
): string {
  const outcome = JSON.stringify({
    ok: result.ok,
    operation,
    error: result.ok ? null : result.error ?? 'task_operation_failed',
    message: result.message,
  })
  return [
    '<whycode-task-result schema-version="1">',
    outcome,
    '</whycode-task-result>',
    taskStateBlock(state),
  ].join('\n')
}

export function taskStateBlock(state: TaskPlanState): string {
  const payload = JSON.stringify({ version: state.version, active_plan: state.activePlan })
  return [TASK_STATE_OPEN, payload, '</whycode-task-state>'].join('\n')
}

export function createTaskStateMessage(state: TaskPlanState): ModelMessage {
  return { role: 'user', content: ['<system-reminder>', taskStateBlock(state), '</system-reminder>'].join('\n') }
}
