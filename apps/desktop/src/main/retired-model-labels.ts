import type { WhycodeConfig } from './config.ts'
import { listModelConnections } from './model-connections.ts'

/**
 * 趁目录仍支持型号时保存原名；引用来自会话事实源，不能依赖未来发布包保留旧型号表。
 */
export function syncReferencedRetiredModelLabels(
  config: WhycodeConfig,
  referencedModelIds: ReadonlySet<string>,
): WhycodeConfig {
  const labels = config.retiredModelLabels ?? {}
  const retained = Object.fromEntries(
    [...referencedModelIds].flatMap((modelId) => {
      const savedName = Object.hasOwn(labels, modelId) ? labels[modelId] : undefined
      const name = savedName ?? listModelConnections(config, modelId)
        .find((model) => model.id === modelId && model.displayName !== modelId)?.displayName
      return name ? [[modelId, name]] : []
    }),
  )
  if (
    Object.keys(retained).length === Object.keys(labels).length
    && Object.entries(retained).every(([id, name]) => labels[id] === name)
  ) return config

  const next = { ...config }
  if (Object.keys(retained).length > 0) next.retiredModelLabels = retained
  else delete next.retiredModelLabels
  return next
}
