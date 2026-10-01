import {
  normalizeReasoningEffortSelection,
  type AgentSession,
  type ModelEntry,
  type ProviderConfig,
  type SessionJournal,
} from '@whycode/core'
import { resolveDefaultModelId, type WhycodeConfig } from './config.ts'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { resolveModelConnection } from './model-connections.ts'

/** 校验和历史写入成功后才发布选择；冷会话不能先改模型再检查其上下文。 */
export async function selectRuntimeModel(
  runtime: DesktopSessionRuntime,
  model: ModelEntry,
  providerConfig: ProviderConfig,
  createSession: (journal: SessionJournal) => Promise<AgentSession>,
): Promise<void> {
  if (runtime.sessionInitialization) {
    const error = await runtime.sessionInitialization
    if (error) throw new Error(error)
  }
  if (runtime.session) {
    await runtime.session.setModelSelection(model, providerConfig, 'default')
  } else if (runtime.journal) {
    const journal = runtime.journal
    const pending = (async () => {
      const session = await createSession(journal)
      try {
        if (runtime.modelId !== model.id) await session.assertModelContextCapacity(model)
        await journal.updateModelSelection(model.id, 'default')
        runtime.session = session
      } catch (error) {
        await session.dispose().catch(() => {})
        throw error
      }
      runtime.modelId = model.id
      runtime.reasoningEffort = 'default'
      await session.initializeContextUsage()
      return null
    })()
    runtime.sessionInitialization = pending
    try {
      await pending
    } finally {
      if (runtime.sessionInitialization === pending) {
        runtime.sessionInitialization = null
        runtime.notifyStateChanged()
      }
    }
    return
  }
  runtime.modelId = model.id
  runtime.reasoningEffort = 'default'
}

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
