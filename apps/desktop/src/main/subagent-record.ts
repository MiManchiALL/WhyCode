import { randomUUID } from 'node:crypto'
import {
  unicodeSafePrefix,
  type StopReason,
  type SubagentActivation,
  type SubagentContinueRequest,
  type SubagentLaunchRequest,
  type SubagentManifest,
  type SubagentOutcome,
  type SubagentSettlementNotification,
  type SubagentSummary,
} from '@whycode/core'

const MAX_SETTLEMENT_RESULT_CHARS = 48_000

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
    resultText: unicodeSafePrefix(resultText, MAX_SETTLEMENT_RESULT_CHARS),
    settlement: 'pending',
  }
  return { ...manifest, updatedAt: endedAt, activations }
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
    name: manifest.definition.name,
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
    description: manifest.definition.description,
    profile: manifest.definition.profile,
    status: activation.outcome ?? 'running',
    activationCount: manifest.activations.length,
    currentPrompt: activation.promptPreview,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    startedAt: activation.startedAt,
    ...(activation.endedAt ? { endedAt: activation.endedAt } : {}),
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

export function subagentContinuationKey(parentSessionId: string, planId: string): string {
  return `${parentSessionId}:${planId}`
}
