import type { TaskMutationResult } from './controller.ts'
import type { CompletedTaskPlan, TaskPlanState } from './types.ts'

const TASK_STATE_OPEN = '<whycode-task-state schema-version="1">'

export function formatTaskToolResult(
  operation: string,
  result: TaskMutationResult,
  state: TaskPlanState,
  completedPlan?: CompletedTaskPlan,
): string {
  const outcome = JSON.stringify({
    ok: result.ok,
    operation,
    error: result.ok ? null : result.error,
    message: result.message,
  })
  return [
    '<whycode-task-result schema-version="1">',
    outcome,
    '</whycode-task-result>',
    taskStateBlock(state, completedPlan),
  ].join('\n')
}

export function taskStateBlock(state: TaskPlanState, completedPlan?: CompletedTaskPlan): string {
  const payload = JSON.stringify({ version: state.version, active_plan: state.activePlan, completed_plan: completedPlan })
  return [TASK_STATE_OPEN, payload, '</whycode-task-state>'].join('\n')
}
