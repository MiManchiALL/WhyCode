import {
  getModelEntry,
  MODEL_REGISTRY,
  type BuiltInProviderId,
  type McpSecretHeader,
} from '@whycode/core'
import type { PermissionMode } from '@whycode/core/permissions'
import type {
  TavilySearchDepth,
  WebSearchProviderId,
} from '../shared/settings.ts'
import { isCliProxyRoute } from './cli-proxy-models.ts'
import type { McpOAuthSession } from './mcp-oauth-state.ts'

const CLI_PROXY_MODEL_PREFIX = 'cliproxyapi:'

export interface ProviderConnectionConfig {
  apiKey: string
  baseURL?: string
}

export interface ConsensusAgentConfig {
  modelId: string
}

export interface WebSearchProviderConfig {
  apiKey: string
}

export interface TavilyWebSearchProviderConfig extends WebSearchProviderConfig {
  searchDepth?: TavilySearchDepth
}

export interface WebSearchConfig {
  activeProvider?: WebSearchProviderId
  perplexity?: WebSearchProviderConfig
  tavily?: TavilyWebSearchProviderConfig
}

export interface CliProxyApiConfig {
  apiKey: string
  baseURL: string
  /** 用户明确启用的 WhyCode 模型画像。 */
  modelIds: string[]
  /** 当前实例公布且经兼容目录确认的全部路由，与用户是否启用无关。 */
  modelRoutes: Record<string, string>
}

export interface AuxiliaryModelsConfig {
  /** 仅供不具备原生图片输入能力的主模型调用。 */
  visionModelId: string
}

export interface WhycodeConfig {
  providers: Partial<Record<BuiltInProviderId, ProviderConnectionConfig>>
  defaultModel?: string
  /** 全部已加载、新建与恢复会话共享的权限档位；具体审批结果仍只在各会话内存中。 */
  permissionMode?: PermissionMode
  /** 只用于给已退役会话显示其原型号；不参与模型解析。 */
  retiredModelLabels?: Record<string, string>
  cliProxyApi?: CliProxyApiConfig
  auxiliaryModels?: AuxiliaryModelsConfig
  consensusAgents?: Partial<Record<'B' | 'C', ConsensusAgentConfig>>
  webSearch?: WebSearchConfig
  /** MCP 结构仍在 mcp.json；这里只保存经 safeStorage 加密的全局 HTTP header 密钥。 */
  mcpSecretHeaders?: McpSecretHeader[]
  /** OAuth 客户端注册信息与令牌整体加密，并按服务器名称和 URL 指纹绑定。 */
  mcpOAuthSessions?: McpOAuthSession[]
}

export {
  getConfigPath,
  loadConfig,
  migrateLegacyConfig,
  saveConfig,
  type ConfigSecretCodec,
} from './config-storage.ts'

/** 配置指定的可用模型优先，否则按内置目录顺序回退。 */
export function resolveDefaultModelId(config: WhycodeConfig | null): string | null {
  if (config?.defaultModel && hasConfiguredKey(config, config.defaultModel)) {
    return config.defaultModel
  }
  const builtIn = MODEL_REGISTRY.find((model) => hasConfiguredKey(config, model.id))?.id
  if (builtIn) return builtIn
  const cliProxyBaseId = config?.cliProxyApi?.modelIds.find((modelId) =>
    hasConfiguredKey(config, cliProxyModelId(modelId)))
  return cliProxyBaseId ? cliProxyModelId(cliProxyBaseId) : null
}

export function cliProxyModelId(modelId: string): string {
  return `${CLI_PROXY_MODEL_PREFIX}${modelId}`
}

export function parseCliProxyModelId(modelId: string): string | null {
  if (!modelId.startsWith(CLI_PROXY_MODEL_PREFIX)) return null
  const baseModelId = modelId.slice(CLI_PROXY_MODEL_PREFIX.length)
  return baseModelId ? baseModelId : null
}

/** 旧配置默认保持 Perplexity；活动项不可用时只回退到已配置的后端。 */
export function resolveWebSearchProvider(
  config: WhycodeConfig | null,
): WebSearchProviderId {
  const webSearch = config?.webSearch
  if (webSearch?.activeProvider && webSearch[webSearch.activeProvider]?.apiKey) {
    return webSearch.activeProvider
  }
  if (webSearch?.perplexity?.apiKey) return 'perplexity'
  if (webSearch?.tavily?.apiKey) return 'tavily'
  return webSearch?.activeProvider ?? 'perplexity'
}

function hasConfiguredKey(config: WhycodeConfig | null, modelId: string): boolean {
  if (!config) return false
  const cliProxyBaseId = parseCliProxyModelId(modelId)
  if (cliProxyBaseId) {
    return Boolean(
      config.cliProxyApi?.apiKey
      && config.cliProxyApi.modelIds.includes(cliProxyBaseId)
      && isCliProxyRoute(
        cliProxyBaseId,
        config.cliProxyApi.modelRoutes[cliProxyBaseId] ?? '',
      )
    )
  }
  try {
    return Boolean(config.providers[getModelEntry(modelId).provider]?.apiKey)
  } catch {
    return false
  }
}
