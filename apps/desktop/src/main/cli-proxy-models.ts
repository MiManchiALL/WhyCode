import { getModelEntry, type ModelEntry } from '@whycode/core'

export type CliProxyModelCompatibility =
  | {
      profileId: string
      routeModelId: string
      unavailableReason?: never
    }
  | {
      profileId: string
      routeModelId?: never
      unavailableReason: string
    }

/**
 * CLIProxyAPI 兼容目录与厂商模型目录独立维护。
 *
 * 这里只登记已逐项核对过的 Claude、Gemini、GPT 型号。routeModelId 必须指向
 * 同一真实型号；名称相近、旧版本或用户自定义别名都不能作为等价映射。
 * 当前结论核对自 CLIProxyAPI 官方注册表 36b45d5（2026-07-22）。
 */
export const CLI_PROXY_MODEL_COMPATIBILITY: readonly CliProxyModelCompatibility[] = [
  {
    profileId: 'anthropic:claude-sonnet-4-6',
    routeModelId: 'claude-sonnet-4-6',
  },
  {
    profileId: 'google:gemini-3.1-pro-preview',
    routeModelId: 'gemini-3.1-pro-preview',
  },
  {
    profileId: 'google:gemini-3.6-flash',
    unavailableReason: 'CLIProxyAPI 当前没有 Gemini 3.6 等价路由；gemini-3-flash-agent 实际是 Gemini 3.5',
  },
  {
    profileId: 'openai:gpt-5.6-sol',
    routeModelId: 'gpt-5.6-sol',
  },
  {
    profileId: 'openai:gpt-5.6-terra',
    routeModelId: 'gpt-5.6-terra',
  },
  {
    profileId: 'openai:gpt-5.6-luna',
    routeModelId: 'gpt-5.6-luna',
  },
  {
    profileId: 'openai:gpt-5.5',
    routeModelId: 'gpt-5.5',
  },
  {
    profileId: 'openai:gpt-5.2',
    unavailableReason: 'CLIProxyAPI 当前注册表没有 GPT-5.2 等价路由',
  },
] as const

export function cliProxyModelEntries(): Array<{
  compatibility: CliProxyModelCompatibility
  entry: ModelEntry
}> {
  return CLI_PROXY_MODEL_COMPATIBILITY.map((compatibility) => ({
    compatibility,
    entry: getModelEntry(compatibility.profileId),
  }))
}

export function getCliProxyModelCompatibility(
  profileId: string,
): CliProxyModelCompatibility | null {
  return CLI_PROXY_MODEL_COMPATIBILITY.find(
    (compatibility) => compatibility.profileId === profileId,
  ) ?? null
}

export function getCliProxyRoute(profileId: string): string | null {
  return getCliProxyModelCompatibility(profileId)?.routeModelId ?? null
}
