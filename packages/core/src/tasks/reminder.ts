import type { ModelMessage } from 'ai'
import { userTurn } from '../context/user-turn.ts'
import { isCompactApplicationContextMessage } from '../prompts/compact.ts'
import type { ActiveTaskPlan } from './types.ts'
import { CREATE_TASK_PLAN_TOOL_NAME, UPDATE_TASK_ITEM_TOOL_NAME } from './tools.ts'

const REMINDER_STEPS = 10
const PROGRESS_OPEN = '<whycode-task-progress version="1">'

export function isTaskProgressReminder(message: ModelMessage): boolean {
  return message.role === 'user' && !userTurn(message) && typeof message.content === 'string'
    && message.content.startsWith('<system-reminder>\n' + PROGRESS_OPEN + '\n')
}

/** 从已提交的请求历史计数，跨回合、重启和回滚沿用同一提醒间隔。 */
export function taskProgressReminder(messages: readonly ModelMessage[], plan: ActiveTaskPlan | null): ModelMessage | null {
  if (!plan || plan.items.every(item => item.status === 'completed')) return null
  let steps = 0
  for (let i = messages.length - 1; i >= 0 && steps < REMINDER_STEPS; i--) {
    const message = messages[i]!
    if (message.role === 'assistant') {
      steps++
    } else if (isTaskProgressReminder(message) || (isCompactApplicationContextMessage(message) && !userTurn(message))) {
      return null
    } else if (message.role === 'tool' && message.content.some(part =>
      part.type === 'tool-result' && part.output.type === 'text'
      && (part.toolName === CREATE_TASK_PLAN_TOOL_NAME || part.toolName === UPDATE_TASK_ITEM_TOOL_NAME)
    )) {
      return null
    }
  }

  return {
    role: 'user',
    content: [
      '<system-reminder>', PROGRESS_OPEN,
      JSON.stringify({ goal: plan.goal, items: plan.items.map(({ id, status, outcome }) => ({ id, status, outcome })) }),
      '</whycode-task-progress>',
      '这是当前任务计划。结合最新用户要求，有实际进展时再更新。',
      '</system-reminder>',
    ].join('\n'),
  }
}
