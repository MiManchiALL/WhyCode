import { randomUUID } from 'node:crypto'
import {
  unicodeSafePrefix,
  boundedSubagentResult,
  type StopReason,
  type SubagentActivation,
  type SubagentContinueRequest,
  type SubagentListEntry,
  type SubagentLaunchRequest,
  type SubagentManifest,
  type SubagentOutcome,
  type SubagentSettlementNotification,
  type SubagentSummary,
  type ViewEvent,
} from '@whycode/core'

export function createSubagentActivation(
  request: SubagentLaunchRequest | SubagentContinueRequest,
  sequence: number,
  startedAt: string,
  promptPreviewLimit: number,
): SubagentActivation {
  return {
    id: randomUUID(),
    sequence,
    parentTurnId: request.parentTurnId,
    parentToolCallId: request.parentToolCallId,
    promptPreview: unicodeSafePrefix(request.prompt, promptPreviewLimit),
    ...(request.engagedPlanId ? { engagedPlanId: request.engagedPlanId } : {}),
    startedAt,
  }
}

export function completeSubagentManifest(
  manifest: SubagentManifest,
  activationId: string,
  outcome: SubagentOutcome,
  resultText: string,
): SubagentManifest {
  const index = manifest.activations.findIndex((item) => item.id === activationId)
  if (index < 0) throw new Error('子代理激活不存在')
  const endedAt = new Date().toISOString()
  const activations = [...manifest.activations]
  activations[index] = {
    ...activations[index]!,
    endedAt,
    outcome,
    resultText: boundedSubagentResult(resultText, outcome),
    settlement: 'pending',
  }
  return { ...manifest, updatedAt: endedAt, activations }
}

export function markSubagentSettlementDelivered(
  manifest: SubagentManifest,
  activationId: string,
  turnId: string,
): SubagentManifest {
  const index = manifest.activations.findIndex((item) => item.id === activationId)
  const activation = manifest.activations[index]
  if (!activation || activation.deliveredToTurnId === turnId) return manifest
  const activations = [...manifest.activations]
  activations[index] = { ...activation, settlement: 'delivered', deliveredToTurnId: turnId }
  return { ...manifest, activations }
}

export function subagentSettlement(
  manifest: SubagentManifest,
  activation: SubagentActivation,
): SubagentSettlementNotification {
  if (!activation.outcome || activation.resultText === undefined) {
    throw new Error('运行中的子代理不能生成终态通知')
  }
  return {
    parentSessionId: manifest.parentSessionId,
    parentTurnId: activation.parentTurnId,
    subagentId: manifest.id,
    activationId: activation.id,
    description: manifest.taskDescription,
    outcome: activation.outcome,
    resultText: activation.resultText,
    ...(activation.engagedPlanId ? { engagedPlanId: activation.engagedPlanId } : {}),
  }
}

export function subagentSummary(manifest: SubagentManifest): SubagentSummary {
  const activation = manifest.activations.at(-1)!
  return {
    id: manifest.id,
    parentSessionId: manifest.parentSessionId,
    name: manifest.definition.name,
    description: manifest.taskDescription,
    profile: manifest.definition.profile,
    status: activation.outcome ?? 'running',
    activationCount: manifest.activations.length,
    completedDurationMs: manifest.activations.reduce(
      (total, item) => total + completedSubagentActivationDurationMs(item),
      0,
    ),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    startedAt: activation.startedAt,
    ...(activation.endedAt ? { endedAt: activation.endedAt } : {}),
  }
}

export function completedSubagentActivationDurationMs(
  activation: SubagentActivation,
): number {
  if (!activation.endedAt) return 0
  return Math.max(0, Date.parse(activation.endedAt) - Date.parse(activation.startedAt))
}

export function subagentListEntry(manifest: SubagentManifest): SubagentListEntry {
  const activation = manifest.activations.at(-1)!
  return {
    subagentId: manifest.id,
    description: manifest.taskDescription,
    status: activation.outcome ?? 'running',
  }
}

export function subagentOutcome(
  stopReason: StopReason,
  finishReason: string | null,
): SubagentOutcome {
  if (stopReason === 'aborted') return 'aborted'
  if (stopReason === 'error') return 'error'
  if (stopReason === 'paused' || finishReason === 'length') {
    return 'limit'
  }
  if (finishReason === 'content-filter') return 'refusal'
  if (stopReason !== 'completed') {
    throw new Error(`子代理返回了不适用的停止原因：${stopReason}`)
  }
  return 'completed'
}

export function subagentFallbackResult(outcome: SubagentOutcome): string {
  switch (outcome) {
    case 'completed': return '子代理已完成，但没有返回可交付正文。'
    case 'aborted': return '子代理已取消。'
    case 'limit': return '子代理触发循环保护或模型输出上限，尚未形成完整结论。'
    case 'refusal': return '子代理请求被模型安全策略拒绝。'
    case 'error': return '子代理运行失败，且没有返回更多错误信息。'
  }
}

export function subagentResult(outcome: SubagentOutcome, text: string, error?: string): string {
  const body = text.trim()
  if (!body) return error || subagentFallbackResult(outcome)
  return [body, ...(outcome === 'completed' ? [] : ['[输出中断，以上内容尚未完成。]']),
    ...(error ? [error] : [])].join('\n\n')
}

/** 只读取本次激活已经落盘的正文；不能拿上一轮结果代替本轮未完成输出。 */
export function interruptedSubagentText(events: readonly ViewEvent[], activationId: string): string {
  const start = events.findIndex(event => event.type === 'user-message' && event.inputId === activationId)
  if (start < 0) return ''
  let latest = ''
  let blocks: string[] = []
  for (let index = start + 1; index < events.length; index++) {
    const event = events[index]!
    if (event.type === 'step-committed') {
      if (blocks.length) latest = blocks.join('\n\n')
      blocks = []
    } else if (event.type === 'core-event' && event.event.type === 'text-delta') {
      const block = event.event.textBlock ?? 0
      blocks[block] = (blocks[block] ?? '') + event.event.text
    }
  }
  return blocks.length ? blocks.join('\n\n') : latest
}

export function subagentContinuationKey(parentSessionId: string, planId: string): string {
  return `${parentSessionId}:${planId}`
}
