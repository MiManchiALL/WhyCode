import type { WhycodeConfig } from './config.ts'

/**
 * 退役名称只服务于“最后仍选择该型号”的历史会话；不为已切换或已删除的会话保留孤儿状态。
 */
export function retainReferencedRetiredModelLabels(
  config: WhycodeConfig,
  referencedModelIds: ReadonlySet<string>,
): WhycodeConfig {
  const labels = config.retiredModelLabels
  if (!labels) return config

  const retained = Object.fromEntries(
    Object.entries(labels).filter(([modelId]) => referencedModelIds.has(modelId)),
  )
  if (Object.keys(retained).length === Object.keys(labels).length) return config

  const next = { ...config }
  if (Object.keys(retained).length > 0) next.retiredModelLabels = retained
  else delete next.retiredModelLabels
  return next
}
