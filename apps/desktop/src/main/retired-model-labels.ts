import { cliProxyModelId, type WhycodeConfig } from './config.ts'

// 只作为历史显示名来源；不参与模型解析，也不向活动目录提供别名。
const RETIRED_BUILTIN_LABELS: Readonly<Record<string, string>> = {
  'google:gemini-3.7-flash': 'Gemini 3.7 Flash',
  [cliProxyModelId('google:gemini-3.7-flash')]: 'Gemini 3.7 Flash（CLIProxyAPI）',
}

/**
 * 退役名称只服务于“最后仍选择该型号”的历史会话；不为已切换或已删除的会话保留孤儿状态。
 */
export function syncReferencedRetiredModelLabels(
  config: WhycodeConfig,
  referencedModelIds: ReadonlySet<string>,
): WhycodeConfig {
  const labels = config.retiredModelLabels ?? {}
  const retained = Object.fromEntries(
    Object.entries({ ...RETIRED_BUILTIN_LABELS, ...labels })
      .filter(([modelId]) => referencedModelIds.has(modelId)),
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
