import type { ModelMessage } from 'ai'
import type { TaskPlanState } from './types.ts'

const TASK_STATE_OPEN = '<whycode-task-state schema-version="1">'

export function taskStateJson(state: TaskPlanState): string {
  return JSON.stringify({
    version: state.version,
    active_plan: state.activePlan,
    resume_required: state.resumeRequired,
    interruption_reason: state.interruptionReason,
  })
}

export function formatTaskToolResult(
  operation: string,
  result: { ok: boolean; message: string; error?: string },
  state: TaskPlanState,
  engagedPlanId?: string,
): string {
  const execution = engagedPlanId
    ? `\n<whycode-task-execution engaged-plan-id="${engagedPlanId}" />`
    : ''
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
  ].join('\n') + execution
}

export function taskStateBlock(state: TaskPlanState): string {
  return [TASK_STATE_OPEN, taskStateJson(state), '</whycode-task-state>'].join('\n')
}

export function createTaskContextMessage(
  state: TaskPlanState,
  continuation?: { turnId: string; engagedPlanId: string },
): ModelMessage | null {
  if (!state.activePlan) return null
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      taskContextBlock(state, continuation),
      '</system-reminder>',
    ].join('\n'),
  }
}

export function taskContextBlock(
  state: TaskPlanState,
  continuation?: { turnId: string; engagedPlanId: string },
): string {
  return [
    taskStateBlock(state),
    continuation
      ? `<whycode-task-continuation turn-id="${continuation.turnId}" engaged-plan-id="${continuation.engagedPlanId}" />`
      : null,
  ].filter((part): part is string => Boolean(part)).join('\n')
}

export function createTaskExecutionBoundaryMessage(
  mode: 'blocked' | 'dormant',
): ModelMessage {
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      `<whycode-task-execution-boundary mode="${mode}" />`,
      '</system-reminder>',
    ].join('\n'),
  }
}
