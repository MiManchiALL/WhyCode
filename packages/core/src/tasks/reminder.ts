import type { ModelMessage } from 'ai'
import { userTurn } from '../context/user-turn.ts'
import { isCompactApplicationContextMessage } from '../prompts/compact.ts'
import type { ActiveTaskPlan } from './types.ts'
import { taskItemNumber } from './context.ts'
import { TASK_PLAN_TOOL_NAME } from './tools.ts'

const REMINDER_STEPS = 10
const PROGRESS_OPEN = '<whycode-task-progress version="1">'

export function isTaskProgressReminder(message: ModelMessage): boolean {
  return message.role === 'user' && !userTurn(message) && typeof message.content === 'string'
    && message.content.startsWith('<system-reminder>\n' + PROGRESS_OPEN + '\n')
}

/** 从已提交的请求历史计数，跨回合、重启和回滚沿用同一提醒间隔。 */
export function taskProgressReminder(messages: readonly ModelMessage[], plan: ActiveTaskPlan | null): ModelMessage | null {
  if (!plan) return null
  let steps = 0
  for (let i = messages.length - 1; i >= 0 && steps < REMINDER_STEPS; i--) {
    const message = messages[i]!
    if (message.role === 'assistant') {
      steps++
    } else if (isTaskProgressReminder(message) || (isCompactApplicationContextMessage(message) && !userTurn(message))) {
      return null
    } else if (message.role === 'tool' && message.content.some(part =>
      part.type === 'tool-result' && part.toolName === TASK_PLAN_TOOL_NAME && part.output.type === 'text'
    )) {
      return null
    }
  }

  return {
    role: 'user',
    content: [
      '<system-reminder>', PROGRESS_OPEN,
      JSON.stringify({ goal: plan.goal, items: plan.items.map(({ status, outcome }, index) =>
        ({ id: taskItemNumber(index), status, outcome })) }),
      '</whycode-task-progress>',
      '这是当前任务计划，仅作进度参考。请结合最新上下文关注任务进展，并在有实际进展时适时更新。',
      '</system-reminder>',
    ].join('\n'),
  }
}
