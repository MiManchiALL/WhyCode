import type { ConsensusAgentSetup } from '@whycode/core'
import type { WhycodeConfig } from './config.ts'
import { resolveModelConnection } from './model-connections.ts'

export type ConsensusAgentSetupsResult =
  | { ok: true; value: Record<'B' | 'C', ConsensusAgentSetup> }
  | { ok: false; error: string }

/** B/C 只解析统一连接 ID；凭据与协议配置始终来自模型连接事实源。 */
export function resolveConsensusAgentSetups(
  config: WhycodeConfig | null,
): ConsensusAgentSetupsResult {
  const agentB = config?.consensusAgents?.B
  const agentC = config?.consensusAgents?.C
  if (!agentB?.modelId || !agentC?.modelId) {
    return { ok: false, error: '请先在设置 → 协商模型中为评审员 B/C 选择模型' }
  }
  const resolvedB = resolveModelConnection(config, agentB.modelId)
  if (!resolvedB.ok) return { ok: false, error: `评审员 B 所选模型不可用：${resolvedB.error}` }
  const resolvedC = resolveModelConnection(config, agentC.modelId)
  if (!resolvedC.ok) return { ok: false, error: `评审员 C 所选模型不可用：${resolvedC.error}` }
  return {
    ok: true,
    value: {
      B: { model: resolvedB.value.entry, providerConfig: resolvedB.value.providerConfig },
      C: { model: resolvedC.value.entry, providerConfig: resolvedC.value.providerConfig },
    },
  }
}
