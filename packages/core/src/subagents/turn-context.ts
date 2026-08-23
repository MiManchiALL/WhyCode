import type { ModelMessage } from 'ai'
import type { SubagentTurnState } from './types.ts'

export function createSubagentTurnStateMessage(state: SubagentTurnState): ModelMessage | null {
  if (state.activations.length === 0) return null
  const terminal = state.activations.filter((activation) => activation.outcome !== undefined).length
  const delivered = state.activations.filter(
    (activation) => activation.settlement === 'delivered',
  ).length
  const payload = {
    parent_turn_id: state.parentTurnId,
    total: state.activations.length,
    terminal,
    delivered,
    remaining: state.activations.length - delivered,
    activations: state.activations.map((activation) => ({
      subagent_id: activation.subagentId,
      activation_id: activation.activationId,
      name: activation.name,
      sequence: activation.sequence,
      status: activation.outcome ?? 'running',
      ...(activation.settlement ? { settlement: activation.settlement } : {}),
    })),
  }
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      '<whycode-subagent-turn-state version="1">',
      serializePayload(payload),
      '这是 WhyCode 生成的当前父 turn 状态，不是用户输入。终态结果由独立 settlement 消息交付。remaining 大于 0 时，把已到结果作为阶段进展，继续不重叠工作；若无事可做则等待，不要给出最终结论。remaining 为 0 后再综合本 turn 的全部结果并完成。',
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
