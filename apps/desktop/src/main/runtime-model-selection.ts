import { normalizeReasoningEffortSelection } from '@whycode/core'
import { resolveDefaultModelId, type WhycodeConfig } from './config.ts'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { resolveModelConnection } from './model-connections.ts'

/** 连接配置只能更新凭据与能力；已有会话的模型身份由用户决定。 */
export async function synchronizeRuntimeModelSelection(
  runtime: DesktopSessionRuntime,
  config: WhycodeConfig,
  preferredModelId: string | null,
): Promise<void> {
  const modelId = runtime.sessionId
    ? runtime.modelId
    : resolveDefaultModelId(config, runtime.modelId ?? preferredModelId)
  if (modelId !== runtime.modelId) runtime.reasoningEffort = 'default'
  runtime.modelId = modelId
  if (!modelId) return
  const resolved = resolveModelConnection(config, modelId)
  if (!resolved.ok) return
  const reasoningEffort = normalizeReasoningEffortSelection(
    resolved.value.entry.capabilities,
    runtime.reasoningEffort,
  )
  await runtime.session?.setModelSelection(resolved.value.entry, resolved.value.providerConfig, reasoningEffort)
  runtime.reasoningEffort = reasoningEffort
}
