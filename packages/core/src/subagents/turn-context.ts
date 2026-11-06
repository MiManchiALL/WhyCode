import type { ModelMessage } from 'ai'
import type { SubagentTurnState } from './types.ts'

export function createSubagentTurnStateMessage(state: SubagentTurnState): ModelMessage | null {
  if (state.activations.length === 0) return null
  const remaining = state.activations.filter((activation) => activation.settlement !== 'delivered')
  const payload = {
    remaining: remaining.length,
    subagents: remaining.map((activation) => ({
      subagent_id: activation.subagentId,
      description: activation.description,
      status: activation.outcome ? 'awaiting_delivery' : 'running',
    })),
  }
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      '<whycode-subagent-turn-state version="2">',
      serializePayload(payload),
      '这是当前回合尚未交付的子代理状态，不是用户输入。remaining 大于 0 时仍需等待结果交付；remaining 为 0 只表示子代理等待条件已满足，任务本身完成后才能最终答复。',
      '</whycode-subagent-turn-state>',
      '</system-reminder>',
    ].join('\n'),
  }
}

export function hasOutstandingSubagentActivations(state: SubagentTurnState | null): boolean {
  return Boolean(state?.activations.some(
    (activation) => activation.settlement !== 'delivered',
  ))
}

function serializePayload(payload: object): string {
  return JSON.stringify(payload)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
}
