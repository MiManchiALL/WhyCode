import type { TaskItem, TaskPlan } from '@whycode/core'
import type { ToolCall } from './conversation-state.ts'

export type TaskPlanViewData = Pick<TaskPlan, 'goal' | 'items' | 'status'>

export interface TaskToolResult {
  ok: boolean
  message: string
  plan: TaskPlanViewData | null
  updatedItemIds: string[]
}

const TASK_TOOL_NAMES = new Set([
  'CreateTaskPlan', 'ResumeTaskPlan', 'UpdateTaskItem', 'CloseTaskPlan',
])

export function parseTaskToolResult(call: ToolCall): TaskToolResult | null {
  if (!TASK_TOOL_NAMES.has(call.name) || call.status === 'running' || !call.result) return null
  try {
    const result = jsonBlock(call.result, 'result')
    const state = jsonBlock(call.result, 'state')
    if (
      !record(result) || result.operation !== call.name
      || typeof result.ok !== 'boolean' || typeof result.message !== 'string'
      || !record(state) || (state.active_plan !== null && !isPlan(state.active_plan))
    ) return null
    const ok = result.ok && call.status === 'done'
    const plan = ok ? state.active_plan : null
    return {
      ok,
      message: result.message,
      plan,
      updatedItemIds: call.name === 'UpdateTaskItem' && plan
        ? updatedItemIds(call.input, plan.items)
        : [],
    }
  } catch {
    // 可见工具结果可能已被截断，不能从残缺数据拼出成功状态。
    return null
  }
}

function updatedItemIds(input: unknown, items: TaskItem[]): string[] {
  if (!record(input)) return []
  const changes = Array.isArray(input.changes) ? input.changes.filter(record) : []
  return items.filter((item) => item.id === input.item_id || changes.some((change) =>
    (change.action === 'edit' && change.item_id === item.id)
    || (change.action === 'add' && typeof change.outcome === 'string'
      && change.outcome.trim() === item.outcome
      // 新增项没有独立返回 ID，描述重复时不猜测哪一项是本次新增。
      && items.filter((candidate) => candidate.outcome === item.outcome).length === 1),
  )).map((item) => item.id)
}

function jsonBlock(result: string, tag: 'result' | 'state'): unknown {
  const match = new RegExp(
    `<whycode-task-${tag} schema-version="1">\\n([^\\n]+)\\n</whycode-task-${tag}>`,
    'u',
  ).exec(result)
  return match ? JSON.parse(match[1]!) : null
}

function isPlan(value: unknown): value is TaskPlanViewData {
  return record(value)
    && typeof value.goal === 'string'
    && value.status === 'active'
    && Array.isArray(value.items)
    && value.items.every(isItem)
}

function isItem(value: unknown): value is TaskItem {
  return record(value)
    && typeof value.id === 'string'
    && typeof value.outcome === 'string'
    && (value.kind === 'work' || value.kind === 'verification')
    && (value.status === 'pending' || value.status === 'in_progress' || value.status === 'completed')
    && Array.isArray(value.evidence)
    && value.evidence.every((entry) => typeof entry === 'string')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
